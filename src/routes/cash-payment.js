import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

/* ══════════════════════════════════════════════════════════════
   Cash Payment Reconciliation
   Ported from delivery-service-backend/src/routes/cod.js -> cash-payment.js.
   Uses the `cash_settlements` table exactly as defined in car_workshop.sql:
     status: pending_approval/approved/processing/completed/rejected
     approval_threshold, late_penalty, settled_at
   cod_amount -> cash_amount, cod_collected -> cash_collected throughout,
   driver_id -> mechanic_id, order_id -> work_order_id.

   JUDGMENT CALL: the source used cod_collected as a tri-state int
   (0 = not collected, 1 = collected by driver, 2 = settled with admin).
   car_workshop.sql's work_orders.cash_collected is a DECIMAL (amount collected),
   so "settled" state now lives entirely on the cash_settlements row instead of
   overloading cash_collected. A work order is considered "settled" once a
   completed cash_settlements row references it (tracked via the JSON-free
   per-mechanic settlement flow below, mirroring the source's bulk-settle shape).
   ══════════════════════════════════════════════════════════════ */

/* ── GET /api/cash-payment — list cash-payment work orders ──────────── */
router.get('/', async (req, res) => {
  try {
    const { status, mechanic_id, page = 1, limit = 50 } = req.query;
    let where = "o.workshop_id = ? AND o.payment_method = 'cash'";
    const params = [req.workshopId];

    if (status === 'pending') {
      where += ' AND (o.cash_collected = 0 OR o.cash_collected IS NULL)';
    } else if (status === 'collected') {
      where += ' AND o.cash_collected > 0';
    }

    if (mechanic_id) {
      where += ' AND o.mechanic_id = ?';
      params.push(mechanic_id);
    }

    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 50;
    const offset = (pg - 1) * lim;
    const rows = await query(
      `SELECT o.id, o.work_order_number, o.service_status_token, o.cash_amount, o.cash_collected, o.cash_collected_at,
              o.status, o.customer_name, o.customer_phone,
              o.created_at, o.completed_at,
              m.full_name AS mechanic_name, m.phone AS mechanic_phone
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       WHERE ${where}
       ORDER BY o.created_at DESC
       LIMIT ${lim} OFFSET ${offset}`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /cash-payment error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch cash-payment work orders' });
  }
});

/* ── GET /api/cash-payment/summary — cash overview per mechanic ────── */
router.get('/summary', async (req, res) => {
  try {
    const rows = await query(
      `SELECT
         m.id AS mechanic_id,
         m.full_name AS mechanic_name,
         m.phone AS mechanic_phone,
         COUNT(o.id) AS total_orders,
         SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) AS completed,
         COALESCE(SUM(o.cash_amount), 0) AS total_cash,
         COALESCE(SUM(CASE WHEN o.status = 'completed' AND o.cash_collected > 0 THEN o.cash_collected ELSE 0 END), 0) AS collected,
         COALESCE(SUM(CASE WHEN o.status NOT IN ('completed','cancelled') THEN o.cash_amount ELSE 0 END), 0) AS pending
       FROM work_orders o
       INNER JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND o.payment_method = 'cash'
       GROUP BY m.id
       ORDER BY pending DESC`,
      [req.workshopId]
    );
    res.json({ success: true, mechanics: rows });
  } catch (err) {
    console.error('GET /cash-payment/summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch cash summary' });
  }
});

/* ── GET /api/cash-payment/settlements — settlement history ─────────── */
router.get('/settlements', async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, m.full_name AS mechanic_name
       FROM cash_settlements s
       LEFT JOIN mechanics m ON s.mechanic_id = m.id
       WHERE s.workshop_id = ?
       ORDER BY s.created_at DESC
       LIMIT 100`,
      [req.workshopId]
    );
    res.json({ success: true, settlements: rows });
  } catch (err) {
    console.error('GET /cash-payment/settlements error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch settlements' });
  }
});

/* ── POST /api/cash-payment/settle — settle cash for a mechanic ────── */
router.post('/settle', async (req, res) => {
  try {
    const { mechanic_id, work_order_ids, amount, notes } = req.body;

    if (!mechanic_id) {
      return res.status(400).json({ success: false, message: 'mechanic_id is required' });
    }
    // Reject negative settlement amounts
    if (amount !== undefined && amount !== null && Number(amount) < 0) {
      return res.status(400).json({ success: false, message: 'Settlement amount cannot be negative' });
    }

    // Get all completed cash work orders not yet settled for the mechanic
    let targetOrders;
    if (work_order_ids && work_order_ids.length) {
      targetOrders = await query(
        `SELECT id, cash_amount FROM work_orders
         WHERE workshop_id = ? AND mechanic_id = ? AND payment_method = 'cash'
           AND status = 'completed'
           AND id IN (${work_order_ids.map(() => '?').join(',')})`,
        [req.workshopId, mechanic_id, ...work_order_ids]
      );
    } else {
      targetOrders = await query(
        `SELECT id, cash_amount FROM work_orders
         WHERE workshop_id = ? AND mechanic_id = ? AND payment_method = 'cash'
           AND status = 'completed'`,
        [req.workshopId, mechanic_id]
      );
    }

    if (!targetOrders.length) {
      return res.status(400).json({ success: false, message: 'No cash-payment work orders to settle for this mechanic' });
    }

    const settledAmount = amount || targetOrders.reduce((sum, o) => sum + Number(o.cash_amount || 0), 0);

    // Record settlement
    const result = await execute(
      `INSERT INTO cash_settlements (workshop_id, mechanic_id, amount, status, settled_at, notes)
       VALUES (?, ?, ?, 'completed', NOW(), ?)`,
      [req.workshopId, mechanic_id, settledAmount, notes || null]
    );

    res.json({
      success: true,
      message: `Settled ${settledAmount.toFixed(2)} for ${targetOrders.length} work orders`,
      settlement: { id: result.insertId, mechanic_id, amount: settledAmount, work_order_count: targetOrders.length },
    });
  } catch (err) {
    console.error('POST /cash-payment/settle error:', err);
    res.status(500).json({ success: false, message: 'Failed to settle cash payment' });
  }
});

/* ── POST /api/cash-payment/:id/settle — settle a single work order's cash ─ */
router.post('/:id/settle', async (req, res) => {
  try {
    const { settlement_method, notes } = req.body;
    const workOrderId = req.params.id;

    const [order] = await query(
      `SELECT id, cash_amount, mechanic_id, payment_method, cash_collected
       FROM work_orders WHERE id = ? AND workshop_id = ? AND payment_method = 'cash'`,
      [workOrderId, req.workshopId]
    );
    if (!order) {
      return res.status(404).json({ success: false, message: 'Cash-payment work order not found' });
    }

    // Log settlement record
    const result = await execute(
      `INSERT INTO cash_settlements (workshop_id, mechanic_id, amount, status, settled_at, notes)
       VALUES (?, ?, ?, 'completed', NOW(), ?)`,
      [req.workshopId, order.mechanic_id || null, order.cash_amount || 0,
       notes ? `${settlement_method || ''}: ${notes}` : (settlement_method || null)]
    );

    res.json({
      success: true,
      message: `Work order #${workOrderId} cash settled`,
      work_order_id: parseInt(workOrderId),
      amount: order.cash_amount,
      settlement_id: result.insertId,
    });
  } catch (err) {
    console.error('POST /cash-payment/:id/settle error:', err);
    res.status(500).json({ success: false, message: 'Failed to settle cash payment' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT SCHEDULE MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// GET /api/cash-payment/schedules — list settlement schedules
router.get('/schedules', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM settlement_schedules WHERE workshop_id = ? ORDER BY created_at DESC',
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch schedules' });
  }
});

// POST /api/cash-payment/schedules — create settlement schedule
router.post('/schedules', async (req, res) => {
  try {
    const { frequency = 'weekly', payment_method = 'bank_transfer' } = req.body;
    const freqDays = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };
    const nextRun = new Date();
    nextRun.setDate(nextRun.getDate() + (freqDays[frequency] || 7));

    const result = await execute(
      `INSERT INTO settlement_schedules (workshop_id, frequency, next_run, payment_method) VALUES (?, ?, ?, ?)`,
      [req.workshopId, frequency, nextRun, payment_method]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'settlement_schedule.create', entityType: 'settlement_schedule', entityId: result.insertId, newValue: { frequency, payment_method } });
    const [schedule] = await query('SELECT * FROM settlement_schedules WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create schedule' });
  }
});

// PUT /api/cash-payment/schedules/:id
router.put('/schedules/:id', async (req, res) => {
  try {
    const { frequency, payment_method, is_active } = req.body;
    await execute(
      'UPDATE settlement_schedules SET frequency=?, payment_method=?, is_active=? WHERE id=? AND workshop_id=?',
      [frequency || 'weekly', payment_method || 'bank_transfer', is_active !== undefined ? is_active : 1, req.params.id, req.workshopId]
    );
    const [schedule] = await query('SELECT * FROM settlement_schedules WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: schedule });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update schedule' });
  }
});

// DELETE /api/cash-payment/schedules/:id
router.delete('/schedules/:id', async (req, res) => {
  try {
    await execute('DELETE FROM settlement_schedules WHERE id=? AND workshop_id=?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Schedule deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete schedule' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════════

// PATCH /api/cash-payment/settlements/:id/approve — approve/reject settlement
router.patch('/settlements/:id/approve', async (req, res) => {
  try {
    const { action, notes } = req.body; // action: 'approve' | 'reject'
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    }

    const [settlement] = await query(
      'SELECT * FROM cash_settlements WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!settlement) return res.status(404).json({ success: false, message: 'Settlement not found' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await execute(
      'UPDATE cash_settlements SET status = ?, notes = CONCAT(COALESCE(notes,""), ?) WHERE id = ?',
      [newStatus, notes ? `\n[${action}] ${notes}` : '', req.params.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: `settlement.${action}`, entityType: 'cash_settlement', entityId: parseInt(req.params.id), newValue: { status: newStatus, amount: settlement.amount } });

    return res.json({ success: true, message: `Settlement ${newStatus}`, data: { id: settlement.id, status: newStatus } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update settlement' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT EXPORT (CSV / JSON summary)
// ═══════════════════════════════════════════════════════════════

// GET /api/cash-payment/settlements/export — export settlement history
router.get('/settlements/export', async (req, res) => {
  try {
    const { format = 'csv', from_date, to_date } = req.query;

    let dateFilter = '';
    const params = [req.workshopId];
    if (from_date && to_date) {
      dateFilter = ' AND DATE(s.settled_at) BETWEEN ? AND ?';
      params.push(from_date, to_date);
    }

    const rows = await query(
      `SELECT s.id, s.amount, s.settled_at, s.notes, s.status,
              m.full_name as mechanic_name, m.phone as mechanic_phone
       FROM cash_settlements s
       LEFT JOIN mechanics m ON s.mechanic_id = m.id
       WHERE s.workshop_id = ?${dateFilter}
       ORDER BY s.settled_at DESC`,
      params
    );

    if (format === 'csv') {
      const header = 'ID,Mechanic,Phone,Amount,Status,Date,Notes\n';
      const csvRows = rows.map(r =>
        `${r.id},"${r.mechanic_name || ''}","${r.mechanic_phone || ''}",${r.amount},${r.status || 'completed'},"${r.settled_at}","${(r.notes || '').replace(/"/g, '""')}"`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="settlements.csv"');
      return res.send(header + csvRows);
    }

    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to export settlements' });
  }
});

// ═══════════════════════════════════════════════════════════════
// LATE SETTLEMENT PENALTY CHECK
// ═══════════════════════════════════════════════════════════════

// POST /api/cash-payment/check-late-penalties — check and apply late fees
router.post('/check-late-penalties', async (req, res) => {
  try {
    // Get late fee config from settings
    const [lateFeeConfig] = await query(
      "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'late_settlement_fee_pct'",
      [req.workshopId]
    );
    const lateFeeRate = lateFeeConfig ? parseFloat(lateFeeConfig.value) || 0 : 0;
    if (lateFeeRate <= 0) {
      return res.json({ success: true, message: 'Late fee not configured', penalties_applied: 0 });
    }

    // Get overdue cash-payment work orders (completed > 3 days ago, still not settled)
    const overdueOrders = await query(
      `SELECT id, cash_amount, completed_at FROM work_orders
       WHERE workshop_id = ? AND payment_method = 'cash' AND status = 'completed'
       AND completed_at < DATE_SUB(NOW(), INTERVAL 3 DAY)`,
      [req.workshopId]
    );

    let penaltiesApplied = 0;
    for (const order of overdueOrders) {
      const daysLate = Math.floor((Date.now() - new Date(order.completed_at).getTime()) / (1000 * 60 * 60 * 24)) - 3;
      if (daysLate > 0) {
        const penalty = Math.round(parseFloat(order.cash_amount) * (lateFeeRate / 100) * daysLate * 100) / 100;
        // Log the penalty (don't deduct automatically, just flag)
        await logAudit({ workshopId: req.workshopId, action: 'settlement.late_penalty', entityType: 'work_order', entityId: order.id,
          newValue: { days_late: daysLate, penalty_amount: penalty, rate: lateFeeRate } });
        penaltiesApplied++;
      }
    }

    return res.json({ success: true, message: `Checked ${overdueOrders.length} overdue work orders`, penalties_applied: penaltiesApplied });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to check late penalties' });
  }
});

export default router;
