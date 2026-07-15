/**
 * MODULE E.2 — External API (v1) Routes
 *
 * API-key-authenticated endpoints for external integrations.
 * Prefix: /api/v1/
 *
 * Mirrors a subset of internal routes but uses API key auth
 * instead of JWT + role-based access.
 */

import express from 'express';
import { query, execute } from '../lib/database.js';
import { requireApiPermission } from '../middleware/api-key-auth.js';

const router = express.Router();

// ── Helper: pick workshop-scoped rows ──────────────────────────
const workshopQ = (sql, params, req) => query(sql, [...params, req.workshopId]);

// ════════════════════════════════════════════════════════════════
//  WORK ORDERS
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/work_orders
 * List work orders with pagination and optional filters.
 * Requires: work_orders:read
 */
router.get('/work_orders', requireApiPermission('work_orders:read'), async (req, res) => {
  try {
    const { page = 1, limit = 50, status, from, to, service_status_token } = req.query;
    const offset = (Math.max(1, +page) - 1) * Math.min(200, Math.max(1, +limit));
    const lim = Math.min(200, Math.max(1, +limit));

    let where = 'o.workshop_id = ?';
    const params = [req.workshopId];

    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (from)   { where += ' AND o.created_at >= ?'; params.push(from); }
    if (to)     { where += ' AND o.created_at <= ?'; params.push(to); }
    if (service_status_token) { where += ' AND o.service_status_token = ?'; params.push(service_status_token); }

    const [[{ total }]] = [await query(`SELECT COUNT(*) as total FROM work_orders o WHERE ${where}`, params)];

    const rows = await query(
      `SELECT o.id, o.service_status_token, o.barcode, o.status, o.order_type, o.category,
              o.sender_name, o.sender_phone, o.sender_address,
              o.customer_name, o.customer_phone, o.customer_address, o.customer_area, o.customer_emirate,
              o.weight_kg, o.description, o.special_instructions,
              o.payment_method, o.cash_amount, o.service_fee, o.total_amount,
              o.scheduled_at, o.picked_up_at, o.delivered_at,
              o.created_at, o.updated_at
       FROM work_orders o
       WHERE ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    return res.json({
      success: true,
      data: rows,
      pagination: { page: +page, limit: lim, total, pages: Math.ceil(total / lim) },
    });
  } catch (err) {
    console.error('[api/v1/work_orders GET]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch work orders' });
  }
});

/**
 * GET /api/v1/work_orders/:id
 * Get single work order by ID or service_status_token.
 * Requires: work_orders:read
 */
router.get('/work_orders/:id', requireApiPermission('work_orders:read'), async (req, res) => {
  try {
    const identifier = req.params.id;
    // Support both numeric ID and service_status_token
    const isNumeric = /^\d+$/.test(identifier);
    const [workOrder] = await query(
      `SELECT o.*, c.company_name as customer_company, c.full_name as customer_full_name
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND ${isNumeric ? 'o.id = ?' : 'o.service_status_token = ?'}`,
      [req.workshopId, identifier]
    );

    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    // Load status history
    const history = await query(
      'SELECT status, note, changed_by, created_at FROM work_order_status_logs WHERE work_order_id = ? ORDER BY created_at ASC',
      [workOrder.id]
    );

    return res.json({ success: true, data: { ...workOrder, status_history: history } });
  } catch (err) {
    console.error('[api/v1/work_orders/:id GET]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch work order' });
  }
});

/**
 * POST /api/v1/work_orders
 * Create a new work order via API key.
 * Requires: work_orders:write
 */
router.post('/work_orders', requireApiPermission('work_orders:write'), async (req, res) => {
  try {
    const {
      customer_id, order_type = 'standard', category = 'maintenance',
      sender_name, sender_phone, sender_address,
      customer_name, customer_phone, customer_address, customer_area,
      customer_emirate = 'Dubai',
      weight_kg, description, special_instructions,
      payment_method = 'cash', cash_amount = 0, service_fee = 0,
      scheduled_at, items = [], notes, reference_id,
    } = req.body;

    if (!customer_name || !customer_phone || !customer_address) {
      return res.status(400).json({ success: false, message: 'customer_name, customer_phone, and customer_address are required' });
    }

    // Generate service status token and work order number
    const crypto = await import('crypto');
    const service_status_token = 'TR' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const barcode = service_status_token; // same as service status token for simplicity
    const work_order_number = 'WO-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();

    const total_amount = parseFloat(service_fee) + parseFloat(cash_amount);

    const result = await execute(
      `INSERT INTO work_orders (
        workshop_id, work_order_number, customer_id, service_status_token, barcode, order_type, category, status,
        sender_name, sender_phone, sender_address,
        customer_name, customer_phone, customer_address, customer_area, customer_emirate,
        weight_kg, description, special_instructions,
        payment_method, cash_amount, service_fee, total_amount,
        scheduled_at, notes, reference_id, created_via
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending',
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, 'api')`,
      [
        req.workshopId, work_order_number, customer_id || null, service_status_token, barcode, order_type, category,
        sender_name || null, sender_phone || null, sender_address || null,
        customer_name, customer_phone, customer_address, customer_area || null, customer_emirate,
        weight_kg || null, description || null, special_instructions || null,
        payment_method, cash_amount, service_fee, total_amount,
        scheduled_at || null, notes || null, reference_id || null,
      ]
    );

    // Insert status log
    await execute(
      `INSERT INTO work_order_status_logs (work_order_id, status, note, changed_by)
       VALUES (?, 'pending', 'Work order created via API', ?)`,
      [result.insertId, req.apiKeyName || 'API']
    );

    // Insert work order items if provided
    if (items.length > 0) {
      for (const item of items) {
        await execute(
          `INSERT INTO work_order_items (work_order_id, name, quantity, weight_kg, unit_price)
           VALUES (?, ?, ?, ?, ?)`,
          [result.insertId, item.name, item.quantity || 1, item.weight_kg || 0, item.unit_price || 0]
        );
      }
    }

    const [created] = await query('SELECT * FROM work_orders WHERE id = ?', [result.insertId]);

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        service_status_token,
        barcode,
        status: 'pending',
        ...created,
      },
      message: 'Work order created successfully',
    });
  } catch (err) {
    console.error('[api/v1/work_orders POST]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create work order', error: err.message });
  }
});

/**
 * PATCH /api/v1/work_orders/:id/cancel
 * Cancel a work order (only if status allows).
 * Requires: work_orders:write
 */
router.patch('/work_orders/:id/cancel', requireApiPermission('work_orders:write'), async (req, res) => {
  try {
    const [workOrder] = await query(
      'SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const cancellable = ['pending', 'confirmed', 'processing'];
    if (!cancellable.includes(workOrder.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel work order in '${workOrder.status}' status. Cancellable statuses: ${cancellable.join(', ')}`,
      });
    }

    await execute('UPDATE work_orders SET status = "cancelled", updated_at = NOW() WHERE id = ?', [workOrder.id]);
    await execute(
      `INSERT INTO work_order_status_logs (work_order_id, status, note, changed_by)
       VALUES (?, 'cancelled', ?, ?)`,
      [workOrder.id, req.body.reason || 'Cancelled via API', req.apiKeyName || 'API']
    );

    return res.json({ success: true, message: 'Work order cancelled' });
  } catch (err) {
    console.error('[api/v1/work_orders/:id/cancel]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to cancel work order' });
  }
});

// ════════════════════════════════════════════════════════════════
//  SERVICE STATUS
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/service-status/:token
 * Public-style service status lookup by token (scoped to workshop via API key).
 * Requires: service_status:read
 */
router.get('/service-status/:token', requireApiPermission('service_status:read'), async (req, res) => {
  try {
    const [workOrder] = await query(
      `SELECT o.id, o.service_status_token, o.barcode, o.status, o.order_type,
              o.sender_name, o.sender_address,
              o.customer_name, o.customer_phone, o.customer_address, o.customer_area, o.customer_emirate,
              o.payment_method, o.cash_amount, o.service_fee, o.total_amount,
              o.scheduled_at, o.picked_up_at, o.delivered_at,
              o.created_at
       FROM work_orders o
       WHERE o.service_status_token = ? AND o.workshop_id = ?`,
      [req.params.token, req.workshopId]
    );

    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    const history = await query(
      'SELECT status, note, changed_by, created_at FROM work_order_status_logs WHERE work_order_id = ? ORDER BY created_at ASC',
      [workOrder.id]
    );

    return res.json({ success: true, data: { ...workOrder, status_history: history } });
  } catch (err) {
    console.error('[api/v1/service-status/:token]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch service status' });
  }
});

// ════════════════════════════════════════════════════════════════
//  CUSTOMERS
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/customers
 * List workshop customers (for API integrations that need to reference customer_id).
 * Requires: customers:read
 */
router.get('/customers', requireApiPermission('customers:read'), async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, company_name, full_name, email, phone, address_line1, area, city, emirate, is_active, created_at
       FROM customers WHERE workshop_id = ? ORDER BY company_name ASC`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[api/v1/customers GET]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch customers' });
  }
});

// ════════════════════════════════════════════════════════════════
//  WEBHOOKS (list only — management still via JWT UI)
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/webhooks
 * List webhook endpoints registered for this workshop.
 * Requires: webhooks:manage
 */
router.get('/webhooks', requireApiPermission('webhooks:manage'), async (req, res) => {
  try {
    const rows = await query(
      'SELECT id, name, url, events, is_active, created_at FROM webhook_endpoints WHERE workshop_id = ? ORDER BY created_at DESC',
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch webhooks' });
  }
});

// ════════════════════════════════════════════════════════════════
//  API DOCUMENTATION ENDPOINT
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/docs
 * Returns machine-readable API documentation (no auth required on this endpoint).
 */
router.get('/docs', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}/api/v1`;
  return res.json({
    success: true,
    version: 'v1',
    base_url: baseUrl,
    authentication: {
      methods: [
        { header: 'X-API-Key', format: 'td_XXXXXXXXXXXX' },
        { header: 'Authorization', format: 'Bearer td_XXXXXXXXXXXX' },
      ],
      note: 'Generate API keys in Dashboard → Integrations',
    },
    permissions: {
      read: ['work_orders:read', 'service_status:read'],
      write: ['work_orders:read', 'work_orders:write', 'service_status:read'],
      full: [
        'work_orders:read', 'work_orders:write', 'service_status:read', 'service_status:write',
        'customers:read', 'customers:write', 'mechanics:read', 'webhooks:manage',
      ],
    },
    endpoints: [
      { method: 'GET',   path: '/work_orders',              description: 'List work orders with pagination',       permissions: ['work_orders:read'],  params: 'page, limit, status, from, to, service_status_token' },
      { method: 'GET',   path: '/work_orders/:id',           description: 'Get work order by ID or service status token', permissions: ['work_orders:read'] },
      { method: 'POST',  path: '/work_orders',              description: 'Create a new work order',                 permissions: ['work_orders:write'], body: 'customer_name*, customer_phone*, customer_address*, customer_id, order_type, category, sender_name, sender_phone, sender_address, payment_method, cash_amount, service_fee, scheduled_at, items[], notes, reference_id' },
      { method: 'PATCH', path: '/work_orders/:id/cancel',   description: 'Cancel a pending work order',             permissions: ['work_orders:write'], body: 'reason' },
      { method: 'GET',   path: '/service-status/:token',    description: 'Get service status by token',             permissions: ['service_status:read'] },
      { method: 'GET',   path: '/customers',                description: 'List workshop customers',                permissions: ['customers:read'] },
      { method: 'GET',   path: '/webhooks',                 description: 'List webhook endpoints',                  permissions: ['webhooks:manage'] },
      { method: 'GET',   path: '/docs',                     description: 'This documentation endpoint',             permissions: [] },
    ],
    rate_limits: { window: '15 minutes', max_requests: 500 },
    errors: {
      401: 'Missing or invalid API key',
      403: 'API key revoked, expired, or lacks required permission',
      404: 'Resource not found',
      429: 'Rate limit exceeded',
    },
  });
});

export default router;
