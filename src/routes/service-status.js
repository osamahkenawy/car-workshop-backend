import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendSMS, interpolate } from '../lib/sms.js';
import { notifyWorkOrderStatus, notifyCashCollected } from '../lib/notify.js';
import { publicTrackingLimiter } from '../lib/rate-limits.js';

const router = express.Router();

/**
 * Ported from delivery-service-backend/src/routes/tracking.js -> service-status.js
 *
 * Customer-facing vehicle SERVICE STATUS tracking (was package/order tracking).
 * `tracking_token` -> `service_status_token`; the public GET/:token endpoint
 * requires NO auth (customers use it to check on their vehicle).
 *
 * Status enum kept as the car_workshop.sql work_orders enum:
 *   pending, confirmed, assigned, accepted, in_progress, ready_for_pickup,
 *   completed, failed, cancelled
 * (delivery-only statuses picked_up/in_transit/delivered/returned dropped —
 * see car_workshop.sql comment above the work_orders table).
 */

// GET /api/service-status/my-orders — MECHANIC: my assigned work orders (authenticated)
router.get('/my-orders', authMiddleware, async (req, res) => {
  try {
    // Find mechanic record linked to this user
    const [mechanic] = await query(
      'SELECT id, full_name, status FROM mechanics WHERE user_id = ? AND workshop_id = ?',
      [req.user.id, req.workshopId]
    );
    if (!mechanic) {
      return res.status(404).json({ success: false, message: 'No mechanic profile linked to your account' });
    }

    const { status: filterStatus } = req.query;
    let statusFilter = "('assigned','accepted','in_progress','ready_for_pickup')"; // active by default
    if (filterStatus === 'completed') statusFilter = "('completed')";
    else if (filterStatus === 'failed')    statusFilter = "('failed','cancelled')";
    else if (filterStatus === 'all')       statusFilter = "('assigned','accepted','in_progress','ready_for_pickup','completed','failed','cancelled')";

    const orders = await query(
      `SELECT o.id, o.work_order_number, o.service_status_token, o.status, o.work_order_type,
              o.customer_name, o.customer_phone, o.customer_email,
              o.dropoff_address, o.dropoff_lat, o.dropoff_lng,
              o.payment_method, o.cash_amount, o.service_fee,
              o.service_category, o.special_instructions, o.notes,
              o.started_at, o.completed_at, o.failed_at,
              o.completion_photo_url, o.signature_url,
              o.created_at, sb.name as service_bay_name, c.full_name as customer_full_name
       FROM work_orders o
       LEFT JOIN service_bays sb ON o.service_bay_id = sb.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.mechanic_id = ? AND o.workshop_id = ? AND o.status IN ${statusFilter}
       ORDER BY FIELD(o.status, 'in_progress','ready_for_pickup','assigned','completed','failed','cancelled'), o.created_at DESC`,
      [mechanic.id, req.workshopId]
    );

    // Attach parts list to each order
    for (const order of orders) {
      try {
        order.parts = await query(
          'SELECT id, part_number, name, quantity, unit_cost, total_cost, status FROM parts WHERE work_order_id = ? AND workshop_id = ? ORDER BY id ASC',
          [order.id, req.workshopId]
        );
      } catch (_) { order.parts = []; }
    }

    // Quick stats — today (active = all current, completed/failed/revenue = today by completed_at/failed_at)
    const [statsRow] = await query(
      `SELECT
        SUM(CASE WHEN status IN ('assigned','accepted','in_progress','ready_for_pickup') THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'completed' AND DATE(completed_at) = CURDATE() THEN 1 ELSE 0 END) as completed_today,
        SUM(CASE WHEN status = 'failed' AND DATE(failed_at) = CURDATE() THEN 1 ELSE 0 END) as failed_today,
        SUM(CASE WHEN status = 'completed' AND DATE(completed_at) = CURDATE() THEN service_fee ELSE 0 END) as revenue_today
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );

    // Use mechanic_earnings for accurate today revenue if available
    let todayEarnings = 0;
    try {
      const [earnRow] = await query(
        `SELECT COALESCE(SUM(net_amount), 0) as total FROM mechanic_earnings WHERE mechanic_id = ? AND workshop_id = ? AND DATE(created_at) = CURDATE()`,
        [mechanic.id, req.workshopId]
      );
      if (parseFloat(earnRow?.total) > 0) todayEarnings = parseFloat(earnRow.total);
    } catch (_) {}
    if (todayEarnings > 0) statsRow.revenue_today = todayEarnings;

    // All-time stats
    const [allTime] = await query(
      `SELECT
        COUNT(*) as total_orders,
        SUM(status = 'completed') as total_completed,
        SUM(status = 'failed') as total_failed,
        SUM(CASE WHEN status = 'completed' THEN service_fee ELSE 0 END) as total_revenue
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );

    // Use mechanic_earnings for accurate all-time revenue if available
    try {
      const [allEarn] = await query(
        `SELECT COALESCE(SUM(net_amount), 0) as total FROM mechanic_earnings WHERE mechanic_id = ? AND workshop_id = ?`,
        [mechanic.id, req.workshopId]
      );
      if (parseFloat(allEarn?.total) > 0) allTime.total_revenue = parseFloat(allEarn.total);
    } catch (_) {}

    // Tab counts — all-time counts matching actually displayed orders per tab
    const [tabCounts] = await query(
      `SELECT
        SUM(status IN ('assigned','accepted','in_progress','ready_for_pickup')) as active,
        SUM(status = 'completed') as completed,
        SUM(status IN ('failed','cancelled')) as failed
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        mechanic: { id: mechanic.id, name: mechanic.full_name, status: mechanic.status },
        orders,
        stats: {
          active:    parseInt(statsRow?.active || 0),
          completed: parseInt(statsRow?.completed_today || 0),
          failed:    parseInt(statsRow?.failed_today || 0),
          revenue:   parseFloat(statsRow?.revenue_today || 0),
        },
        tabCounts: {
          active:    parseInt(tabCounts?.active || 0),
          completed: parseInt(tabCounts?.completed || 0),
          failed:    parseInt(tabCounts?.failed || 0),
        },
        allTimeStats: {
          total_orders:     parseInt(allTime?.total_orders || 0),
          total_completed:  parseInt(allTime?.total_completed || 0),
          total_failed:     parseInt(allTime?.total_failed || 0),
          total_revenue:    parseFloat(allTime?.total_revenue || 0),
        },
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to load mechanic work orders' });
  }
});

// GET /api/service-status/:token — PUBLIC (no auth needed for customers)
router.get('/:token', publicTrackingLimiter, async (req, res) => {
  try {
    const [order] = await query(
      `SELECT o.work_order_number, o.status, o.work_order_type, o.customer_name,
              o.dropoff_address, o.dropoff_lat, o.dropoff_lng, o.scheduled_at,
              o.started_at, o.completed_at, o.estimated_completion_at,
              o.payment_method, o.cash_amount, o.service_fee,
              m.full_name as mechanic_name, m.phone as mechanic_phone,
              sb.name as service_bay_name
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       LEFT JOIN service_bays sb ON o.service_bay_id = sb.id
       WHERE o.service_status_token = ?`,
      [req.params.token]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Service status token not found' });

    // SR-08 — this endpoint is unauthenticated: anyone holding the link sees
    // this payload. The customer has a real need to phone the mechanic working
    // on their car, so the number stays available while the job is live, but is
    // withheld once the job is closed. Otherwise a link that gets forwarded or
    // sits in a mailbox exposes an employee's personal number indefinitely.
    // To withhold it entirely, drop the column from the SELECT above.
    const ACTIVE_FOR_CONTACT = new Set(['assigned', 'accepted', 'in_progress', 'ready_for_pickup']);
    if (!ACTIVE_FOR_CONTACT.has(String(order.status))) {
      delete order.mechanic_phone;
    }

    const statusLogs = await query(
      'SELECT status, note, lat, lng, created_at FROM work_order_status_logs WHERE work_order_id = (SELECT id FROM work_orders WHERE service_status_token = ?) ORDER BY created_at ASC',
      [req.params.token]
    );

    // Completion photos (proof of work done)
    let completionPhotos = [];
    try {
      completionPhotos = await query(
        `SELECT cp.photo_url, cp.photo_type, cp.caption, cp.uploaded_at
         FROM completion_photos cp JOIN work_orders wo ON cp.work_order_id = wo.id
         WHERE wo.service_status_token = ? ORDER BY cp.uploaded_at ASC`,
        [req.params.token]
      );
    } catch (_) {}

    // Parts used on this work order
    let parts = [];
    try {
      parts = await query(
        `SELECT p.part_number, p.name, p.description, p.quantity, p.status
         FROM parts p JOIN work_orders o2 ON p.work_order_id = o2.id
         WHERE o2.service_status_token = ? ORDER BY p.id ASC`,
        [req.params.token]
      );
    } catch (_) {}

    return res.json({
      success: true,
      data: {
        ...order,
        status_logs: statusLogs,
        completion_photos: completionPhotos,
        parts,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Service status lookup failed' });
  }
});

// GET /api/service-status — search by work order number (authenticated)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { work_order_number } = req.query;
    if (!work_order_number) return res.status(400).json({ success: false, message: 'work_order_number required' });
    const [order] = await query(
      'SELECT id, work_order_number, service_status_token, status FROM work_orders WHERE work_order_number = ? AND workshop_id = ?',
      [work_order_number, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    return res.json({ success: true, data: order });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
});

// GET /api/service-status/:token/order — MECHANIC: full work order data (authenticated)
// Supports BOTH service status tokens AND part_number scans
router.get('/:token/order', authMiddleware, async (req, res) => {
  try {
    const token = req.params.token;
    let scannedPartId = null;

    // 1. Try work order service_status_token first
    let [order] = await query(
      `SELECT o.*,
              m.full_name as mechanic_name, m.phone as mechanic_phone,
              sb.name as service_bay_name,
              c.full_name as customer_full_name
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       LEFT JOIN service_bays sb ON o.service_bay_id = sb.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.service_status_token = ? AND o.workshop_id = ?`,
      [token, req.workshopId]
    );

    // 2. If not found, try part_number lookup
    if (!order) {
      const [part] = await query(
        `SELECT p.*, o2.service_status_token as order_token
         FROM parts p JOIN work_orders o2 ON p.work_order_id = o2.id
         WHERE p.part_number = ? AND p.workshop_id = ?`,
        [token, req.workshopId]
      );
      if (part) {
        scannedPartId = part.id;
        [order] = await query(
          `SELECT o.*,
                  m.full_name as mechanic_name, m.phone as mechanic_phone,
                  sb.name as service_bay_name,
                  c.full_name as customer_full_name
           FROM work_orders o
           LEFT JOIN mechanics m ON o.mechanic_id = m.id
           LEFT JOIN service_bays sb ON o.service_bay_id = sb.id
           LEFT JOIN customers c ON o.customer_id = c.id
           WHERE o.id = ? AND o.workshop_id = ?`,
          [part.work_order_id, req.workshopId]
        );
      }
    }

    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    const items = await query('SELECT * FROM work_order_items WHERE work_order_id = ?', [order.id]);
    const statusLogs = await query(
      'SELECT sl.*, u.full_name as changed_by_name FROM work_order_status_logs sl LEFT JOIN users u ON sl.changed_by = u.id WHERE sl.work_order_id = ? ORDER BY sl.created_at ASC',
      [order.id]
    );
    const scanLogs = await query(
      'SELECT * FROM work_order_scan_logs WHERE work_order_id = ? ORDER BY scanned_at DESC LIMIT 20',
      [order.id]
    ).catch(() => []);
    const parts = await query(
      'SELECT id, part_number, name, description, quantity, unit_cost, total_cost, status FROM parts WHERE work_order_id = ? AND workshop_id = ? ORDER BY id ASC',
      [order.id, req.workshopId]
    ).catch(() => []);

    return res.json({
      success: true,
      data: { ...order, items, status_logs: statusLogs, scan_logs: scanLogs, parts },
      scanned_part_id: scannedPartId,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work order' });
  }
});

// POST /api/service-status/:token/scan — log a scan event (mechanic/service-bay check-in)
// Supports BOTH service status tokens AND part_number scans
router.post('/:token/scan', authMiddleware, async (req, res) => {
  try {
    const { scan_type = 'checkin_scan', lat, lng, note } = req.body;
    const token = req.params.token.trim();

    // 1. Try work order lookup first
    let [order] = await query(
      'SELECT id, workshop_id, work_order_number, status, customer_phone, customer_name FROM work_orders WHERE service_status_token = ? AND workshop_id = ?',
      [token, req.workshopId]
    );

    // 2. If not a work order token, try part_number lookup
    let part = null;
    if (!order) {
      const upperToken = token.toUpperCase();
      [part] = await query(
        `SELECT p.*, o.id as parent_work_order_id, o.work_order_number, o.status as work_order_status,
                o.customer_phone as order_customer_phone, o.customer_name as order_customer_name
         FROM parts p
         JOIN work_orders o ON p.work_order_id = o.id
         WHERE p.part_number = ? AND p.workshop_id = ?`,
        [upperToken, req.workshopId]
      );
      if (part) {
        // Synthesize order reference from part's parent work order
        order = {
          id: part.parent_work_order_id,
          workshop_id: req.workshopId,
          work_order_number: part.work_order_number,
          status: part.work_order_status,
          customer_phone: part.order_customer_phone,
          customer_name: part.order_customer_name,
        };
      }
    }

    if (!order) return res.status(404).json({ success: false, message: 'Work order or part not found for this code' });

    // Log the scan
    await execute(
      `INSERT INTO work_order_scan_logs (work_order_id, workshop_id, scanned_by, scan_type, lat, lng, note, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [order.id, req.workshopId, req.user?.id || null, scan_type, lat || null, lng || null, note || null]
    ).catch(() => {});

    // Auto-status transitions on certain scan types
    let newOrderStatus = null;
    const autoTransitions = {
      bay_in:            { from: ['pending'],                        to: 'confirmed' },
      pickup_scan:       { from: ['assigned','confirmed'],            to: 'in_progress' },
      completion_scan:   { from: ['in_progress','ready_for_pickup'],  to: 'completed' },
    };

    if (autoTransitions[scan_type]) {
      const t = autoTransitions[scan_type];
      if (t.from.includes(order.status)) {
        newOrderStatus = t.to;
      }
    }

    if (newOrderStatus) {
      const timestamps = {};
      if (newOrderStatus === 'in_progress') timestamps.started_at = new Date();
      if (newOrderStatus === 'completed')   timestamps.completed_at = new Date();
      const setClause = ['status = ?', ...Object.keys(timestamps).map(k => `${k} = ?`)].join(', ');
      const vals = [newOrderStatus, ...Object.values(timestamps), order.id, req.workshopId];
      await execute(`UPDATE work_orders SET ${setClause} WHERE id = ? AND workshop_id = ?`, vals);
      await execute(
        'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
        [order.id, newOrderStatus, req.user?.id || null, `Auto-updated via ${scan_type}`]
      );
    }

    return res.json({
      success: true,
      data: {
        work_order_id: order.id,
        work_order_number: order.work_order_number,
        scan_type,
        new_status: newOrderStatus,
        part: part ? { id: part.id, part_number: part.part_number } : null,
      },
      message: newOrderStatus ? `Scanned – status updated to ${newOrderStatus}` : 'Scan logged',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Scan failed' });
  }
});

/* ── Status transition map (mechanic-side) ──────────────────────
   Kept aligned with car_workshop.sql work_orders.status enum:
   pending, confirmed, assigned, accepted, in_progress, ready_for_pickup,
   completed, failed, cancelled */
const MECHANIC_TRANSITIONS = {
  pending:           ['confirmed', 'cancelled'],
  confirmed:         ['assigned', 'cancelled'],
  assigned:          ['accepted', 'in_progress', 'cancelled'],
  accepted:          ['in_progress', 'cancelled'],
  in_progress:       ['ready_for_pickup', 'failed'],
  ready_for_pickup:  ['completed', 'failed'],
  completed:         [],
  failed:            ['confirmed'],
  cancelled:         [],
};

// PATCH /api/service-status/:token/status — MECHANIC: update status by token (authenticated)
// Supports BOTH service status tokens AND part_number scans
router.patch('/:token/status', authMiddleware, async (req, res) => {
  try {
    const { status, note, lat, lng, cash_collected_amount } = req.body;
    const validStatuses = ['confirmed','assigned','accepted','in_progress','ready_for_pickup','completed','failed','cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const token = req.params.token.trim();

    // 1. Try work order lookup first
    let [order] = await query(
      `SELECT o.*, c.email AS customer_email
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.service_status_token = ? AND o.workshop_id = ?`,
      [token, req.workshopId]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Validate status transition
    const allowed = MECHANIC_TRANSITIONS[order.status] || [];
    if (order.status !== status && !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot change from "${order.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`,
      });
    }

    const timestamps = {};
    if (status === 'in_progress') timestamps.started_at = new Date();
    if (status === 'completed')   timestamps.completed_at = new Date();
    if (status === 'failed')      timestamps.failed_at = new Date();
    if (status === 'cancelled')   timestamps.cancelled_at = new Date();

    // Handle cash collection on completion
    const extraFields = {};
    if (status === 'completed' && order.payment_method === 'cash') {
      extraFields.cash_collected = order.cash_amount || 0;
      extraFields.cash_collected_at = new Date();
      if (cash_collected_amount != null && parseFloat(cash_collected_amount) > 0) {
        extraFields.cash_amount = parseFloat(cash_collected_amount);
        extraFields.cash_collected = parseFloat(cash_collected_amount);
      }
      extraFields.payment_status = 'paid';
    }

    const allFields = { ...timestamps, ...extraFields };
    const setClause = ['status = ?', ...Object.keys(allFields).map(k => `${k} = ?`)].join(', ');
    await execute(
      `UPDATE work_orders SET ${setClause} WHERE id = ? AND workshop_id = ?`,
      [status, ...Object.values(allFields), order.id, req.workshopId]
    );
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, status, req.user?.id || null, note || null, lat || null, lng || null]
    );

    // If completed, increment mechanic total jobs completed
    if (status === 'completed' && order.mechanic_id) {
      await execute('UPDATE mechanics SET total_jobs_completed = total_jobs_completed + 1 WHERE id = ?', [order.mechanic_id]);
    }

    // Release mechanic back to available when work order reaches terminal status
    if (['completed','failed','cancelled'].includes(status) && order.mechanic_id) {
      const stillActive = await query(
        "SELECT id FROM work_orders WHERE mechanic_id = ? AND id != ? AND status IN ('assigned','accepted','in_progress','ready_for_pickup') LIMIT 1",
        [order.mechanic_id, order.id]
      );
      if (!stillActive.length) {
        await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [order.mechanic_id]);
        // Auto-cleanup GPS tracking data when mechanic has no more active work orders
        await execute('DELETE FROM mechanic_locations WHERE mechanic_id = ?', [order.mechanic_id]).catch(() => {});
      }
    }

    // ── Unified notifications: SMS + Email + Push + Socket.io ──
    let enrichedOrder = { ...order };
    if (order.mechanic_id) {
      const [mechanicInfo] = await query('SELECT full_name, phone FROM mechanics WHERE id = ?', [order.mechanic_id]).catch(() => []);
      if (mechanicInfo) {
        enrichedOrder.mechanic_name = mechanicInfo.full_name;
        enrichedOrder.mechanic_phone = mechanicInfo.phone;
      }
    }
    notifyWorkOrderStatus({
      order: enrichedOrder, status, workshopId: req.workshopId, changedBy: req.user?.id,
    }).catch(e => console.error('[Notify] Error:', e.message));

    // Cash collection notification
    if (status === 'completed' && cash_collected_amount != null && parseFloat(cash_collected_amount) > 0) {
      notifyCashCollected({
        order: enrichedOrder, amount: cash_collected_amount, tenantId: req.workshopId,
      }).catch(() => {});
    }

    return res.json({ success: true, message: `Work order marked as ${status}`, new_status: status });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Status update failed' });
  }
});

// POST /api/service-status/start-day — MECHANIC: batch-start all assigned work orders (assigned -> in_progress)
router.post('/start-trip', authMiddleware, async (req, res) => {
  try {
    const [mechanic] = await query(
      'SELECT id, full_name FROM mechanics WHERE user_id = ? AND workshop_id = ?',
      [req.user.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'No mechanic profile' });

    const assignedOrders = await query(
      "SELECT id, work_order_number, service_status_token, customer_phone, customer_name, mechanic_id " +
      "FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND status = 'assigned'",
      [mechanic.id, req.workshopId]
    );
    if (!assignedOrders.length) {
      return res.json({ success: true, message: 'No assigned work orders to start', started: 0 });
    }

    const now = new Date();
    const { lat, lng } = req.body || {};

    for (const order of assignedOrders) {
      await execute(
        "UPDATE work_orders SET status = 'in_progress', started_at = ? WHERE id = ? AND workshop_id = ?",
        [now, order.id, req.workshopId]
      );
      await execute(
        'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
        [order.id, 'in_progress', req.user.id, 'Batch start — work started', lat || null, lng || null]
      );

      // Fire notification
      notifyWorkOrderStatus({
        order: { ...order, mechanic_name: mechanic.full_name },
        status: 'in_progress', workshopId: req.workshopId, changedBy: req.user.id,
      }).catch(() => {});
    }

    return res.json({
      success: true,
      message: `Work started! ${assignedOrders.length} work order(s) in progress`,
      started: assignedOrders.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to start work' });
  }
});

// POST /api/service-status/:token/send-sms — send the service status link via SMS to the customer
router.post('/:token/send-sms', authMiddleware, async (req, res) => {
  try {
    const token = req.params.token.trim();
    const [order] = await query(
      'SELECT id, work_order_number, customer_phone, customer_name FROM work_orders WHERE service_status_token = ? AND workshop_id = ?',
      [token, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (!order.customer_phone) return res.status(400).json({ success: false, message: 'No customer phone on file' });

    const baseUrl = process.env.FRONTEND_URL || process.env.BASE_URL || 'https://app.pioneercarservice.com';
    const link = `${baseUrl}/service-status/${token}`;
    const message = interpolate(
      'Hi {customer_name}, track your vehicle service status here: {link}',
      { customer_name: order.customer_name || 'Customer', link }
    );

    const result = await sendSMS({ to: order.customer_phone, message, workshopId: req.workshopId });

    return res.json({ success: true, message: 'Service status link sent via SMS', data: result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to send SMS' });
  }
});

export default router;
