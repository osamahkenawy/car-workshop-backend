/**
 * ═══════════════════════════════════════════════════════════════════
 *  Webhooks — Outbound webhook endpoint management + delivery logs
 * ═══════════════════════════════════════════════════════════════════
 *  Routes:
 *    GET    /api/webhooks              — list endpoints
 *    POST   /api/webhooks              — create endpoint
 *    PUT    /api/webhooks/:id          — update endpoint
 *    DELETE /api/webhooks/:id          — delete endpoint
 *    PATCH  /api/webhooks/:id/toggle   — enable / disable
 *    POST   /api/webhooks/:id/test     — send a test ping
 *    GET    /api/webhooks/deliveries   — delivery log (with filter)
 *    POST   /api/webhooks/retry/:deliveryId — retry one delivery
 * ═══════════════════════════════════════════════════════════════════
 */
import express from 'express';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// ── Available event types ─────────────────────────────────────
// NOTE: renamed from delivery vocabulary (order.*, driver.*, return.*, cod.*)
// to the work-order status enum used across the car-workshop backend:
// pending/confirmed/assigned/accepted/in_progress/ready_for_pickup/completed/cancelled.
// 'work_order.picked_up' / 'in_transit' dropped (no fit); replaced with
// 'work_order.in_progress' and 'work_order.ready_for_pickup'.
export const WEBHOOK_EVENTS = [
  'work_order.created',
  'work_order.confirmed',
  'work_order.assigned',
  'work_order.accepted',
  'work_order.in_progress',
  'work_order.ready_for_pickup',
  'work_order.completed',
  'work_order.failed',
  'work_order.cancelled',
  'mechanic.assigned',
  'mechanic.location',
  'warranty_claim.created',
  'warranty_claim.approved',
  'warranty_claim.completed',
  'warranty_claim.refunded',
  'cash_payment.settled',
];

// ── Auto-create tables if they don't exist (called once at startup) ────
async function ensureWebhookTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT NOT NULL,
      name        VARCHAR(100) NOT NULL,
      url         VARCHAR(500) NOT NULL,
      secret      VARCHAR(64)  NOT NULL,
      events      JSON         NOT NULL DEFAULT ('[]'),
      is_active   TINYINT      NOT NULL DEFAULT 1,
      headers     JSON,
      description VARCHAR(255),
      failure_count INT NOT NULL DEFAULT 0,
      last_fired_at DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id)
    )
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      workshop_id  INT    NOT NULL,
      endpoint_id  INT    NOT NULL,
      event        VARCHAR(60)   NOT NULL,
      payload      JSON          NOT NULL,
      status       ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
      http_status  SMALLINT,
      response     TEXT,
      duration_ms  INT,
      attempt      TINYINT NOT NULL DEFAULT 1,
      next_retry_at DATETIME,
      delivered_at  DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_endpoint     (endpoint_id),
      INDEX idx_workshop_evt (workshop_id, event),
      INDEX idx_status       (status)
    )
  `);
}

// Run once at startup
ensureWebhookTables().catch(() => {});

// ─────────────────────────────────────────────────────────────
// GET /api/webhooks — list endpoints
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const endpoints = await query(
      `SELECT id, name, url, events, is_active, description, failure_count, last_fired_at, created_at
       FROM webhook_endpoints WHERE workshop_id = ? ORDER BY created_at DESC`,
      [req.workshopId]
    );
    // Parse JSON events field
    const enriched = endpoints.map(e => ({
      ...e,
      events: typeof e.events === 'string' ? JSON.parse(e.events) : (e.events || []),
    }));
    return res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('[Webhooks] list error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch webhooks' });
  }
});

// GET /api/webhooks/events — available event types
router.get('/events', (_req, res) => {
  return res.json({ success: true, data: WEBHOOK_EVENTS });
});

// ─────────────────────────────────────────────────────────────
// GET /api/webhooks/deliveries — delivery log
// ─────────────────────────────────────────────────────────────
router.get('/deliveries', async (req, res) => {
  try {
    const { endpoint_id, status, event, page = 1, limit = 50 } = req.query;
    const pg  = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(100, parseInt(limit, 10) || 50);
    const offset = (pg - 1) * lim;

    let where = 'WHERE d.workshop_id = ?';
    const params = [req.workshopId];
    if (endpoint_id) { where += ' AND d.endpoint_id = ?'; params.push(endpoint_id); }
    if (status)      { where += ' AND d.status = ?';      params.push(status); }
    if (event)       { where += ' AND d.event = ?';        params.push(event); }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM webhook_deliveries d ${where}`, params
    );
    const rows = await query(
      `SELECT d.*, e.name as endpoint_name, e.url
       FROM webhook_deliveries d
       LEFT JOIN webhook_endpoints e ON d.endpoint_id = e.id
       ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    return res.json({ success: true, data: rows, total, page: pg, limit: lim });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch deliveries' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/webhooks — create endpoint
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, url, events = [], description, headers } = req.body;
    if (!name || !url) {
      return res.status(400).json({ success: false, message: 'name and url are required' });
    }
    try { new URL(url); } catch {
      return res.status(400).json({ success: false, message: 'Invalid URL format' });
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const eventsJson = JSON.stringify(Array.isArray(events) ? events : []);
    const headersJson = headers ? JSON.stringify(headers) : null;

    const result = await execute(
      `INSERT INTO webhook_endpoints (workshop_id, name, url, secret, events, description, headers)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, name.trim(), url.trim(), secret, eventsJson, description || null, headersJson]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId, name, url, secret, events } });
  } catch (err) {
    console.error('[Webhooks] create error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create webhook' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/webhooks/:id — update endpoint
// ─────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { name, url, events, description, headers } = req.body;
    if (url) {
      try { new URL(url); } catch {
        return res.status(400).json({ success: false, message: 'Invalid URL' });
      }
    }
    const [existing] = await query(
      'SELECT id FROM webhook_endpoints WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Webhook not found' });

    const updates = [];
    const vals = [];
    if (name)        { updates.push('name = ?');        vals.push(name.trim()); }
    if (url)         { updates.push('url = ?');          vals.push(url.trim()); }
    if (events)      { updates.push('events = ?');       vals.push(JSON.stringify(events)); }
    if (description !== undefined) { updates.push('description = ?'); vals.push(description); }
    if (headers !== undefined)     { updates.push('headers = ?');     vals.push(JSON.stringify(headers)); }

    if (updates.length) {
      await execute(
        `UPDATE webhook_endpoints SET ${updates.join(', ')} WHERE id = ? AND workshop_id = ?`,
        [...vals, req.params.id, req.workshopId]
      );
    }
    return res.json({ success: true, message: 'Webhook updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update webhook' });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/webhooks/:id
// ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id FROM webhook_endpoints WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Webhook not found' });
    await execute('DELETE FROM webhook_endpoints WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Webhook deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete webhook' });
  }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/webhooks/:id/toggle — enable / disable
// ─────────────────────────────────────────────────────────────
router.patch('/:id/toggle', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id, is_active FROM webhook_endpoints WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Webhook not found' });
    const newVal = existing.is_active ? 0 : 1;
    await execute('UPDATE webhook_endpoints SET is_active = ? WHERE id = ? AND workshop_id = ?', [newVal, req.params.id, req.workshopId]);
    return res.json({ success: true, is_active: newVal === 1 });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to toggle webhook' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/webhooks/:id/test — send a test ping
// ─────────────────────────────────────────────────────────────
router.post('/:id/test', async (req, res) => {
  try {
    const [endpoint] = await query(
      'SELECT * FROM webhook_endpoints WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!endpoint) return res.status(404).json({ success: false, message: 'Webhook not found' });

    const payload = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test ping from Traseallo', endpoint_id: endpoint.id },
    };

    const result = await deliverWebhook({ endpoint, event: 'webhook.test', payload, workshopId: req.workshopId });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Test delivery failed: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/webhooks/retry/:deliveryId — retry failed delivery
// ─────────────────────────────────────────────────────────────
router.post('/retry/:deliveryId', async (req, res) => {
  try {
    const [delivery] = await query(
      `SELECT d.*, e.url, e.secret, e.headers
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON d.endpoint_id = e.id
       WHERE d.id = ? AND d.workshop_id = ?`,
      [req.params.deliveryId, req.workshopId]
    );
    if (!delivery) return res.status(404).json({ success: false, message: 'Delivery not found' });

    const payload = typeof delivery.payload === 'string'
      ? JSON.parse(delivery.payload) : delivery.payload;

    const result = await deliverWebhook({
      endpoint: { url: delivery.url, secret: delivery.secret, headers: delivery.headers },
      event: delivery.event,
      payload,
      workshopId: req.workshopId,
      deliveryId: delivery.id,
      isRetry: true,
    });
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Retry failed: ' + err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  WEBHOOK DELIVERY ENGINE
//  Used internally by routes above AND by webhook-dispatcher.js
// ═════════════════════════════════════════════════════════════

/**
 * deliverWebhook  —  sends one HTTP POST to one endpoint URL
 * Computes HMAC-SHA256 signature, logs result to webhook_deliveries.
 */
export async function deliverWebhook({ endpoint, event, payload, workshopId, deliveryId, isRetry = false }) {
  const body = JSON.stringify(payload);
  const sig  = crypto.createHmac('sha256', endpoint.secret || '').update(body).digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-Traseallo-Event':     event,
    'X-Traseallo-Signature': `sha256=${sig}`,
    'X-Traseallo-Timestamp': String(Date.now()),
    'User-Agent': 'Traseallo-Webhook/1.0',
    ...((endpoint.headers && typeof endpoint.headers === 'string'
      ? JSON.parse(endpoint.headers) : (endpoint.headers || {}))),
  };

  const startTime = Date.now();
  let httpStatus = null;
  let responseText = '';
  let status = 'failed';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const resp = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    httpStatus = resp.status;
    responseText = await resp.text().catch(() => '');
    status = httpStatus >= 200 && httpStatus < 300 ? 'sent' : 'failed';
  } catch (err) {
    responseText = err.message;
    status = 'failed';
  }

  const durationMs = Date.now() - startTime;

  try {
    await ensureWebhookTables();
    if (deliveryId && isRetry) {
      await execute(
        `UPDATE webhook_deliveries
         SET status = ?, http_status = ?, response = ?, duration_ms = ?,
             attempt = attempt + 1, delivered_at = IF(? = 'sent', NOW(), NULL)
         WHERE id = ?`,
        [status, httpStatus, responseText?.slice(0, 1000), durationMs, status, deliveryId]
      );
    } else {
      await execute(
        `INSERT INTO webhook_deliveries (workshop_id, endpoint_id, event, payload, status, http_status, response, duration_ms, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, IF(? = 'sent', NOW(), NULL))`,
        [workshopId, endpoint.id || null, event, JSON.stringify(payload),
         status, httpStatus, responseText?.slice(0, 1000), durationMs, status]
      );
    }

    // Update endpoint last_fired_at + failure_count
    if (endpoint.id) {
      if (status === 'failed') {
        await execute(
          'UPDATE webhook_endpoints SET last_fired_at = NOW(), failure_count = failure_count + 1 WHERE id = ?',
          [endpoint.id]
        );
      } else {
        await execute(
          'UPDATE webhook_endpoints SET last_fired_at = NOW(), failure_count = 0 WHERE id = ?',
          [endpoint.id]
        );
      }
    }
  } catch (logErr) {
    console.error('[Webhook] Failed to log delivery:', logErr.message);
  }

  return { status, httpStatus, durationMs, response: responseText?.slice(0, 200) };
}

export default router;
