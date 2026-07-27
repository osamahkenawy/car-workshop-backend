/**
 * ═══════════════════════════════════════════════════════════════
 *  UAE VAT & e-Invoicing — SOW Section B9 req 95, Section 3 req 16-17
 *  Electronic Vehicle Health Check — SOW Section B3 req 74
 *  Group Integration events — SOW Section C req 104-105
 *
 *  UAE VAT:
 *   - 5% VAT on taxable supplies (configurable rate)
 *   - FTA e-invoicing compliance record keeping
 *   - VAT return summary (Box 1–13 style)
 *
 *  eVHC:
 *   - Guided inspection with photographic evidence
 *   - Urgent / advisory item flagging
 *   - Customer remote authorisation
 *
 *  Group Integration:
 *   - Receive rental/fleet events from Autostrad
 *   - Post repair completion & cost back
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import apiKeyAuth from '../middleware/api-key-auth.js';
const verifyApiKey = apiKeyAuth;

// ══════════════════════════════════════════════════════════════
// UAE VAT ROUTER
// ══════════════════════════════════════════════════════════════
const vatRouter = express.Router();
vatRouter.use(authMiddleware);

// GET /api/vat/transactions?from=&to=&status=
vatRouter.get('/transactions', async (req, res) => {
  try {
    const { from, to, status, reference_type, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `SELECT * FROM vat_transactions WHERE workshop_id = ?`;
    const params = [req.workshopId];
    if (from)           { sql += ' AND supply_date >= ?'; params.push(from); }
    if (to)             { sql += ' AND supply_date <= ?'; params.push(to); }
    if (status)         { sql += ' AND fta_status = ?'; params.push(status); }
    if (reference_type) { sql += ' AND reference_type = ?'; params.push(reference_type); }
    sql += ' ORDER BY supply_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);
    const rows = await query(sql, params);
    res.json({ success: true, transactions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch VAT transactions' });
  }
});

// GET /api/vat/return-summary?from=&to=
// Produces VAT return period summary (Box-style output for FTA filing)
vatRouter.get('/return-summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to dates required' });
    }

    const [summary] = await query(
      `SELECT
         COUNT(*)                    AS transaction_count,
         SUM(taxable_amount)         AS total_taxable,
         SUM(vat_amount)             AS total_vat_collected,
         SUM(total_amount)           AS total_gross,
         SUM(CASE WHEN reference_type = 'invoice'      THEN taxable_amount ELSE 0 END) AS sales_taxable,
         SUM(CASE WHEN reference_type = 'invoice'      THEN vat_amount     ELSE 0 END) AS output_vat,
         SUM(CASE WHEN reference_type = 'credit_note'  THEN taxable_amount ELSE 0 END) AS credit_note_taxable,
         SUM(CASE WHEN reference_type = 'credit_note'  THEN vat_amount     ELSE 0 END) AS credit_note_vat
       FROM vat_transactions
       WHERE workshop_id = ? AND supply_date BETWEEN ? AND ?`,
      [req.workshopId, from, to]
    );

    res.json({
      success: true,
      period: { from, to },
      summary: {
        ...summary,
        net_vat_payable: parseFloat((parseFloat(summary.output_vat || 0) - parseFloat(summary.credit_note_vat || 0)).toFixed(2)),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate VAT return summary' });
  }
});

// POST /api/vat/submit-fta — mark transactions as submitted to FTA
// (In production: integrate with FTA e-invoicing API)
vatRouter.post('/submit-fta', async (req, res) => {
  try {
    const { transaction_ids } = req.body;
    if (!Array.isArray(transaction_ids) || !transaction_ids.length) {
      return res.status(400).json({ success: false, message: 'transaction_ids array required' });
    }

    // Stub: In production, call FTA e-invoice portal API here
    const fta_submission_id = `FTA-${req.workshopId}-${Date.now()}`;

    const placeholders = transaction_ids.map(() => '?').join(',');
    await execute(
      `UPDATE vat_transactions
       SET fta_status = 'submitted', fta_submission_id = ?, fta_submitted_at = NOW()
       WHERE workshop_id = ? AND id IN (${placeholders})`,
      [fta_submission_id, req.workshopId, ...transaction_ids]
    );

    await logAudit(req.workshopId, req.userId, 'FTA_SUBMIT', 'vat_transactions', null, null,
      { fta_submission_id, count: transaction_ids.length });

    res.json({ success: true, fta_submission_id, submitted_count: transaction_ids.length });
  } catch (err) {
    console.error('POST /vat/submit-fta error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit to FTA' });
  }
});

// ══════════════════════════════════════════════════════════════
// ELECTRONIC VEHICLE HEALTH CHECK (eVHC) — req 74
// ══════════════════════════════════════════════════════════════
const evhcRouter = express.Router();
evhcRouter.use(authMiddleware);

// GET /api/evhc?work_order_id=&vehicle_id=
evhcRouter.get('/', async (req, res) => {
  try {
    const { work_order_id, vehicle_id, status } = req.query;
    let sql = `SELECT * FROM vehicle_health_checks WHERE workshop_id = ?`;
    const params = [req.workshopId];
    if (work_order_id) { sql += ' AND work_order_id = ?'; params.push(work_order_id); }
    if (vehicle_id)    { sql += ' AND vehicle_id = ?'; params.push(vehicle_id); }
    if (status)        { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const rows = await query(sql, params);
    res.json({ success: true, healthChecks: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch eVHC records' });
  }
});

// GET /api/evhc/:id
evhcRouter.get('/:id', async (req, res) => {
  try {
    const [hc] = await query(
      `SELECT hc.*, v.plate_number, v.make, v.model,
              CONCAT(m.first_name,' ',m.last_name) AS technician_name
       FROM vehicle_health_checks hc
       LEFT JOIN vehicles v ON hc.vehicle_id = v.id
       LEFT JOIN mechanics m ON hc.technician_id = m.id
       WHERE hc.id = ? AND hc.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!hc) return res.status(404).json({ success: false, message: 'Health check not found' });
    res.json({ success: true, healthCheck: hc });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch health check' });
  }
});

// POST /api/evhc — start eVHC inspection
evhcRouter.post('/', async (req, res) => {
  try {
    const { work_order_id, job_card_id, vehicle_id, technician_id, inspection_items } = req.body;
    if (!vehicle_id || !inspection_items) {
      return res.status(400).json({ success: false, message: 'vehicle_id and inspection_items required' });
    }

    // Validate inspection_items format
    // Expected: [{category, item, result: 'ok'|'advisory'|'urgent', notes, photos: []}]
    const items = Array.isArray(inspection_items) ? inspection_items : [];
    const okCount    = items.filter(i => i.result === 'ok').length;
    const score      = items.length ? Math.round((okCount / items.length) * 100) : null;

    const result = await execute(
      `INSERT INTO vehicle_health_checks
         (workshop_id, work_order_id, job_card_id, vehicle_id, technician_id,
          inspection_items, overall_score, status)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.workshopId, work_order_id || null, job_card_id || null, vehicle_id,
       technician_id || req.userId, JSON.stringify(items), score, 'in_progress']
    );

    res.status(201).json({ success: true, id: result.insertId, overall_score: score });
  } catch (err) {
    console.error('POST /evhc error:', err);
    res.status(500).json({ success: false, message: 'Failed to create health check' });
  }
});

// PUT /api/evhc/:id — update inspection items
evhcRouter.put('/:id', async (req, res) => {
  try {
    const { inspection_items } = req.body;
    const items = Array.isArray(inspection_items) ? inspection_items : [];
    const okCount = items.filter(i => i.result === 'ok').length;
    const score   = items.length ? Math.round((okCount / items.length) * 100) : null;

    await execute(
      'UPDATE vehicle_health_checks SET inspection_items = ?, overall_score = ? WHERE id = ? AND workshop_id = ?',
      [JSON.stringify(items), score, req.params.id, req.workshopId]
    );
    res.json({ success: true, overall_score: score });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update health check' });
  }
});

// PATCH /api/evhc/:id/complete — mark as completed and notify customer
evhcRouter.patch('/:id/complete', async (req, res) => {
  try {
    await execute(
      `UPDATE vehicle_health_checks SET status = 'customer_notified', customer_notified_at = NOW()
       WHERE id = ? AND workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    // In production: send SMS/email/push with health check summary link
    res.json({ success: true, message: 'Health check completed and customer notified' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to complete health check' });
  }
});

// PATCH /api/evhc/:id/customer-approve — customer approves recommended items (req 74)
evhcRouter.patch('/:id/customer-approve', async (req, res) => {
  try {
    const { approved_item_indices } = req.body; // array of indices in inspection_items
    const [hc] = await query('SELECT * FROM vehicle_health_checks WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!hc) return res.status(404).json({ success: false, message: 'Not found' });

    await execute(
      `UPDATE vehicle_health_checks SET
         approved_items = ?, customer_approved_at = NOW(), status = 'customer_approved'
       WHERE id = ?`,
      [JSON.stringify(approved_item_indices || []), req.params.id]
    );
    res.json({ success: true, message: 'Customer approvals recorded' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to record customer approval' });
  }
});

// ══════════════════════════════════════════════════════════════
// GROUP INTEGRATION — Section C, req 104-105 (Autostrad API)
// ══════════════════════════════════════════════════════════════
const groupIntegrationRouter = express.Router();

// Inbound: authenticated by API key (from Autostrad platform)
// POST /api/group-integration/inbound — receive events from Autostrad
groupIntegrationRouter.post('/inbound', verifyApiKey, async (req, res) => {
  try {
    const { event_type, external_ref, payload } = req.body;
    const VALID_EVENTS = ['rental_damaged_vehicle','maintenance_due'];
    if (!VALID_EVENTS.includes(event_type)) {
      return res.status(400).json({ success: false, message: 'Invalid event_type' });
    }

    // Determine workshop from API key (set by verifyApiKey middleware)
    const workshopId = req.workshopId;

    const result = await execute(
      `INSERT INTO group_integration_events
         (workshop_id, event_type, direction, external_system, external_ref, payload)
       VALUES (?, ?, 'inbound', 'autostrad', ?, ?)`,
      [workshopId, event_type, external_ref || null, JSON.stringify(payload || {})]
    );

    // Auto-process: create work order for inbound maintenance_due or rental_damaged
    let created_work_order_id = null;
    if (['rental_damaged_vehicle','maintenance_due'].includes(event_type) && payload) {
      try {
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
        const wo_number = `WO-${stamp}-${Math.floor(Math.random()*9000)+1000}`;

        const woResult = await execute(
          `INSERT INTO work_orders
             (workshop_id, work_order_number, customer_name, customer_phone,
              dropoff_address, service_category, notes, status, created_by)
           VALUES (?,?,?,?,?,?,?,'pending',0)`,
          [workshopId, wo_number,
           payload.fleet_entity || 'Autostrad Fleet', payload.contact_phone || null,
           payload.location || null,
           event_type === 'maintenance_due' ? 'scheduled_maintenance' : 'repair',
           `Auto-created from Autostrad integration. Ref: ${external_ref}. ${payload.notes || ''}`]
        );
        created_work_order_id = woResult.insertId;

        await execute(
          `UPDATE group_integration_events SET status = 'processed', processed_at = NOW(),
           local_ref_type = 'work_order', local_ref_id = ?
           WHERE id = ?`,
          [created_work_order_id, result.insertId]
        );
      } catch (processErr) {
        await execute(
          `UPDATE group_integration_events SET status = 'failed', error_message = ? WHERE id = ?`,
          [processErr.message, result.insertId]
        );
      }
    }

    res.json({
      success: true,
      event_id: result.insertId,
      work_order_id: created_work_order_id,
      message: 'Event received and queued for processing'
    });
  } catch (err) {
    console.error('POST /group-integration/inbound error:', err);
    res.status(500).json({ success: false, message: 'Failed to process integration event' });
  }
});

// Outbound: authenticated staff — POST completion/cost back to Autostrad
groupIntegrationRouter.post('/outbound', authMiddleware, async (req, res) => {
  try {
    const { work_order_id, event_type = 'repair_complete', external_ref, payload } = req.body;
    const VALID_OUT = ['repair_complete','cost_posted'];
    if (!VALID_OUT.includes(event_type)) {
      return res.status(400).json({ success: false, message: 'Invalid event_type for outbound' });
    }

    const result = await execute(
      `INSERT INTO group_integration_events
         (workshop_id, event_type, direction, external_system, external_ref,
          local_ref_type, local_ref_id, payload, status)
       VALUES (?,?,'outbound','autostrad',?,'work_order',?,?,'pending')`,
      [req.workshopId, event_type, external_ref || null, work_order_id || null,
       JSON.stringify(payload || {})]
    );

    // In production: call Autostrad API webhook/endpoint here
    // For now, mark as processed (stub)
    await execute(
      'UPDATE group_integration_events SET status = "processed", processed_at = NOW() WHERE id = ?',
      [result.insertId]
    );

    await logAudit(req.workshopId, req.userId, 'OUTBOUND_INTEGRATION', 'group_integration_events', result.insertId, null, { event_type, external_ref });
    res.json({ success: true, event_id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send integration event' });
  }
});

// GET /api/group-integration/events — list integration events
groupIntegrationRouter.get('/events', authMiddleware, async (req, res) => {
  try {
    const { direction, status, event_type } = req.query;
    let sql = 'SELECT * FROM group_integration_events WHERE workshop_id = ?';
    const params = [req.workshopId];
    if (direction)  { sql += ' AND direction = ?'; params.push(direction); }
    if (status)     { sql += ' AND status = ?'; params.push(status); }
    if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    const rows = await query(sql, params);
    res.json({ success: true, events: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch integration events' });
  }
});

export { vatRouter, evhcRouter, groupIntegrationRouter };
