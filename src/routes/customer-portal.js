/**
 * Customer Portal — Work Order & Account Routes
 *
 * All endpoints scoped to the authenticated customer. Uses workshop middleware +
 * `requireRole('customer')` via the mounting in index.js, then this router adds
 * its own customer-ID scoping from `req.user → customers.user_id`.
 *
 * Sections:
 *   ── Work Orders (C.2)     — CRUD, invoice/job-sheet, service status
 *   ── Dashboard Stats (C.4)     — KPI cards
 *   ── Financial (C.5)           — invoices, wallet, cash payment summary
 *   ── My Vehicles (NEW)         — customer's own vehicles (list/add)
 *   ── Profile                   — update customer profile, saved addresses
 */

import express from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFinancialConfig, computeWorkOrderFinancials } from '../lib/financial.js';
import { generateInvoicePDF } from './invoices.js';
import { serviceStatusToken } from '../lib/tokens.js';

const router = express.Router();
router.use(authMiddleware);

// Multer for CSV upload
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/* ──────────────────────────────────────────────────────────────
 * Helper — resolve the customer record for the authenticated user
 * ────────────────────────────────────────────────────────────── */
async function getCustomerForUser(userId, workshopId) {
  const [customer] = await query(
    'SELECT * FROM customers WHERE user_id = ? AND workshop_id = ?',
    [userId, workshopId]
  );
  return customer || null;
}

/* ──────────────────────────────────────────────────────────────
 * Middleware — inject req.customer on every request
 * ────────────────────────────────────────────────────────────── */
router.use(async (req, res, next) => {
  try {
    const customer = await getCustomerForUser(req.user.id, req.workshopId);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer profile not found' });
    }
    req.customer = customer;
    next();
  } catch (err) {
    console.error('[CustomerPortal] Customer lookup error:', err);
    return res.status(500).json({ success: false, message: 'Internal error' });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * helper: generate a work order number like TRS-2506-XXXX
 * ───────────────────────────────────────────────────────────────────────────── */
function genWorkOrderNumber() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TRS-${yy}${mm}-${rand}`;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  C.2 — WORK ORDER ENDPOINTS  ═══════════════════════════════════════════
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── GET /work-orders — list this customer's work orders ─────── */
router.get('/work-orders', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20, sort = 'created_at', order = 'desc' } = req.query;
    const pg = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pg - 1) * lim;

    let where = 'WHERE o.workshop_id = ? AND o.customer_id = ?';
    const params = [req.workshopId, req.customer.id];

    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (search) {
      where += ' AND (o.work_order_number LIKE ? OR o.customer_name LIKE ? OR o.service_status_token LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const allowedSorts = ['created_at', 'status', 'work_order_number', 'total_amount'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
    const sortDir = order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM work_orders o ${where}`, params);

    const workOrders = await query(
      `SELECT o.id, o.work_order_number, o.status, o.work_order_type, o.service_category,
              o.customer_name, o.customer_phone, o.dropoff_address,
              o.payment_method, o.cash_amount, o.service_fee, o.discount, o.total_amount,
              o.service_status_token, o.vehicle_id, o.created_at, o.scheduled_at, o.completed_at,
              v.make as vehicle_make, v.model as vehicle_model, v.plate_number as vehicle_plate,
              m.full_name as mechanic_name
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       LEFT JOIN vehicles v ON o.vehicle_id = v.id
       ${where}
       ORDER BY o.${sortCol} ${sortDir}
       LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: workOrders,
      pagination: { total, page: pg, limit: lim, pages: Math.ceil(total / lim) },
    });
  } catch (err) {
    console.error('[CustomerPortal] List work orders error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work orders' });
  }
});

/* ── GET /work-orders/:id — single work order detail ─────────── */
router.get('/work-orders/:id', async (req, res) => {
  try {
    const [order] = await query(
      `SELECT o.*, m.full_name as mechanic_name, m.phone as mechanic_phone,
              b.name as service_bay_name
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       LEFT JOIN service_bays b ON o.service_bay_id = b.id
       WHERE o.id = ? AND o.customer_id = ? AND o.workshop_id = ?`,
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Status timeline
    const timeline = await query(
      'SELECT * FROM work_order_status_logs WHERE work_order_id = ? ORDER BY created_at ASC',
      [order.id]
    );

    // Items (parts/labor used on this work order)
    const items = await query('SELECT * FROM work_order_items WHERE work_order_id = ?', [order.id]);

    // Parts (inventory parts consumed)
    let parts = [];
    try {
      parts = await query(
        'SELECT * FROM parts WHERE work_order_id = ? AND workshop_id = ? ORDER BY id ASC',
        [order.id, req.workshopId]
      );
    } catch (_) {}

    // Vehicle for this work order
    let vehicle = null;
    if (order.vehicle_id) {
      try {
        const [v] = await query(
          'SELECT * FROM vehicles WHERE id = ? AND customer_id = ?',
          [order.vehicle_id, req.customer.id]
        );
        vehicle = v || null;
      } catch (_) {}
    }

    return res.json({ success: true, data: { ...order, timeline, items, parts, vehicle } });
  } catch (err) {
    console.error('[CustomerPortal] Work order detail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work order' });
  }
});

/* ── POST /work-orders — create new work order ────────────────── */
router.post('/work-orders', async (req, res) => {
  try {
    const {
      service_bay_id, work_order_type = 'standard', service_category = 'general_maintenance',
      vehicle_id,
      customer_name, customer_phone, customer_email, dropoff_address,
      description, special_instructions, scheduled_at,
      payment_method = 'cash', cash_amount = 0, service_fee = 0,
      discount = 0, items = [], notes,
      pregenerated_token
    } = req.body;

    // Auto-fill contact info from customer profile if not provided
    const _customer_name = customer_name || req.customer.full_name || req.customer.company_name;
    const _customer_phone = customer_phone || req.customer.phone;
    const _customer_email = customer_email || req.customer.email || null;

    if (!_customer_name || !_customer_phone) {
      return res.status(400).json({ success: false, message: 'Customer name and phone required' });
    }

    // Validate ENUM fields (must match car_workshop.sql work_orders enums)
    const VALID_WORK_ORDER_TYPES = ['standard', 'express', 'same_day', 'scheduled', 'warranty'];
    const VALID_SERVICE_CATEGORIES = ['oil_change', 'brake_repair', 'diagnostic', 'bodywork', 'tire_service', 'engine_repair', 'transmission', 'electrical', 'general_maintenance', 'other'];
    const VALID_PAY_METHODS = ['cash', 'prepaid', 'credit', 'wallet'];

    const _work_order_type = VALID_WORK_ORDER_TYPES.includes(work_order_type) ? work_order_type : 'standard';
    const _service_category = VALID_SERVICE_CATEGORIES.includes(service_category) ? service_category : 'general_maintenance';
    const _payment_method = VALID_PAY_METHODS.includes(payment_method) ? payment_method : 'cash';

    // Coerce numeric fields
    const _cash_amount = parseFloat(cash_amount) || 0;
    const _service_fee = parseFloat(service_fee) || 0;
    const _discount = parseFloat(discount) || 0;

    // Verify the vehicle (if provided) belongs to this customer
    let _vehicle_id = null;
    if (vehicle_id) {
      try {
        const [v] = await query('SELECT id FROM vehicles WHERE id = ? AND customer_id = ?', [vehicle_id, req.customer.id]);
        if (v) _vehicle_id = v.id;
      } catch (_) {}
    }

    // Financial engine
    let finConfig;
    try { finConfig = await getFinancialConfig(req.workshopId); } catch { finConfig = { commissionPercent: 0, vatEnabled: false, vatRate: 0 }; }
    const fin = computeWorkOrderFinancials({
      serviceFee: _service_fee,
      discount: _discount,
      cashAmount: _cash_amount,
      config: finConfig,
    });

    const work_order_number = genWorkOrderNumber();

    // Handle pre-generated service status token
    let service_status_token;
    let pregeneratedTokenId = null;
    if (pregenerated_token) {
      const tokenVal = pregenerated_token.trim().toUpperCase();
      const [pt] = await query(
        'SELECT id, service_status_token, is_used, expires_at FROM pregenerated_tokens WHERE service_status_token = ? AND workshop_id = ?',
        [tokenVal, req.workshopId]
      );
      if (!pt) return res.status(400).json({ success: false, message: 'Pre-generated token not found' });
      if (pt.is_used) return res.status(400).json({ success: false, message: 'This token is already linked to a work order' });
      if (pt.expires_at && new Date(pt.expires_at) <= new Date()) return res.status(400).json({ success: false, message: 'This token has expired' });
      service_status_token = pt.service_status_token;
      pregeneratedTokenId = pt.id;
    } else {
      service_status_token = serviceStatusToken(); // SR-08 — was 48-bit
    }

    const result = await execute(
      `INSERT INTO work_orders (workshop_id, work_order_number, customer_id, service_bay_id, vehicle_id, work_order_type, service_category,
        customer_name, customer_phone, customer_email, dropoff_address, description, special_instructions,
        scheduled_at, payment_method, cash_amount, service_fee, discount, total_amount,
        commission_rate, commission_amount, vat_rate, vat_amount, platform_fee, net_payable,
        status, service_status_token, pregenerated_token_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [req.workshopId, work_order_number, req.customer.id, service_bay_id || null, _vehicle_id, _work_order_type, _service_category,
       _customer_name, _customer_phone, _customer_email, dropoff_address || null,
       description || null, special_instructions || null, scheduled_at || null,
       _payment_method, _cash_amount, _service_fee, _discount, fin.totalAmount,
       fin.commissionRate, fin.commissionAmount, fin.vatRate, fin.vatAmount, fin.platformFee, fin.netPayable,
       service_status_token, pregeneratedTokenId, notes || null]
    );
    const orderId = result.insertId;

    // Mark pre-generated token as used
    if (pregeneratedTokenId) {
      await execute('UPDATE pregenerated_tokens SET is_used = 1, work_order_id = ?, used_at = NOW() WHERE id = ?',
        [orderId, pregeneratedTokenId]);
    }

    // Insert items (labor/parts line items)
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item.name) continue;
        await execute(
          'INSERT INTO work_order_items (work_order_id, name, quantity, unit_price, notes) VALUES (?, ?, ?, ?, ?)',
          [orderId, item.name, item.quantity || 1, item.unit_price || 0, item.notes || null]
        );
      }
    }

    // Status log (changed_by is a users.id FK — null for a customer-initiated action)
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [orderId, 'pending', null, `Work order created by customer #${req.customer.id}`]
    );

    const [newOrder] = await query('SELECT * FROM work_orders WHERE id = ?', [orderId]);

    return res.status(201).json({ success: true, data: newOrder });
  } catch (err) {
    console.error('[CustomerPortal] Create work order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create work order' });
  }
});

/* ── PUT /work-orders/:id — edit work order (only pending/confirmed) ── */
router.put('/work-orders/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT * FROM work_orders WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Work order not found' });

    if (!['pending', 'confirmed'].includes(existing.status)) {
      return res.status(400).json({ success: false, message: `Cannot edit work order with status "${existing.status}"` });
    }

    const {
      customer_name = existing.customer_name,
      customer_phone = existing.customer_phone,
      customer_email = existing.customer_email,
      dropoff_address = existing.dropoff_address,
      description = existing.description,
      special_instructions = existing.special_instructions,
      payment_method = existing.payment_method,
      cash_amount = existing.cash_amount,
      notes = existing.notes,
    } = req.body;

    await execute(
      `UPDATE work_orders SET
        customer_name=?, customer_phone=?, customer_email=?, dropoff_address=?,
        description=?, special_instructions=?, payment_method=?, cash_amount=?, notes=?,
        updated_at=NOW()
       WHERE id = ? AND customer_id = ? AND workshop_id = ?`,
      [customer_name, customer_phone, customer_email, dropoff_address,
       description, special_instructions, payment_method, parseFloat(cash_amount) || 0, notes,
       req.params.id, req.customer.id, req.workshopId]
    );

    const [updated] = await query('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[CustomerPortal] Update work order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update work order' });
  }
});

/* ── DELETE /work-orders/:id — cancel work order (only pending/confirmed) ── */
router.delete('/work-orders/:id', async (req, res) => {
  try {
    const [order] = await query(
      'SELECT id, status FROM work_orders WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel work order with status "${order.status}"` });
    }

    await execute('UPDATE work_orders SET status = "cancelled", updated_at = NOW() WHERE id = ?', [order.id]);
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [order.id, 'cancelled', `customer:${req.customer.id}`, 'Cancelled by customer']
    );

    return res.json({ success: true, message: 'Work order cancelled' });
  } catch (err) {
    console.error('[CustomerPortal] Cancel work order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel work order' });
  }
});

/* ── GET /work-orders/:id/invoice — download invoice/job-sheet PDF ──
   (was: shipping label PDF — repurposed as job sheet / invoice document) ── */
router.get('/work-orders/:id/invoice', async (req, res) => {
  try {
    const [order] = await query(
      `SELECT o.*, b.name as service_bay_name, c.company_name, c.full_name as customer_full_name
       FROM work_orders o
       LEFT JOIN service_bays b ON o.service_bay_id = b.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.id = ? AND o.customer_id = ? AND o.workshop_id = ?`,
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Count items
    const [itemCount] = await query('SELECT COUNT(*) as cnt FROM work_order_items WHERE work_order_id = ?', [order.id]);
    order.item_count = itemCount?.cnt || 0;

    // Get workshop info
    const [workshop] = await query('SELECT * FROM workshops WHERE id = ?', [req.workshopId]);

    // Get job-sheet/invoice template from settings
    let template = null;
    try {
      const [row] = await query("SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'label_template'", [req.workshopId]);
      if (row?.value) template = JSON.parse(row.value);
    } catch (_) {}

    // Dynamically import the job-sheet generator
    const { generateServiceJobSheetPDF } = await import('../lib/service-job-sheet.js');
    await generateServiceJobSheetPDF(res, { orders: [order], tenant: workshop, template });
  } catch (err) {
    console.error('[CustomerPortal] Invoice/job-sheet error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to generate document' });
  }
});

/* ── GET /work-orders/:id/service-status — live service status info ── */
router.get('/work-orders/:id/service-status', async (req, res) => {
  try {
    const [order] = await query(
      `SELECT o.id, o.work_order_number, o.status, o.service_status_token,
              o.customer_name, o.dropoff_address,
              o.scheduled_at, o.completed_at,
              m.full_name as mechanic_name, m.phone as mechanic_phone
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.id = ? AND o.customer_id = ? AND o.workshop_id = ?`,
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    const timeline = await query(
      'SELECT status, note, created_at FROM work_order_status_logs WHERE work_order_id = ? ORDER BY created_at ASC',
      [order.id]
    );

    return res.json({ success: true, data: { ...order, timeline } });
  } catch (err) {
    console.error('[CustomerPortal] Service status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch service status' });
  }
});

/* ── GET /service-status/:query — search by work order number or service status token ── */
router.get('/service-status/:query', async (req, res) => {
  try {
    const q = req.params.query.trim();
    const [order] = await query(
      `SELECT o.id, o.work_order_number, o.status, o.service_status_token,
              o.customer_name, o.customer_phone, o.dropoff_address,
              o.payment_method, o.cash_amount, o.service_fee, o.total_amount,
              o.description, o.special_instructions,
              o.scheduled_at, o.completed_at, o.created_at,
              m.full_name as mechanic_name, m.phone as mechanic_phone
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       WHERE (o.work_order_number = ? OR o.service_status_token = ?) AND o.customer_id = ? AND o.workshop_id = ?`,
      [q, q, req.customer.id, req.workshopId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    const timeline = await query(
      'SELECT status, note, created_at FROM work_order_status_logs WHERE work_order_id = ? ORDER BY created_at ASC',
      [order.id]
    );

    return res.json({ success: true, data: { ...order, timeline } });
  } catch (err) {
    console.error('[CustomerPortal] Service status search error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch service status info' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  C.2B — PARTS ENDPOINTS (parts used on a work order)  ══════════════════
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── GET /work-orders/:id/parts — list parts used on a work order ── */
router.get('/work-orders/:id/parts', async (req, res) => {
  try {
    const [order] = await query(
      'SELECT id, work_order_number, service_status_token FROM work_orders WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    let parts = [];
    try {
      parts = await query(
        'SELECT * FROM parts WHERE work_order_id = ? AND workshop_id = ? ORDER BY id ASC',
        [req.params.id, req.workshopId]
      );
    } catch (_) {}

    return res.json({
      success: true,
      data: {
        order,
        parts,
        summary: {
          total: parts.length,
          total_cost: parts.reduce((sum, p) => sum + (parseFloat(p.total_cost) || 0), 0),
        },
      },
    });
  } catch (err) {
    console.error('[CustomerPortal] Parts error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch parts' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  C.4 — DASHBOARD STATS  ════════════════════════════════════════════════
 * ══════════════════════════════════════════════════════════════════════════════ */

router.get('/stats', async (req, res) => {
  try {
    const cid = req.customer.id;
    const wid = req.workshopId;

    // Overall stats
    const [overall] = await query(
      `SELECT
         COUNT(*) as total_work_orders,
         SUM(status = 'pending')          as pending,
         SUM(status = 'confirmed')        as confirmed,
         SUM(status = 'assigned')         as assigned,
         SUM(status = 'accepted')         as accepted,
         SUM(status = 'in_progress')      as in_progress,
         SUM(status = 'ready_for_pickup') as ready_for_pickup,
         SUM(status = 'completed')        as completed,
         SUM(status = 'cancelled')        as cancelled,
         COALESCE(SUM(service_fee), 0)                        as total_service_fees,
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN cash_amount ELSE 0 END), 0) as total_cash,
         COALESCE(SUM(total_amount), 0) as total_spend
       FROM work_orders WHERE customer_id = ? AND workshop_id = ?`,
      [cid, wid]
    );

    // Today's stats
    const [today] = await query(
      `SELECT
         COUNT(*) as orders_today,
         SUM(status = 'completed') as completed_today,
         SUM(status IN ('in_progress','ready_for_pickup','assigned','accepted')) as in_progress_today
       FROM work_orders WHERE customer_id = ? AND workshop_id = ? AND DATE(created_at) = CURDATE()`,
      [cid, wid]
    );

    // This month
    const [month] = await query(
      `SELECT
         COUNT(*) as orders_this_month,
         COALESCE(SUM(total_amount), 0) as spend_this_month
       FROM work_orders WHERE customer_id = ? AND workshop_id = ?
         AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`,
      [cid, wid]
    );

    // Recent 7 days daily breakdown
    const dailyBreakdown = await query(
      `SELECT DATE(created_at) as date, COUNT(*) as count, SUM(status='completed') as completed
       FROM work_orders WHERE customer_id = ? AND workshop_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [cid, wid]
    );

    return res.json({
      success: true,
      data: {
        ...overall,
        ...today,
        ...month,
        daily_breakdown: dailyBreakdown,
      },
    });
  } catch (err) {
    console.error('[CustomerPortal] Stats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  C.5 — FINANCIAL ENDPOINTS  ════════════════════════════════════════════
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── GET /invoices — customer's invoices ─────────────────────── */
router.get('/invoices', async (req, res) => {
  try {
    const invoices = await query(
      `SELECT id, invoice_number, customer_id, work_order_id,
              subtotal, tax_amount, total_amount, status, due_date, created_at
       FROM invoices
       WHERE customer_id = ? AND workshop_id = ?
       ORDER BY created_at DESC`,
      [req.customer.id, req.workshopId]
    );
    return res.json({ success: true, data: invoices });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
  }
});

/* ── GET /invoices/:id/pdf — download invoice PDF ─────────────── */
router.get('/invoices/:id/pdf', async (req, res) => {
  try {
    const [invoice] = await query(
      'SELECT * FROM invoices WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    // Generate directly (this router is customer-authenticated, not staff-authenticated,
    // so we can't redirect into the staff-only /api/invoices/:id/pdf route).
    const [workshop] = await query('SELECT name, email, phone, address, city, country, logo_url FROM workshops WHERE id = ?', [req.workshopId]);
    const customer = req.customer;
    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    const [order] = invoice.work_order_id
      ? await query('SELECT work_order_number, customer_name, customer_phone, dropoff_address, payment_method FROM work_orders WHERE id = ?', [invoice.work_order_id])
      : [null];

    let vatNumber = '';
    try { const finCfg = await getFinancialConfig(req.workshopId); vatNumber = finCfg.vatNumber || ''; } catch {}

    await generateInvoicePDF(res, { invoice, workshop, customer, items, order, vatNumber, workshopId: req.workshopId });
  } catch (err) {
    console.error('[CustomerPortal] Invoice PDF error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to get invoice PDF' });
  }
});

/* ── GET /wallet — customer wallet balance ───────────────────── */
router.get('/wallet', async (req, res) => {
  try {
    // Find wallet transactions related to this customer
    const [wallet] = await query(
      'SELECT * FROM wallets WHERE workshop_id = ?',
      [req.workshopId]
    );

    const transactions = await query(
      `SELECT wt.* FROM wallet_transactions wt
       WHERE wt.workshop_id = ? AND wt.work_order_id IN (
         SELECT id FROM work_orders WHERE customer_id = ?
       )
       ORDER BY wt.created_at DESC LIMIT 50`,
      [req.workshopId, req.customer.id]
    );

    // Customer cash balance (completed work orders cash - already settled)
    const [cashBalance] = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='completed' AND payment_method='cash' THEN cash_amount ELSE 0 END), 0) as total_cash_collected,
         COALESCE(SUM(CASE WHEN status='completed' AND payment_method='cash' AND cash_collected > 0 THEN cash_amount ELSE 0 END), 0) as cash_settled
       FROM work_orders WHERE customer_id = ? AND workshop_id = ?`,
      [req.customer.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        wallet_balance: wallet?.balance || 0,
        transactions,
        cash_balance: cashBalance,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet info' });
  }
});

/* ── GET /cash-summary — cash payment collection status ──────── */
router.get('/cash-summary', async (req, res) => {
  try {
    const [summary] = await query(
      `SELECT
         COUNT(*) as total_cash_orders,
         SUM(status='completed') as completed,
         SUM(status IN ('in_progress','assigned','accepted','ready_for_pickup')) as in_progress,
         SUM(status IN ('pending','confirmed')) as pending_pickup,
         COALESCE(SUM(CASE WHEN payment_method='cash' THEN cash_amount ELSE 0 END), 0) as total_cash_amount,
         COALESCE(SUM(CASE WHEN payment_method='cash' AND status='completed' THEN cash_amount ELSE 0 END), 0) as collected,
         COALESCE(SUM(CASE WHEN payment_method='cash' AND status!='completed' AND status!='cancelled' THEN cash_amount ELSE 0 END), 0) as outstanding
       FROM work_orders
       WHERE customer_id = ? AND workshop_id = ? AND payment_method = 'cash'`,
      [req.customer.id, req.workshopId]
    );

    // Recent cash-payment work orders
    const recentCash = await query(
      `SELECT id, work_order_number, status, cash_amount, customer_name, created_at
       FROM work_orders
       WHERE customer_id = ? AND workshop_id = ? AND payment_method = 'cash'
       ORDER BY created_at DESC LIMIT 20`,
      [req.customer.id, req.workshopId]
    );

    return res.json({ success: true, data: { ...summary, recent_orders: recentCash } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch cash summary' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  MY VEHICLES (NEW)  ═════════════════════════════════════════════════════
 * Customers can list/add their own vehicles from the portal. Full admin CRUD
 * (edit/delete, cross-customer listing) lives in the dedicated routes/vehicles.js;
 * this is a simple portal-scoped view following the same "my X" pattern as
 * /pre-generated and /saved-addresses below.
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── GET /vehicles — list this customer's vehicles ────────────── */
// Uses the real `vehicles` table from car_workshop.sql (also used by the
// dedicated admin routes/vehicles.js) — do not create a competing schema here.
router.get('/vehicles', async (req, res) => {
  try {
    const vehicles = await query(
      'SELECT * FROM vehicles WHERE customer_id = ? AND workshop_id = ? AND is_active = TRUE ORDER BY created_at DESC',
      [req.customer.id, req.workshopId]
    );
    return res.json({ success: true, data: vehicles });
  } catch (err) {
    console.error('[CustomerPortal] List vehicles error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch vehicles' });
  }
});

/* ── POST /vehicles — add a vehicle ───────────────────────────── */
router.post('/vehicles', async (req, res) => {
  try {
    const { make, model, year, plate_number, vin, color, mileage, fuel_type = 'petrol', transmission = 'automatic' } = req.body;
    if (!make || !model) {
      return res.status(400).json({ success: false, message: 'Make and model are required' });
    }

    const result = await execute(
      `INSERT INTO vehicles (workshop_id, customer_id, make, model, year, plate_number, vin, color, mileage, fuel_type, transmission)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, req.customer.id, make, model, parseInt(year) || null, plate_number || null, vin || null,
       color || null, parseInt(mileage) || null, fuel_type, transmission]
    );

    const [vehicle] = await query('SELECT * FROM vehicles WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: vehicle });
  } catch (err) {
    console.error('[CustomerPortal] Add vehicle error:', err);
    return res.status(500).json({ success: false, message: 'Failed to add vehicle' });
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
 * ═══  PROFILE & SETTINGS  ═══════════════════════════════════════════════════
 * ══════════════════════════════════════════════════════════════════════════════ */

/* ── GET /profile — customer profile ─────────────────────────── */
router.get('/profile', async (req, res) => {
  try {
    return res.json({ success: true, data: req.customer });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

/* ── PUT /profile — update customer profile ──────────────────── */
router.put('/profile', async (req, res) => {
  try {
    const {
      full_name, company_name, phone_alt,
      address_line1, address_line2, city, emirate,
    } = req.body;

    await execute(
      `UPDATE customers SET
        full_name = COALESCE(?, full_name),
        company_name = COALESCE(?, company_name),
        phone_alt = ?,
        address_line1 = COALESCE(?, address_line1),
        address_line2 = ?,
        city = COALESCE(?, city),
        emirate = COALESCE(?, emirate)
       WHERE id = ? AND workshop_id = ?`,
      [full_name || null, company_name || null, phone_alt || null,
       address_line1 || null, address_line2 || null,
       city || null, emirate || null, req.customer.id, req.workshopId]
    );

    const [updated] = await query('SELECT * FROM customers WHERE id = ?', [req.customer.id]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

/* ── Ensure customer_saved_addresses exists — called by every handler
   below, not just GET, so POST/PUT/DELETE work even if GET was never
   hit first in this process. ── */
async function ensureSavedAddressesTable() {
  await execute(`CREATE TABLE IF NOT EXISTS customer_saved_addresses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    workshop_id INT NOT NULL,
    label VARCHAR(100) NOT NULL,
    contact_name VARCHAR(255),
    contact_phone VARCHAR(50),
    address_line1 VARCHAR(500) NOT NULL,
    area VARCHAR(100),
    city VARCHAR(100),
    emirate VARCHAR(50) DEFAULT 'Dubai',
    lat DECIMAL(10,7),
    lng DECIMAL(10,7),
    is_default TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`).catch(() => { /* already exists */ });
}

/* ── GET /saved-addresses — address book ─────────────────────── */
router.get('/saved-addresses', async (req, res) => {
  try {
    await ensureSavedAddressesTable();

    const addresses = await query(
      'SELECT * FROM customer_saved_addresses WHERE customer_id = ? AND workshop_id = ? ORDER BY is_default DESC, label ASC',
      [req.customer.id, req.workshopId]
    );
    return res.json({ success: true, data: addresses });
  } catch (err) {
    console.error('[CustomerPortal] List addresses error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch addresses' });
  }
});

/* ── POST /saved-addresses — add an address ──────────────────── */
router.post('/saved-addresses', async (req, res) => {
  try {
    await ensureSavedAddressesTable();

    const { label, contact_name, contact_phone, address_line1, area, city, emirate = 'Dubai', lat, lng, is_default } = req.body;
    if (!label || !address_line1) {
      return res.status(400).json({ success: false, message: 'Label and address required' });
    }

    if (is_default) {
      await execute('UPDATE customer_saved_addresses SET is_default = 0 WHERE customer_id = ? AND workshop_id = ?',
        [req.customer.id, req.workshopId]);
    }

    const result = await execute(
      `INSERT INTO customer_saved_addresses (customer_id, workshop_id, label, contact_name, contact_phone, address_line1, area, city, emirate, lat, lng, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.customer.id, req.workshopId, label, contact_name || null, contact_phone || null,
       address_line1, area || null, city || null, emirate, lat || null, lng || null, is_default ? 1 : 0]
    );

    const [addr] = await query('SELECT * FROM customer_saved_addresses WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: addr });
  } catch (err) {
    console.error('[CustomerPortal] Save address error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save address' });
  }
});

/* ── PUT /saved-addresses/:id — update an address ─────────────── */
router.put('/saved-addresses/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT * FROM customer_saved_addresses WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Address not found' });

    const { label, contact_name, contact_phone, address_line1, area, city, emirate, lat, lng, is_default } = req.body;
    if (!label || !address_line1) {
      return res.status(400).json({ success: false, message: 'Label and address required' });
    }

    if (is_default) {
      await execute('UPDATE customer_saved_addresses SET is_default = 0 WHERE customer_id = ? AND workshop_id = ?',
        [req.customer.id, req.workshopId]);
    }

    await execute(
      `UPDATE customer_saved_addresses SET
        label = ?, contact_name = ?, contact_phone = ?, address_line1 = ?,
        area = ?, city = ?, emirate = ?, lat = ?, lng = ?, is_default = ?
       WHERE id = ? AND customer_id = ? AND workshop_id = ?`,
      [label, contact_name || null, contact_phone || null, address_line1,
       area || null, city || null, emirate || 'Dubai', lat || null, lng || null,
       is_default ? 1 : 0, req.params.id, req.customer.id, req.workshopId]
    );

    const [updated] = await query('SELECT * FROM customer_saved_addresses WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[CustomerPortal] Update address error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update address' });
  }
});

/* ── DELETE /saved-addresses/:id ─────────────────────────────── */
router.delete('/saved-addresses/:id', async (req, res) => {
  try {
    await execute(
      'DELETE FROM customer_saved_addresses WHERE id = ? AND customer_id = ? AND workshop_id = ?',
      [req.params.id, req.customer.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Address deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete address' });
  }
});

export default router;
