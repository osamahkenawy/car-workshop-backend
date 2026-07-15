import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { getFinancialConfig, computeMechanicEarning } from '../lib/financial.js';

const router = express.Router();
router.use(authMiddleware);

// ═══════════════════════════════════════════════════════════════
// MECHANIC EARNINGS TRACKING
// Ported from delivery-service-backend/src/routes/driver-earnings.js.
// Uses `mechanic_earnings` table exactly as defined in car_workshop.sql:
//   earning_type: labor/tip/bonus/penalty (not 'delivery')
// Renamed driver_id -> mechanic_id, order_id -> work_order_id throughout.
// ═══════════════════════════════════════════════════════════════

// GET /api/mechanic-earnings/my — Mechanic's own earnings (for mobile app)
router.get('/my', async (req, res) => {
  try {
    // Find the mechanic record for the current user
    const [mechanic] = await query('SELECT id FROM mechanics WHERE user_id = ? AND workshop_id = ?', [req.user.id, req.workshopId]);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { date_from, date_to, status: earningStatus, page = 1, limit = 50 } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200);
    const pg = parseInt(page) || 1;
    const offset = (pg - 1) * lim;

    let where = 'me.workshop_id = ? AND me.mechanic_id = ?';
    const params = [req.workshopId, mechanic.id];

    if (earningStatus) { where += ' AND me.status = ?'; params.push(earningStatus); }
    if (date_from) { where += ' AND me.created_at >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND me.created_at <= ?'; params.push(date_to + ' 23:59:59'); }

    const earnings = await query(
      `SELECT me.*, o.work_order_number
       FROM mechanic_earnings me
       LEFT JOIN work_orders o ON me.work_order_id = o.id
       WHERE ${where}
       ORDER BY me.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM mechanic_earnings me WHERE ${where}`, params);

    // Also return a quick summary
    const [summary] = await query(
      `SELECT COALESCE(SUM(me.net_amount), 0) as total_earned,
              SUM(CASE WHEN me.status = 'paid' THEN me.net_amount ELSE 0 END) as total_paid,
              SUM(CASE WHEN me.status = 'pending' THEN me.net_amount ELSE 0 END) as total_pending,
              COUNT(*) as total_entries
       FROM mechanic_earnings me WHERE me.workshop_id = ? AND me.mechanic_id = ?`,
      [req.workshopId, mechanic.id]
    );

    const totalNum = parseInt(total) || 0;
    return res.json({
      success: true,
      data: earnings,
      summary,
      pagination: { page: pg, limit: lim, total: totalNum, pages: Math.max(1, Math.ceil(totalNum / lim)) },
    });
  } catch (err) {
    console.error('Mechanic earnings /my error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch your earnings' });
  }
});

// GET /api/mechanic-earnings — list earnings for mechanics (admin)
router.get('/', async (req, res) => {
  try {
    const { mechanic_id, status, date_from, date_to, page = 1, limit = 50 } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200);
    const pg = parseInt(page) || 1;
    const offset = (pg - 1) * lim;

    let where = 'me.workshop_id = ?';
    const params = [req.workshopId];

    if (mechanic_id) { where += ' AND me.mechanic_id = ?'; params.push(mechanic_id); }
    if (status) { where += ' AND me.status = ?'; params.push(status); }
    if (date_from) { where += ' AND me.created_at >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND me.created_at <= ?'; params.push(date_to + ' 23:59:59'); }

    const earnings = await query(
      `SELECT me.*, m.full_name as mechanic_name, m.phone as mechanic_phone, o.work_order_number
       FROM mechanic_earnings me
       LEFT JOIN mechanics m ON me.mechanic_id = m.id
       LEFT JOIN work_orders o ON me.work_order_id = o.id
       WHERE ${where}
       ORDER BY me.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM mechanic_earnings me WHERE ${where}`, params);

    const totalNum = parseInt(total) || 0;
    return res.json({
      success: true,
      data: earnings,
      pagination: { page: pg, limit: lim, total: totalNum, pages: Math.max(1, Math.ceil(totalNum / lim)) },
    });
  } catch (err) {
    console.error('Mechanic earnings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch mechanic earnings' });
  }
});

// GET /api/mechanic-earnings/summary — summary per mechanic
router.get('/summary', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let dateFilter = '';
    const params = [req.workshopId];
    if (date_from && date_to) {
      dateFilter = ' AND me.created_at BETWEEN ? AND ?';
      params.push(date_from, date_to + ' 23:59:59');
    }

    const summary = await query(
      `SELECT me.mechanic_id, m.full_name as mechanic_name,
        COUNT(me.id) as total_entries,
        COALESCE(SUM(me.base_amount), 0) as total_base,
        COALESCE(SUM(me.bonus), 0) as total_bonus,
        COALESCE(SUM(me.deductions), 0) as total_deductions,
        COALESCE(SUM(me.net_amount), 0) as total_net,
        SUM(CASE WHEN me.status = 'paid' THEN me.net_amount ELSE 0 END) as total_paid,
        SUM(CASE WHEN me.status = 'pending' THEN me.net_amount ELSE 0 END) as total_pending
       FROM mechanic_earnings me
       LEFT JOIN mechanics m ON me.mechanic_id = m.id
       WHERE me.workshop_id = ?${dateFilter}
       GROUP BY me.mechanic_id ORDER BY total_net DESC`,
      params
    );

    return res.json({ success: true, data: summary });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch earnings summary' });
  }
});

// POST /api/mechanic-earnings — record earning for a work order
router.post('/', async (req, res) => {
  try {
    const { mechanic_id, work_order_id, earning_type = 'labor', base_amount, bonus = 0, deductions = 0, notes } = req.body;
    if (!mechanic_id || !base_amount) return res.status(400).json({ success: false, message: 'mechanic_id and base_amount are required' });

    const netAmount = parseFloat(base_amount) + parseFloat(bonus) - parseFloat(deductions);

    const result = await execute(
      `INSERT INTO mechanic_earnings (workshop_id, mechanic_id, work_order_id, earning_type, amount, base_amount, bonus, deductions, net_amount, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, mechanic_id, work_order_id || null, earning_type, netAmount, base_amount, bonus, deductions, netAmount, 'pending', notes || null]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'mechanic_earning.created', entityType: 'mechanic_earning', entityId: result.insertId,
      newValue: { mechanic_id, work_order_id, net_amount: netAmount } });

    return res.status(201).json({ success: true, data: { id: result.insertId, net_amount: netAmount } });
  } catch (err) {
    console.error('Create earning error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create earning' });
  }
});

// PATCH /api/mechanic-earnings/:id — mark paid/cancelled
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes, payment_method } = req.body;
    if (!['paid', 'cancelled'].includes(status)) return res.status(400).json({ success: false, message: 'status must be paid or cancelled' });

    const [earning] = await query('SELECT * FROM mechanic_earnings WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!earning) return res.status(404).json({ success: false, message: 'Earning not found' });

    await execute('UPDATE mechanic_earnings SET status = ?, paid_at = ?, notes = COALESCE(?, notes) WHERE id = ?',
      [status, status === 'paid' ? new Date() : null, notes || null, earning.id]);

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: `mechanic_earning.${status}`, entityType: 'mechanic_earning', entityId: earning.id,
      oldValue: { status: earning.status }, newValue: { status, payment_method: payment_method || 'cash' } });

    return res.json({ success: true, message: `Earning marked ${status}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update earning' });
  }
});

// POST /api/mechanic-earnings/bulk-pay — mark multiple as paid, supports partial amount
router.post('/bulk-pay', async (req, res) => {
  try {
    const { mechanic_id, ids, amount, notes, payment_method } = req.body;

    let where = 'workshop_id = ? AND status = ?';
    const params = [req.workshopId, 'pending'];
    if (ids && ids.length) { where += ` AND id IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
    else if (mechanic_id) { where += ' AND mechanic_id = ?'; params.push(mechanic_id); }
    else return res.status(400).json({ success: false, message: 'Provide mechanic_id or ids[]' });

    // Get pending earnings to determine how many to pay
    const pendingRows = await query(`SELECT id, net_amount FROM mechanic_earnings WHERE ${where} ORDER BY created_at ASC`, params);
    if (!pendingRows.length) return res.json({ success: true, message: '0 earnings to pay', paid_count: 0, paid_amount: 0 });

    const totalPending = pendingRows.reduce((s, r) => s + Number(r.net_amount), 0);
    const payAmount = amount !== undefined && amount !== null ? parseFloat(amount) : totalPending;

    // If paying full or more, mark all as paid
    let paidIds = [];
    let actualPaid = 0;
    if (payAmount >= totalPending) {
      paidIds = pendingRows.map(r => r.id);
      actualPaid = totalPending;
    } else {
      // Partial: pay in order until amount is exhausted
      let remaining = payAmount;
      for (const row of pendingRows) {
        if (remaining <= 0) break;
        const rowAmt = Number(row.net_amount);
        if (remaining >= rowAmt) {
          paidIds.push(row.id);
          remaining -= rowAmt;
          actualPaid += rowAmt;
        } else {
          // Partial on this row — still mark it paid (partial payment settles oldest first)
          paidIds.push(row.id);
          actualPaid += rowAmt;
          remaining = 0;
        }
      }
    }

    if (paidIds.length) {
      const placeholders = paidIds.map(() => '?').join(',');
      await execute(
        `UPDATE mechanic_earnings SET status = 'paid', paid_at = NOW(), notes = COALESCE(?, notes) WHERE id IN (${placeholders}) AND workshop_id = ?`,
        [notes || null, ...paidIds, req.workshopId]
      );
    }

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'mechanic_earning.bulk_paid',
      entityType: 'mechanic_earning', entityId: mechanic_id || null,
      newValue: { paid_count: paidIds.length, paid_amount: actualPaid, payment_method: payment_method || 'cash', requested_amount: payAmount } });

    const [_w] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
    const currency = _w?.currency || 'AED';
    return res.json({ success: true, message: `${paidIds.length} earnings marked as paid (${currency} ${actualPaid.toFixed(2)})`, paid_count: paidIds.length, paid_amount: actualPaid });
  } catch (err) {
    console.error('Bulk pay error:', err);
    return res.status(500).json({ success: false, message: 'Failed to bulk pay' });
  }
});

// POST /api/mechanic-earnings/recalculate — backfill missing earnings for completed work orders
router.post('/recalculate', async (req, res) => {
  try {
    const { mechanic_id } = req.body;
    const config = await getFinancialConfig(req.workshopId);

    if ((parseFloat(config.mechanicEarningRate) || 0) <= 0) {
      return res.status(400).json({ success: false, message: 'Mechanic earning rate is not configured. Go to Settings → Financial and set it first.' });
    }

    // Find completed work orders without mechanic_earnings records
    let where = "o.workshop_id = ? AND o.status = 'completed' AND o.mechanic_id IS NOT NULL";
    const params = [req.workshopId];
    if (mechanic_id) { where += ' AND o.mechanic_id = ?'; params.push(mechanic_id); }

    const orders = await query(
      `SELECT o.id, o.mechanic_id, o.service_fee, o.cash_amount, o.payment_method
       FROM work_orders o
       LEFT JOIN mechanic_earnings me ON me.work_order_id = o.id AND me.mechanic_id = o.mechanic_id AND me.workshop_id = o.workshop_id
       WHERE ${where} AND me.id IS NULL
       ORDER BY o.completed_at DESC LIMIT 500`,
      params
    );

    let created = 0;
    for (const order of orders) {
      const serviceFee = parseFloat(order.service_fee) || 0;
      const cashAmount = order.payment_method === 'cash' ? (parseFloat(order.cash_amount) || 0) : 0;
      const { baseAmount, cashBonus, netEarning } = computeMechanicEarning({ serviceFee, cashAmount, config });

      if (netEarning <= 0) continue;

      await execute(
        `INSERT INTO mechanic_earnings (workshop_id, mechanic_id, work_order_id, earning_type, amount, base_amount, bonus, deductions, net_amount, status)
         VALUES (?, ?, ?, 'labor', ?, ?, ?, 0, ?, 'pending')`,
        [req.workshopId, order.mechanic_id, order.id, netEarning, baseAmount, cashBonus, netEarning]
      );
      created++;
    }

    return res.json({ success: true, message: `Backfilled ${created} earnings for ${orders.length} completed work orders`, created, scanned: orders.length });
  } catch (err) {
    console.error('Recalculate earnings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to recalculate earnings' });
  }
});

export default router;
