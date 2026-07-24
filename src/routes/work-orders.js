/**
 * ═══════════════════════════════════════════════════════════════════
 *  Work Orders Routes — Master CRUD for car-workshop work orders
 * ═══════════════════════════════════════════════════════════════════
 *
 * Rebranded/ported from the delivery-service `orders.js`. Renames applied:
 *   orders -> work_orders, order_items -> work_order_items,
 *   order_status_logs -> work_order_status_logs,
 *   order_assignments -> work_order_assignments,
 *   order_scan_logs -> work_order_scan_logs,
 *   drivers -> mechanics, clients -> customers, zones -> service_bays,
 *   tracking_token -> service_status_token, driver_rating -> mechanic_rating,
 *   cod_amount/delivery_fee -> cash_amount/service_fee.
 *
 * JUDGMENT CALLS:
 *  - Status enum kept per car_workshop.sql:
 *      pending -> confirmed -> assigned -> accepted -> in_progress ->
 *      ready_for_pickup -> completed / failed / cancelled
 *    (delivery-only statuses 'picked_up'/'in_transit'/'returned' dropped;
 *    'returned' work now maps to the separate warranty-claims flow.)
 *  - sender_ and recipient_ order fields collapsed into customer_id + vehicle_id
 *    + a redundant customer_name/phone/email snapshot on the work order
 *    (matches car_workshop.sql work_orders columns exactly).
 *  - Packages/AWB/shipping-label/pre-generated-barcode machinery from the
 *    source file is NOT ported here — that belongs to parts.js (inventory
 *    parts) and service-job-sheet.js (PDF generator) respectively. This file
 *    keeps the pre-generated SERVICE STATUS TOKEN flow (pregenerated_tokens
 *    table) since that maps 1:1 onto work orders (service_status_token),
 *    not onto packages.
 *  - weight_kg/dimensions/category(parcel,food,...) dropped; replaced with
 *    service_category enum from the schema.
 *  - vehicle_id is included in create/update and vehicles are JOINed for
 *    make/model/plate_number in list/detail responses.
 *  - Multi-stop / route-matrix auto-assign logic from the original dispatch
 *    flow does NOT live here — see job-assignment.js. This file only owns
 *    work order CRUD, status transitions, items, and mechanic rating.
 * ═══════════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyWorkOrderStatus, notifyMechanicAssigned } from '../lib/notify.js';
import { dispatchWebhook, workOrderStatusToEvent } from '../lib/webhook-dispatcher.js';
import { createInvoiceFromWorkOrder } from './invoices.js';
import { getFinancialConfig, computeWorkOrderFinancials, recordMechanicEarning } from '../lib/financial.js';
import { checkLimit as checkLimitFn, getUsageStats } from '../middleware/plan-gate.js';
import crypto from 'crypto';

const router = express.Router();
router.use(authMiddleware);

function genWorkOrderNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `WO-${stamp}-${rand}`;
}

// Helper — generate unique service status token (customer-facing tracking token)
function genServiceStatusToken() {
  return 'WO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// GET /api/work-orders/stats — aggregate KPIs for the workshop
router.get('/stats', async (req, res) => {
  try {
    const [counts] = await query(
      `SELECT
         COUNT(*) as total,
         SUM(status = 'pending')          as pending,
         SUM(status = 'confirmed')        as confirmed,
         SUM(status = 'assigned')         as assigned,
         SUM(status = 'accepted')         as accepted,
         SUM(status = 'in_progress')      as in_progress,
         SUM(status = 'ready_for_pickup') as ready_for_pickup,
         SUM(status = 'completed')        as completed,
         SUM(status = 'failed')           as failed,
         SUM(status = 'cancelled')        as cancelled,
         COALESCE(SUM(service_fee), 0)    as total_revenue,
         COALESCE(SUM(cash_amount), 0)    as total_cash,
         COALESCE(SUM(total_amount), 0)   as total_amount,
         COALESCE(SUM(commission_amount), 0) as total_commission,
         COALESCE(SUM(vat_amount), 0)     as total_vat,
         COALESCE(SUM(net_payable), 0)    as total_net_payable,
         SUM(DATE(created_at) = CURDATE()) as today,
         SUM(YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)) as this_week,
         SUM(YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())) as this_month
       FROM work_orders WHERE workshop_id = ?`,
      [req.workshopId]
    );
    const byType = await query(
      `SELECT work_order_type, COUNT(*) as count FROM work_orders WHERE workshop_id = ? GROUP BY work_order_type`,
      [req.workshopId]
    );
    const byPayment = await query(
      `SELECT payment_method, COUNT(*) as count FROM work_orders WHERE workshop_id = ? GROUP BY payment_method`,
      [req.workshopId]
    );
    const topCustomers = await query(
      `SELECT c.id, c.full_name, c.company_name, c.type,
              COUNT(wo.id) as total_work_orders,
              SUM(CASE WHEN wo.status='completed' THEN 1 ELSE 0 END) as completed_work_orders,
              COALESCE(SUM(wo.service_fee), 0) as revenue
       FROM work_orders wo
       INNER JOIN customers c ON wo.customer_id = c.id
       WHERE wo.workshop_id = ?
       GROUP BY c.id ORDER BY total_work_orders DESC LIMIT 5`,
      [req.workshopId]
    );
    return res.json({ success: true, data: { ...counts, by_type: byType, by_payment: byPayment, top_customers: topCustomers } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work order stats' });
  }
});

// GET /api/work-orders
router.get('/', async (req, res) => {
  try {
    const { status, mechanic_id, customer_id, service_bay_id, date_from, date_to,
            work_order_type, payment_method, search, page = 1, limit = 50,
            sort_by, sort_dir } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 50;
    const offset = (pg - 1) * lim;

    let where = 'WHERE wo.workshop_id = ?';
    const params = [req.workshopId];

    if (status) { where += ' AND wo.status = ?'; params.push(status); }
    if (mechanic_id) { where += ' AND wo.mechanic_id = ?'; params.push(mechanic_id); }
    if (customer_id) { where += ' AND wo.customer_id = ?'; params.push(customer_id); }
    if (service_bay_id) { where += ' AND wo.service_bay_id = ?'; params.push(service_bay_id); }
    if (work_order_type) { where += ' AND wo.work_order_type = ?'; params.push(work_order_type); }
    if (payment_method) { where += ' AND wo.payment_method = ?'; params.push(payment_method); }
    if (date_from) { where += ' AND DATE(wo.created_at) >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND DATE(wo.created_at) <= ?'; params.push(date_to); }
    if (search) {
      where += ' AND (wo.work_order_number LIKE ? OR wo.customer_name LIKE ? OR wo.customer_phone LIKE ? OR wo.service_status_token LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM work_orders wo ${where}`, params);
    const workOrders = await query(
      `SELECT wo.*, m.full_name as mechanic_name, m.phone as mechanic_phone,
              m.specialty as mechanic_specialty, m.status as mechanic_status,
              c.full_name as customer_name_ref, b.name as service_bay_name,
              v.make as vehicle_make, v.model as vehicle_model, v.plate_number as vehicle_plate_number,
              DATE_ADD(wo.created_at, INTERVAL 4 HOUR) AS created_at,
              wo.scheduled_at,
              DATE_ADD(COALESCE(wa.assigned_at, wsl_assign.created_at, wo.created_at), INTERVAL 4 HOUR) AS assigned_at
       FROM work_orders wo
       LEFT JOIN mechanics m ON wo.mechanic_id = m.id
       LEFT JOIN customers c ON wo.customer_id = c.id
       LEFT JOIN service_bays b ON wo.service_bay_id = b.id
       LEFT JOIN vehicles v ON wo.vehicle_id = v.id
       LEFT JOIN work_order_assignments wa ON wa.work_order_id = wo.id AND wa.mechanic_id = wo.mechanic_id AND wa.is_current = TRUE
       LEFT JOIN (SELECT work_order_id, MIN(created_at) AS created_at FROM work_order_status_logs WHERE status = 'assigned' GROUP BY work_order_id) wsl_assign ON wsl_assign.work_order_id = wo.id
       ${where} ORDER BY ${(() => {
         const validCols = { date:'wo.created_at', cash:'wo.cash_amount', bay:'b.name', status:'wo.status', customer:'wo.customer_name', work_order_number:'wo.work_order_number', completed_at:'wo.completed_at' };
         const col = validCols[sort_by];
         if (col) { const d = sort_dir === 'asc' ? 'ASC' : 'DESC'; return `${col} ${d}`; }
         return 'GREATEST(COALESCE(wo.completed_at, wo.created_at), COALESCE(wo.failed_at, wo.created_at), wo.created_at) DESC';
       })()}
       LIMIT ${lim} OFFSET ${offset}`,
      params
    );
    return res.json({ success: true, data: workOrders, pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work orders' });
  }
});

/* ══════════════════════════════════════════════════════════════
   Pre-generated service status tokens (ported from MODULE A —
   pre-order barcode pre-printing). Kept because service_status_token
   is a work-order-level concept in the new schema, not a package one.
   ══════════════════════════════════════════════════════════════ */

// POST /api/work-orders/pre-generate — create N blank service status tokens without a work order
router.post('/pre-generate', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body.count) || 1, 1), 200);
    const batch_name = req.body.batch_name || null;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // tokens expire in 30 days
    const expiresStr = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

    const tokens = [];
    for (let i = 0; i < count; i++) {
      // Generate unique token — retry on collision
      let token, attempts = 0;
      while (attempts < 5) {
        token = genServiceStatusToken();
        const [exists] = await query(
          'SELECT id FROM pregenerated_tokens WHERE service_status_token = ? UNION SELECT id FROM work_orders WHERE service_status_token = ?',
          [token, token]
        );
        if (!exists) break;
        attempts++;
      }
      if (attempts >= 5) {
        return res.status(500).json({ success: false, message: 'Failed to generate unique tokens. Please try again.' });
      }

      const result = await execute(
        `INSERT INTO pregenerated_tokens (workshop_id, service_status_token, barcode_value, batch_name, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [req.workshopId, token, token, batch_name, expiresStr]
      );

      tokens.push({
        id: result.insertId,
        service_status_token: token,
        barcode_value: token,
        batch_name,
        expires_at: expiresStr,
      });
    }

    return res.status(201).json({
      success: true,
      message: `Generated ${tokens.length} pre-printed service status tokens`,
      data: tokens,
    });
  } catch (err) {
    console.error('[WorkOrders] Pre-generate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to pre-generate tokens' });
  }
});

// GET /api/work-orders/pre-generated — list pre-generated tokens for this workshop
router.get('/pre-generated', async (req, res) => {
  try {
    const { used, batch_name, page = 1, limit = 100 } = req.query;
    const pg  = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(Math.max(1, parseInt(limit) || 100), 500);
    const offset = (pg - 1) * lim;

    let where = 'WHERE pt.workshop_id = ?';
    const params = [req.workshopId];

    if (used === 'false' || used === '0') {
      where += ' AND pt.is_used = 0 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())';
    } else if (used === 'true' || used === '1') {
      where += ' AND pt.is_used = 1';
    }
    if (batch_name) {
      where += ' AND pt.batch_name = ?';
      params.push(batch_name);
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM pregenerated_tokens pt ${where}`,
      params
    );
    const tokens = await query(
      `SELECT pt.*,
              wo.work_order_number, wo.customer_name, wo.status as work_order_status,
              DATEDIFF(pt.expires_at, NOW()) as days_remaining
       FROM pregenerated_tokens pt
       LEFT JOIN work_orders wo ON pt.work_order_id = wo.id
       ${where} ORDER BY pt.created_at DESC LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    return res.json({ success: true, data: tokens, pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    console.error('[WorkOrders] Pre-generated list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch pre-generated tokens' });
  }
});

// GET /api/work-orders/pre-generated/stats — summary counts for pre-generated tokens
router.get('/pre-generated/stats', async (req, res) => {
  try {
    const [counts] = await query(
      `SELECT
         COUNT(*) as total,
         CAST(COALESCE(SUM(is_used = 0 AND (expires_at IS NULL OR expires_at > NOW())), 0) AS UNSIGNED) as available,
         CAST(COALESCE(SUM(is_used = 1), 0) AS UNSIGNED) as used,
         CAST(COALESCE(SUM(is_used = 0 AND expires_at IS NOT NULL AND expires_at <= NOW()), 0) AS UNSIGNED) as expired
       FROM pregenerated_tokens WHERE workshop_id = ?`,
      [req.workshopId]
    );
    return res.json({ success: true, data: { total: Number(counts.total), available: Number(counts.available), used: Number(counts.used), expired: Number(counts.expired) } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// DELETE /api/work-orders/pre-generated/:id — delete a single unused pre-generated token
router.delete('/pre-generated/:id', async (req, res) => {
  try {
    const [token] = await query(
      'SELECT id, is_used FROM pregenerated_tokens WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!token) return res.status(404).json({ success: false, message: 'Token not found' });
    if (token.is_used) return res.status(400).json({ success: false, message: 'Cannot delete a token that has been linked to a work order' });

    await execute('DELETE FROM pregenerated_tokens WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Token deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete token' });
  }
});

// POST /api/work-orders/pre-generated/:id/link — link an available token to an existing work order
router.post('/pre-generated/:id/link', async (req, res) => {
  try {
    const { work_order_id } = req.body;
    if (!work_order_id) return res.status(400).json({ success: false, message: 'work_order_id is required' });

    const [token] = await query(
      'SELECT id, service_status_token, is_used, expires_at FROM pregenerated_tokens WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!token) return res.status(404).json({ success: false, message: 'Token not found' });
    if (token.is_used) return res.status(400).json({ success: false, message: 'Token is already linked to a work order' });
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.status(400).json({ success: false, message: 'Token has expired' });
    }

    const [workOrder] = await query(
      'SELECT id, work_order_number, service_status_token FROM work_orders WHERE id = ? AND workshop_id = ?',
      [work_order_id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Update the work order's service_status_token to the pre-generated token
    await execute(
      'UPDATE work_orders SET service_status_token = ?, pregenerated_token_id = ? WHERE id = ?',
      [token.service_status_token, token.id, workOrder.id]
    );

    // Mark token as used
    await execute(
      'UPDATE pregenerated_tokens SET is_used = 1, work_order_id = ?, used_at = NOW() WHERE id = ?',
      [workOrder.id, token.id]
    );

    return res.json({
      success: true,
      message: `Token ${token.service_status_token} linked to work order ${workOrder.work_order_number}`,
      data: { token_id: token.id, work_order_id: workOrder.id, work_order_number: workOrder.work_order_number, service_status_token: token.service_status_token }
    });
  } catch (err) {
    console.error('[WorkOrders] Link token error:', err);
    return res.status(500).json({ success: false, message: 'Failed to link token to work order' });
  }
});

// POST /api/work-orders/pre-generated/:id/unlink — unlink a token from its linked work order
router.post('/pre-generated/:id/unlink', async (req, res) => {
  try {
    const [token] = await query(
      'SELECT id, service_status_token, is_used, work_order_id FROM pregenerated_tokens WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!token) return res.status(404).json({ success: false, message: 'Token not found' });
    if (!token.is_used || !token.work_order_id) {
      return res.status(400).json({ success: false, message: 'Token is not linked to any work order' });
    }

    // Generate a new random service status token for the work order so it's not left empty
    const newToken = 'WO-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await execute(
      'UPDATE work_orders SET service_status_token = ?, pregenerated_token_id = NULL WHERE id = ? AND workshop_id = ?',
      [newToken, token.work_order_id, req.workshopId]
    );

    // Mark token as available again
    await execute(
      'UPDATE pregenerated_tokens SET is_used = 0, work_order_id = NULL, used_at = NULL WHERE id = ?',
      [token.id]
    );

    return res.json({
      success: true,
      message: `Token ${token.service_status_token} unlinked`,
      data: { token_id: token.id, service_status_token: token.service_status_token }
    });
  } catch (err) {
    console.error('[WorkOrders] Unlink token error:', err);
    return res.status(500).json({ success: false, message: 'Failed to unlink token' });
  }
});

// GET /api/work-orders/linkable — search work orders that can be linked (for barcode link modal)
router.get('/linkable', async (req, res) => {
  try {
    const { q = '' } = req.query;
    const search = q.trim();
    let where = 'WHERE wo.workshop_id = ?';
    const params = [req.workshopId];

    if (search) {
      where += ' AND (wo.work_order_number LIKE ? OR wo.customer_name LIKE ? OR wo.service_status_token LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const workOrders = await query(
      `SELECT wo.id, wo.work_order_number, wo.customer_name, wo.status, wo.service_status_token, wo.created_at
       FROM work_orders wo ${where}
       ORDER BY wo.created_at DESC LIMIT 20`,
      params
    );
    return res.json({ success: true, data: workOrders });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch work orders' });
  }
});

// POST /api/work-orders/validate-pregenerated — check if a token is valid and available
router.post('/validate-pregenerated', async (req, res) => {
  try {
    const { service_status_token } = req.body;
    if (!service_status_token) return res.status(400).json({ success: false, message: 'service_status_token required' });

    const [token] = await query(
      `SELECT pt.*, wo.work_order_number
       FROM pregenerated_tokens pt
       LEFT JOIN work_orders wo ON pt.work_order_id = wo.id
       WHERE pt.service_status_token = ? AND pt.workshop_id = ?`,
      [service_status_token.trim().toUpperCase(), req.workshopId]
    );

    if (!token) {
      return res.json({ success: true, data: { valid: false, reason: 'not_found' } });
    }
    if (token.is_used) {
      return res.json({ success: true, data: { valid: false, reason: 'already_used', work_order_number: token.work_order_number } });
    }
    if (token.expires_at && new Date(token.expires_at) <= new Date()) {
      return res.json({ success: true, data: { valid: false, reason: 'expired' } });
    }
    return res.json({ success: true, data: { valid: true, token_id: token.id, service_status_token: token.service_status_token } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Validation failed' });
  }
});

// GET /api/work-orders/:id
router.get('/:id', async (req, res) => {
  try {
    const [workOrder] = await query(
      `SELECT wo.*, m.full_name as mechanic_name, m.phone as mechanic_phone,
              m.specialty as mechanic_specialty, m.status as mechanic_status,
              c.full_name as customer_name_ref, c.phone as customer_phone_ref, c.company_name,
              b.name as service_bay_name,
              v.make as vehicle_make, v.model as vehicle_model, v.year as vehicle_year,
              v.plate_number as vehicle_plate_number, v.vin as vehicle_vin, v.color as vehicle_color,
              DATE_ADD(wo.created_at, INTERVAL 4 HOUR) AS created_at,
              wo.scheduled_at,
              DATE_ADD(COALESCE(wa.assigned_at, wsl_assign.created_at, wo.created_at), INTERVAL 4 HOUR) AS assigned_at
       FROM work_orders wo
       LEFT JOIN mechanics m ON wo.mechanic_id = m.id
       LEFT JOIN customers c ON wo.customer_id = c.id
       LEFT JOIN service_bays b ON wo.service_bay_id = b.id
       LEFT JOIN vehicles v ON wo.vehicle_id = v.id
       LEFT JOIN work_order_assignments wa ON wa.work_order_id = wo.id AND wa.mechanic_id = wo.mechanic_id AND wa.is_current = TRUE
       LEFT JOIN (SELECT work_order_id, MIN(created_at) AS created_at FROM work_order_status_logs WHERE status = 'assigned' GROUP BY work_order_id) wsl_assign ON wsl_assign.work_order_id = wo.id
       WHERE wo.id = ? AND wo.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const items = await query('SELECT * FROM work_order_items WHERE work_order_id = ?', [req.params.id]);
    const statusLogs = await query(
      `SELECT sl.*, u.full_name as changed_by_name
       FROM work_order_status_logs sl
       LEFT JOIN users u ON sl.changed_by = u.id
       WHERE sl.work_order_id = ? ORDER BY sl.created_at ASC`,
      [req.params.id]
    );

    // Include parts used on this work order, if any
    let parts = [];
    try {
      parts = await query(
        'SELECT * FROM parts WHERE work_order_id = ? AND workshop_id = ? ORDER BY created_at ASC',
        [req.params.id, req.workshopId]
      );
    } catch (_) { /* parts table may not exist yet */ }

    // Include completion photos
    let photos = [];
    try {
      photos = await query(
        'SELECT id, photo_url, photo_type, caption, mechanic_id, lat, lng, uploaded_at FROM completion_photos WHERE work_order_id = ? ORDER BY uploaded_at ASC',
        [req.params.id]
      );
    } catch (_) { /* completion_photos table may not exist yet */ }

    return res.json({ success: true, data: { ...workOrder, items, parts, photos, status_logs: statusLogs } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch work order' });
  }
});

// GET /api/work-orders/:id/photos — get all completion photos for a work order (admin)
router.get('/:id/photos', async (req, res) => {
  try {
    const [workOrder] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const photos = await query(
      `SELECT cp.*, m.full_name as mechanic_name
       FROM completion_photos cp
       LEFT JOIN mechanics m ON cp.mechanic_id = m.id
       WHERE cp.work_order_id = ? AND cp.workshop_id = ?
       ORDER BY cp.uploaded_at ASC`,
      [workOrder.id, req.workshopId]
    );

    return res.json({ success: true, data: photos });
  } catch (err) {
    console.error('[WorkOrders] get photos error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load photos' });
  }
});

// DELETE /api/work-orders/:id/photos/:photoId — delete a photo (admin)
router.delete('/:id/photos/:photoId', async (req, res) => {
  try {
    const [photo] = await query(
      'SELECT id, photo_url FROM completion_photos WHERE id = ? AND work_order_id = ? AND workshop_id = ?',
      [req.params.photoId, req.params.id, req.workshopId]
    );
    if (!photo) return res.status(404).json({ success: false, message: 'Photo not found' });

    await execute('DELETE FROM completion_photos WHERE id = ?', [photo.id]);

    // Clean up file from disk
    const path = await import('path');
    const filePath = path.resolve('uploads', '..', photo.photo_url);
    const fs = await import('fs');
    fs.default.unlink(filePath, () => {});

    return res.json({ success: true, message: 'Photo deleted' });
  } catch (err) {
    console.error('[WorkOrders] delete photo error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete photo' });
  }
});

// POST /api/work-orders
router.post('/', async (req, res) => {
  try {
    // D.2 — Check monthly work order limit before creating
    if (req.subscription && !req.subscription.bypass) {
      const workshopId = req.workshopId || req.user?.workshop_id;
      const usage = await getUsageStats(workshopId);
      const maxWorkOrders = req.subscription.limits?.max_work_orders_per_month || 1000;
      if (usage.work_orders_this_month >= maxWorkOrders) {
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          limit_type: 'max_work_orders_per_month',
          current_usage: usage.work_orders_this_month,
          limit: maxWorkOrders,
          current_plan: req.subscription.plan,
          message: `Work order limit reached (${usage.work_orders_this_month}/${maxWorkOrders}). Upgrade your plan for more work orders.`,
        });
      }
    }

    const {
      customer_id, vehicle_id, service_bay_id, work_order_type = 'standard', service_category = 'general_maintenance',
      customer_name, customer_phone, customer_email,
      dropoff_address, dropoff_lat, dropoff_lng,
      description, special_instructions, scheduled_at,
      payment_method = 'cash', cash_amount = 0, service_fee = 0,
      discount = 0, items = [], notes,
      pregenerated_token, // optional pre-printed service status token
    } = req.body;

    // If no customer_email provided but customer has one on file, use that
    let resolvedEmail = customer_email || '';
    let resolvedName = customer_name || '';
    let resolvedPhone = customer_phone || '';
    if (customer_id) {
      const [customer] = await query('SELECT full_name, phone, email FROM customers WHERE id = ?', [customer_id]);
      if (customer) {
        if (!resolvedEmail) resolvedEmail = customer.email || '';
        if (!resolvedName) resolvedName = customer.full_name || '';
        if (!resolvedPhone) resolvedPhone = customer.phone || '';
      }
    }

    if (!resolvedName || !resolvedPhone) {
      return res.status(400).json({ success: false, message: 'Customer name and phone required' });
    }

    // Coerce empty-string ENUM fields to their defaults (CSV/bulk-import often sends "")
    const VALID_WORK_ORDER_TYPES = ['standard', 'express', 'same_day', 'scheduled', 'warranty'];
    const VALID_SERVICE_CATEGORIES = ['oil_change', 'brake_repair', 'diagnostic', 'bodywork', 'tire_service', 'engine_repair', 'transmission', 'electrical', 'general_maintenance', 'other'];
    const VALID_PAY_METHODS = ['cash', 'prepaid', 'credit', 'wallet'];

    const _work_order_type = (!work_order_type || !VALID_WORK_ORDER_TYPES.includes(work_order_type)) ? 'standard' : work_order_type;
    const _service_category = (!service_category || !VALID_SERVICE_CATEGORIES.includes(service_category)) ? 'general_maintenance' : service_category;
    const _payment_method = (!payment_method || !VALID_PAY_METHODS.includes(payment_method)) ? 'cash' : payment_method;

    // Coerce numeric fields — empty strings from forms must become numbers/null
    const _cash_amount = cash_amount === '' || cash_amount == null ? 0 : parseFloat(cash_amount) || 0;
    const _service_fee = service_fee === '' || service_fee == null ? 0 : parseFloat(service_fee) || 0;
    const _discount     = discount     === '' || discount     == null ? 0 : parseFloat(discount)     || 0;

    // Validate numeric ranges — no negatives and no DB overflow
    if (_cash_amount < 0) {
      return res.status(400).json({ success: false, message: 'Cash amount cannot be negative' });
    }
    if (_service_fee < 0) {
      return res.status(400).json({ success: false, message: 'Service fee cannot be negative' });
    }
    if (_discount < 0) {
      return res.status(400).json({ success: false, message: 'Discount cannot be negative' });
    }
    if (_cash_amount > 99999999) {
      return res.status(400).json({ success: false, message: 'Cash amount is too large' });
    }
    if (_service_fee > 99999999) {
      return res.status(400).json({ success: false, message: 'Service fee is too large' });
    }
    if (_discount > 99999999) {
      return res.status(400).json({ success: false, message: 'Discount is too large' });
    }

    const total_amount = _cash_amount + _service_fee - _discount;

    // ── Financial Engine: commission, VAT, net payout ──
    let finConfig;
    try { finConfig = await getFinancialConfig(req.workshopId); } catch { finConfig = { commissionPercent: 0, vatEnabled: false, vatRate: 0, vatNumber: '', applyVatOnServiceFee: true, applyVatOnCash: false }; }
    const fin = computeWorkOrderFinancials({
      serviceFee: _service_fee,
      discount: _discount,
      cashAmount: _cash_amount,
      config: finConfig,
    });

    const work_order_number = genWorkOrderNumber();

    // ── Use pre-generated token if provided, else generate new one ──
    let service_status_token;
    let pregeneratedTokenId = null;
    if (pregenerated_token) {
      const tokenVal = pregenerated_token.trim().toUpperCase();
      const [pt] = await query(
        'SELECT id, service_status_token, is_used, expires_at FROM pregenerated_tokens WHERE service_status_token = ? AND workshop_id = ?',
        [tokenVal, req.workshopId]
      );
      if (!pt) {
        return res.status(400).json({ success: false, message: 'Pre-generated token not found' });
      }
      if (pt.is_used) {
        return res.status(400).json({ success: false, message: 'This service status token is already linked to a work order' });
      }
      if (pt.expires_at && new Date(pt.expires_at) <= new Date()) {
        return res.status(400).json({ success: false, message: 'This service status token has expired' });
      }
      service_status_token = pt.service_status_token;
      pregeneratedTokenId = pt.id;
    } else {
      service_status_token = crypto.randomBytes(6).toString('hex').toUpperCase();
    }

    const result = await execute(
      `INSERT INTO work_orders (workshop_id, work_order_number, customer_id, vehicle_id, service_bay_id, work_order_type, service_category,
        customer_name, customer_phone, customer_email,
        dropoff_address, dropoff_lat, dropoff_lng, description, special_instructions,
        scheduled_at, payment_method, cash_amount, service_fee, discount, total_amount,
        commission_rate, commission_amount, vat_rate, vat_amount, platform_fee, net_payable,
        status, service_status_token, pregenerated_token_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [req.workshopId, work_order_number, customer_id || null, vehicle_id || null, service_bay_id || null, _work_order_type, _service_category,
       resolvedName, resolvedPhone, resolvedEmail || null,
       dropoff_address || null, dropoff_lat || null, dropoff_lng || null,
       description || null, special_instructions || null, scheduled_at || null,
       _payment_method, _cash_amount, _service_fee, _discount, fin.totalAmount,
       fin.commissionRate, fin.commissionAmount, fin.vatRate, fin.vatAmount, fin.platformFee, fin.netPayable,
       service_status_token, pregeneratedTokenId, notes || null]
    );
    const workOrderId = result.insertId;

    // Mark pre-generated token as used
    if (pregeneratedTokenId) {
      await execute(
        'UPDATE pregenerated_tokens SET is_used = 1, work_order_id = ?, used_at = NOW() WHERE id = ?',
        [workOrderId, pregeneratedTokenId]
      );
    }

    // Insert line items
    for (const item of items) {
      await execute(
        'INSERT INTO work_order_items (work_order_id, name, quantity, unit_price, notes) VALUES (?, ?, ?, ?, ?)',
        [workOrderId, item.name, item.quantity || 1, item.unit_price || 0, item.notes || null]
      );
    }

    // Insert initial status log
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [workOrderId, 'pending', req.user.id, 'Work order created']
    );

    const [workOrder] = await query('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);

    // Send notification for new work order (non-blocking)
    notifyWorkOrderStatus({
      order: workOrder, status: 'pending', workshopId: req.workshopId, changedBy: req.user.id,
    }).catch(e => console.error('[Notify] New work order error:', e.message));

    return res.status(201).json({ success: true, data: workOrder });
  } catch (err) {
    console.error('[WorkOrders] Create error:', err);
    // Return a more descriptive message for common DB errors
    let msg = 'Failed to create work order';
    if (err.code === 'ER_WARN_DATA_OUT_OF_RANGE') {
      msg = 'One or more numeric values are out of range. Please check amounts.';
    } else if (err.code === 'WARN_DATA_TRUNCATED') {
      msg = 'Invalid value for one or more fields. Please check work order type, category, and payment method.';
    } else if (err.code === 'ER_DUP_ENTRY') {
      msg = 'Duplicate work order number generated. Please try again.';
    } else if (err.code === 'ER_NO_REFERENCED_ROW' || err.code === 'ER_NO_REFERENCED_ROW_2') {
      msg = 'Invalid reference: customer, vehicle, service bay, or mechanic does not exist.';
    }
    return res.status(500).json({ success: false, message: msg });
  }
});

/* ── Status transition map (per car_workshop.sql status enum) ─────────
   pending -> confirmed -> assigned -> accepted -> in_progress ->
   ready_for_pickup -> completed / failed / cancelled
   ─────────────────────────────────────────────────────────────────── */
const VALID_TRANSITIONS = {
  pending:          ['confirmed', 'cancelled'],
  confirmed:        ['assigned', 'in_progress', 'cancelled'],
  assigned:         ['accepted', 'in_progress', 'cancelled', 'confirmed'],
  accepted:         ['in_progress', 'cancelled', 'assigned'],
  in_progress:      ['ready_for_pickup', 'failed'],
  ready_for_pickup: ['completed', 'failed'],
  completed:        [],
  failed:           ['confirmed'],
  cancelled:        ['pending'],
};

// PATCH /api/work-orders/:id/status — update work order status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, note, lat, lng } = req.body;
    const validStatuses = ['pending','confirmed','assigned','accepted','in_progress','ready_for_pickup','completed','failed','cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const [workOrder] = await query(
      `SELECT wo.*, c.email AS customer_email_ref
       FROM work_orders wo
       LEFT JOIN customers c ON wo.customer_id = c.id
       WHERE wo.id = ? AND wo.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Validate status transition
    const allowed = VALID_TRANSITIONS[workOrder.status] || [];
    if (workOrder.status !== status && !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot change from "${workOrder.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`,
      });
    }

    // Validate: cannot transition to "assigned" without a mechanic
    if (status === 'assigned' && !workOrder.mechanic_id) {
      return res.status(400).json({
        success: false,
        message: 'Cannot assign work order without a mechanic. Please assign a mechanic first.',
      });
    }

    const timestamps = {};
    if (status === 'in_progress') timestamps.started_at   = new Date();
    if (status === 'completed')   timestamps.completed_at = new Date();
    if (status === 'failed')      timestamps.failed_at    = new Date();
    if (status === 'cancelled')   timestamps.cancelled_at = new Date();

    const setClause = ['status = ?', ...Object.keys(timestamps).map(k => `${k} = ?`)].join(', ');
    const setValues = [status, ...Object.values(timestamps), req.params.id, req.workshopId];

    await execute(`UPDATE work_orders SET ${setClause} WHERE id = ? AND workshop_id = ?`, setValues);
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, status, req.user.id, note || null, lat || null, lng || null]
    );

    // ── AUTO-GENERATE INVOICE WHEN WORK ORDER IS CONFIRMED ──
    if (status === 'confirmed') {
      try {
        const invoice = await createInvoiceFromWorkOrder(req.params.id, req.workshopId, req.user.id);
        if (invoice) {
          console.log(`Invoice ${invoice.invoice_number} auto-created for work order ${workOrder.work_order_number}`);
        }
      } catch (invoiceErr) {
        console.error('Failed to auto-create invoice:', invoiceErr.message);
        // Don't fail the work order status update if invoice creation fails
      }
    }

    // ── SAFETY NET: Also generate invoice when completed if none exists yet ──
    if (status === 'completed') {
      try {
        const invoice = await createInvoiceFromWorkOrder(req.params.id, req.workshopId, req.user.id);
        if (invoice) {
          console.log(`Invoice ${invoice.invoice_number} auto-created on completion for work order ${workOrder.work_order_number}`);
        }
      } catch (invoiceErr) {
        console.error('Failed to auto-create invoice on completion:', invoiceErr.message);
      }
    }

    // If completed, increment mechanic total and auto-mark cash as collected
    if (status === 'completed' && workOrder.mechanic_id) {
      await execute('UPDATE mechanics SET total_jobs_completed = total_jobs_completed + 1 WHERE id = ?', [workOrder.mechanic_id]);

      // Auto-record mechanic earning
      recordMechanicEarning({
        workshopId: req.workshopId, mechanicId: workOrder.mechanic_id, workOrderId: workOrder.id,
        serviceFee: parseFloat(workOrder.service_fee) || 0,
        cashAmount: parseFloat(workOrder.cash_amount) || 0,
      }).catch(e => console.error('[WorkOrders] earning record error:', e.message));
    }
    if (status === 'completed' && workOrder.payment_method === 'cash') {
      await execute('UPDATE work_orders SET cash_collected = cash_amount WHERE id = ? AND workshop_id = ?', [workOrder.id, req.workshopId]);
    }

    // Release mechanic back to available when work order reaches a terminal status
    if (['completed','failed','cancelled'].includes(status) && workOrder.mechanic_id) {
      const stillActive = await query(
        "SELECT id FROM work_orders WHERE mechanic_id = ? AND id != ? AND status IN ('assigned','accepted','in_progress') LIMIT 1",
        [workOrder.mechanic_id, workOrder.id]
      );
      if (!stillActive.length) {
        await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [workOrder.mechanic_id]);
      }
    }

    // ── Unified notifications: SMS + Email + Push + Socket.io ──
    // Enrich work order with mechanic info for notification templates
    let enrichedOrder = { ...workOrder };
    if (workOrder.mechanic_id) {
      const [mechanicInfo] = await query('SELECT full_name, phone FROM mechanics WHERE id = ?', [workOrder.mechanic_id]).catch(() => []);
      if (mechanicInfo) {
        enrichedOrder.mechanic_name = mechanicInfo.full_name;
        enrichedOrder.mechanic_phone = mechanicInfo.phone;
      }
    }
    // Fire all notification channels (non-blocking)
    notifyWorkOrderStatus({
      order: enrichedOrder, status, workshopId: req.workshopId, changedBy: req.user.id,
    }).catch(e => console.error('[Notify] Error:', e.message));

    // Fire outbound webhooks (non-blocking)
    const webhookEvent = workOrderStatusToEvent(status);
    if (webhookEvent) {
      dispatchWebhook({ tenantId: req.workshopId, event: webhookEvent, data: enrichedOrder });
    }

    return res.json({ success: true, message: `Work order ${status}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// PATCH /api/work-orders/:id/assign-mechanic — assign a mechanic to a work order
router.patch('/:id/assign-mechanic', async (req, res) => {
  try {
    const { mechanic_id } = req.body;
    if (!mechanic_id) return res.status(400).json({ success: false, message: 'mechanic_id required' });

    const [workOrder] = await query(
      'SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const [mechanic] = await query(
      'SELECT id, full_name FROM mechanics WHERE id = ? AND workshop_id = ?',
      [mechanic_id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    await execute(
      "UPDATE work_orders SET mechanic_id = ?, status = CASE WHEN status IN ('pending','confirmed') THEN 'assigned' ELSE status END WHERE id = ? AND workshop_id = ?",
      [mechanic_id, req.params.id, req.workshopId]
    );

    // NOTE: Mechanic stays in current status until they explicitly accept.
    // Status changes to 'busy' in POST /api/mechanic-app/work-orders/:id/accept

    // Track assignment in work_order_assignments table (for assigned_at timestamp)
    await execute('UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ?', [req.params.id]);
    await execute(
      'INSERT INTO work_order_assignments (work_order_id, mechanic_id, assigned_by, assigned_at, is_current) VALUES (?, ?, ?, NOW(), TRUE)',
      [req.params.id, mechanic_id, req.user.id]
    );

    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [req.params.id, 'assigned', req.user.id, `Assigned to mechanic: ${mechanic.full_name}`]
    );

    // AUTO-GENERATE INVOICE WHEN WORK ORDER BECOMES CONFIRMED
    if (workOrder.status === 'pending') {
      try {
        const invoice = await createInvoiceFromWorkOrder(req.params.id, req.workshopId, req.user.id);
        if (invoice) {
          console.log(`Invoice ${invoice.invoice_number} auto-created for work order ${workOrder.id}`);
        }
      } catch (invoiceErr) {
        console.error('Failed to auto-create invoice:', invoiceErr.message);
        // Don't fail the assignment if invoice creation fails
      }
    }

    // Notify mechanic via push notification (FCM + Web Push) + email + SMS to customer
    notifyMechanicAssigned({ order: workOrder, driver: mechanic, tenantId: req.workshopId })
      .catch(e => console.error('[assign-mechanic] notify error:', e.message));

    return res.json({ success: true, message: `Work order assigned to ${mechanic.full_name}`, mechanic_id });
  } catch (err) {
    console.error('[assign-mechanic]', err.message, err.stack?.split('\n')[1]);
    return res.status(500).json({ success: false, message: 'Failed to assign mechanic' });
  }
});

// PUT /api/work-orders/:id
router.put('/:id', async (req, res) => {
  try {
    const {
      vehicle_id, service_bay_id, work_order_type, service_category,
      customer_name, customer_phone, customer_email,
      dropoff_address, dropoff_lat, dropoff_lng,
      description, special_instructions, payment_method,
      cash_amount, service_fee, discount, scheduled_at, notes,
    } = req.body;

    if (!customer_name || !customer_phone) {
      return res.status(400).json({ success: false, message: 'Customer name and phone required' });
    }

    // Validate ENUM fields (same whitelist as POST)
    const VALID_WORK_ORDER_TYPES = ['standard', 'express', 'same_day', 'scheduled', 'warranty'];
    const VALID_SERVICE_CATEGORIES = ['oil_change', 'brake_repair', 'diagnostic', 'bodywork', 'tire_service', 'engine_repair', 'transmission', 'electrical', 'general_maintenance', 'other'];
    const VALID_PAY_METHODS = ['cash', 'prepaid', 'credit', 'wallet'];

    const _work_order_type = (!work_order_type || !VALID_WORK_ORDER_TYPES.includes(work_order_type)) ? 'standard' : work_order_type;
    const _service_category = (!service_category || !VALID_SERVICE_CATEGORIES.includes(service_category)) ? 'general_maintenance' : service_category;
    const _payment_method = (!payment_method || !VALID_PAY_METHODS.includes(payment_method)) ? 'cash' : payment_method;

    // Coerce numeric fields (same as POST)
    const _cash_amount = cash_amount === '' || cash_amount == null ? 0 : parseFloat(cash_amount) || 0;
    const _service_fee = service_fee === '' || service_fee == null ? 0 : parseFloat(service_fee) || 0;
    const _discount     = discount     === '' || discount     == null ? 0 : parseFloat(discount)     || 0;

    if (_cash_amount > 99999999) return res.status(400).json({ success: false, message: 'Cash amount is too large' });
    if (_service_fee > 99999999) return res.status(400).json({ success: false, message: 'Service fee is too large' });
    if (_discount > 99999999)    return res.status(400).json({ success: false, message: 'Discount is too large' });

    const total_amount = _cash_amount + _service_fee - _discount;

    // ── Financial Engine: commission, VAT, net payout ──
    let finConfig;
    try { finConfig = await getFinancialConfig(req.workshopId); } catch { finConfig = { commissionPercent: 0, vatEnabled: false, vatRate: 0, vatNumber: '', applyVatOnServiceFee: true, applyVatOnCash: false }; }
    const fin = computeWorkOrderFinancials({
      serviceFee: _service_fee,
      discount: _discount,
      cashAmount: _cash_amount,
      config: finConfig,
    });

    await execute(
      `UPDATE work_orders SET
        vehicle_id=?, service_bay_id=?, work_order_type=?, service_category=?,
        customer_name=?, customer_phone=?, customer_email=?,
        dropoff_address=?, dropoff_lat=?, dropoff_lng=?,
        description=?, special_instructions=?, payment_method=?,
        cash_amount=?, service_fee=?, discount=?, total_amount=?,
        commission_rate=?, commission_amount=?, vat_rate=?, vat_amount=?, platform_fee=?, net_payable=?,
        scheduled_at=?, notes=?
       WHERE id = ? AND workshop_id = ?`,
      [vehicle_id || null, service_bay_id || null, _work_order_type, _service_category,
       customer_name, customer_phone, customer_email || null,
       dropoff_address || null, dropoff_lat || null, dropoff_lng || null,
       description || null, special_instructions || null, _payment_method,
       _cash_amount, _service_fee, _discount, fin.totalAmount,
       fin.commissionRate, fin.commissionAmount, fin.vatRate, fin.vatAmount, fin.platformFee, fin.netPayable,
       scheduled_at || null, notes || null, req.params.id, req.workshopId]
    );

    const [workOrder] = await query('SELECT * FROM work_orders WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: workOrder });
  } catch (err) {
    console.error('[WorkOrders] Update error:', err);
    let msg = 'Failed to update work order';
    if (err.code === 'ER_WARN_DATA_OUT_OF_RANGE') {
      msg = 'One or more numeric values are out of range.';
    } else if (err.code === 'WARN_DATA_TRUNCATED') {
      msg = 'Invalid value for one or more fields. Please check work order type, category, and payment method.';
    }
    return res.status(500).json({ success: false, message: msg });
  }
});

/* ── Work order items management ─────────────────────────────────────── */

// GET /api/work-orders/:id/items — list items for a work order
router.get('/:id/items', async (req, res) => {
  try {
    const [workOrder] = await query('SELECT id FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });
    const items = await query('SELECT * FROM work_order_items WHERE work_order_id = ?', [req.params.id]);
    return res.json({ success: true, data: items });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch items' });
  }
});

// POST /api/work-orders/:id/items — add item to a work order
router.post('/:id/items', async (req, res) => {
  try {
    const [workOrder] = await query('SELECT id FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });
    const { name, quantity = 1, unit_price = 0, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Item name required' });
    const result = await execute(
      'INSERT INTO work_order_items (work_order_id, name, quantity, unit_price, notes) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, name, parseInt(quantity) || 1, parseFloat(unit_price) || 0, notes || null]
    );
    const [item] = await query('SELECT * FROM work_order_items WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: item });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to add item' });
  }
});

// PUT /api/work-orders/:id/items/:itemId — update a work order item
router.put('/:id/items/:itemId', async (req, res) => {
  try {
    const [workOrder] = await query('SELECT id FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });
    const { name, quantity, unit_price, notes } = req.body;
    await execute(
      'UPDATE work_order_items SET name=?, quantity=?, unit_price=?, notes=? WHERE id = ? AND work_order_id = ?',
      [name, parseInt(quantity) || 1, parseFloat(unit_price) || 0, notes || null, req.params.itemId, req.params.id]
    );
    const [item] = await query('SELECT * FROM work_order_items WHERE id = ?', [req.params.itemId]);
    return res.json({ success: true, data: item });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update item' });
  }
});

// DELETE /api/work-orders/:id/items/:itemId — remove a work order item
router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    const [workOrder] = await query('SELECT id FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });
    await execute('DELETE FROM work_order_items WHERE id = ? AND work_order_id = ?', [req.params.itemId, req.params.id]);
    return res.json({ success: true, message: 'Item removed' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to remove item' });
  }
});

// DELETE /api/work-orders/:id — soft-delete (archive) a work order
router.delete('/:id', async (req, res) => {
  try {
    const [workOrder] = await query(
      "SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ?",
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const nonDeletable = ['in_progress'];
    if (nonDeletable.includes(workOrder.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot archive a work order with status '${workOrder.status}'`,
      });
    }

    await execute(
      "UPDATE work_orders SET status = 'cancelled' WHERE id = ? AND workshop_id = ?",
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Work order cancelled/archived' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to archive work order' });
  }
});

// POST /api/work-orders/:id/rate-mechanic — submit 1-5 star rating for the mechanic
router.post('/:id/rate-mechanic', async (req, res) => {
  try {
    const rating = parseInt(req.body.rating);
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    // Validate optional comment (max 500 chars, strip HTML)
    let comment = null;
    if (req.body.comment != null && String(req.body.comment).trim()) {
      comment = String(req.body.comment).trim().replace(/<[^>]*>/g, '').slice(0, 500);
    }

    const [workOrder] = await query(
      'SELECT id, mechanic_id, status, mechanic_rating FROM work_orders WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (workOrder.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Can only rate completed work orders' });
    }
    if (workOrder.mechanic_rating) {
      return res.status(409).json({ success: false, message: 'Work order has already been rated' });
    }
    if (!workOrder.mechanic_id) {
      return res.status(400).json({ success: false, message: 'No mechanic assigned to this work order' });
    }

    // Save rating + optional comment on the work order
    await execute(
      'UPDATE work_orders SET mechanic_rating = ?, review_comment = ?, mechanic_rated_at = NOW() WHERE id = ?',
      [rating, comment, workOrder.id]
    );

    // Recalculate mechanic's average rating
    const [avg] = await query(
      'SELECT AVG(mechanic_rating) as avg_rating, COUNT(*) as total FROM work_orders WHERE mechanic_id = ? AND mechanic_rating IS NOT NULL',
      [workOrder.mechanic_id]
    );
    if (avg?.avg_rating != null) {
      await execute(
        'UPDATE mechanics SET rating = ? WHERE id = ?',
        [parseFloat(avg.avg_rating).toFixed(2), workOrder.mechanic_id]
      );
    }

    return res.json({ success: true, message: 'Rating submitted', rating, mechanic_id: workOrder.mechanic_id });
  } catch (err) {
    console.error('Rate mechanic error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit rating' });
  }
});

export default router;
