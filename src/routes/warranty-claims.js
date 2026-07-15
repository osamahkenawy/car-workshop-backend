import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { dispatchWebhook, warrantyClaimStatusToEvent } from '../lib/webhook-dispatcher.js';

const router = express.Router();
router.use(authMiddleware);

/* ══════════════════════════════════════════════════════════════
   Warranty Claims
   Ported from delivery-service-backend/src/routes/returns.js -> warranty-claims.js.
   Uses the `warranty_claims` table exactly as defined in car_workshop.sql:
     status: requested/approved/rejected/in_progress/resolved/closed
   Renamed order_id -> work_order_id throughout. The table already exists in
   the schema (no ensureTable step needed, unlike the source's returns_requests
   auto-create).
   ══════════════════════════════════════════════════════════════ */

/* ── GET /api/warranty-claims — list warranty claims ──────────── */
router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = `
      SELECT wc.*, o.customer_name, o.customer_phone, o.dropoff_address,
             o.status AS work_order_status, o.work_order_number AS orig_work_order_number
      FROM warranty_claims wc
      LEFT JOIN work_orders o ON wc.work_order_id = o.id AND o.workshop_id = wc.workshop_id
      WHERE wc.workshop_id = ?
    `;
    const params = [req.workshopId];

    if (status) {
      sql += ' AND wc.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (o.work_order_number LIKE ? OR o.customer_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY wc.created_at DESC';

    const rows = await query(sql, params);
    res.json({ success: true, warrantyClaims: rows });
  } catch (err) {
    console.error('GET /warranty-claims error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch warranty claims' });
  }
});

/* ── GET /api/warranty-claims/:id — single claim detail ──────────── */
router.get('/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT wc.*, o.customer_name, o.customer_phone, o.dropoff_address,
              o.status AS work_order_status, o.work_order_number AS orig_work_order_number,
              o.cash_amount, o.payment_method
       FROM warranty_claims wc
       LEFT JOIN work_orders o ON wc.work_order_id = o.id AND o.workshop_id = wc.workshop_id
       WHERE wc.id = ? AND wc.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Warranty claim not found' });
    res.json({ success: true, warrantyClaim: rows[0] });
  } catch (err) {
    console.error('GET /warranty-claims/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch warranty claim' });
  }
});

/* ── POST /api/warranty-claims — create warranty claim ─────────── */
router.post('/', async (req, res) => {
  try {
    const { work_order_id, reason } = req.body;
    if (!work_order_id || !reason) {
      return res.status(400).json({ success: false, message: 'work_order_id and reason are required' });
    }

    // Verify work order exists and belongs to workshop
    const [order] = await query(
      'SELECT id, work_order_number, customer_id FROM work_orders WHERE id = ? AND workshop_id = ?',
      [work_order_id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    const result = await execute(
      `INSERT INTO warranty_claims (workshop_id, work_order_id, customer_id, reason, requested_by)
       VALUES (?, ?, ?, ?, ?)`,
      [req.workshopId, work_order_id, order.customer_id || null, reason, req.user?.id || null]
    );

    res.status(201).json({
      success: true,
      message: 'Warranty claim created',
      data: { id: result.insertId, work_order_id, work_order_number: order.work_order_number, reason },
      claimId: result.insertId,
    });
  } catch (err) {
    console.error('POST /warranty-claims error:', err);
    res.status(500).json({ success: false, message: 'Failed to create warranty claim' });
  }
});

/* ── PATCH /api/warranty-claims/:id/status — update claim status ─── */
const VALID_WARRANTY_TRANSITIONS = {
  requested:   ['approved', 'rejected'],
  approved:    ['in_progress', 'closed'],
  in_progress: ['resolved'],
  resolved:    ['closed'],
  rejected:    [],
  closed:      [],
};

router.patch('/:id/status', async (req, res) => {
  try {
    const { status, resolution_notes, resolved_work_order_id } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'status is required' });

    const rows = await query(
      'SELECT id, status FROM warranty_claims WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Warranty claim not found' });

    const current = rows[0].status;
    const allowed = VALID_WARRANTY_TRANSITIONS[current] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from "${current}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`,
      });
    }

    const isResolvedTerminal = ['resolved', 'closed'].includes(status);
    const isApproval = status === 'approved' || status === 'rejected';

    await execute(
      `UPDATE warranty_claims SET
         status = ?,
         resolution_notes = COALESCE(?, resolution_notes),
         resolved_work_order_id = COALESCE(?, resolved_work_order_id),
         approved_by = ${isApproval ? '?' : 'approved_by'},
         approved_at = ${isApproval ? 'NOW()' : 'approved_at'},
         resolved_at = ${isResolvedTerminal ? 'NOW()' : 'resolved_at'}
       WHERE id = ? AND workshop_id = ?`,
      isApproval
        ? [status, resolution_notes || null, resolved_work_order_id || null, req.user?.id || null, req.params.id, req.workshopId]
        : [status, resolution_notes || null, resolved_work_order_id || null, req.params.id, req.workshopId]
    );

    res.json({ success: true, message: `Warranty claim status updated to ${status}` });

    const webhookEvent = warrantyClaimStatusToEvent(status);
    if (webhookEvent) {
      dispatchWebhook({ tenantId: req.workshopId, event: webhookEvent, data: { id: req.params.id, status } });
    }
  } catch (err) {
    console.error('PATCH /warranty-claims/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update warranty claim status' });
  }
});

// DELETE /api/warranty-claims/:id — cancel/close a warranty claim
router.delete('/:id', async (req, res) => {
  try {
    const [claim] = await query(
      'SELECT id, status FROM warranty_claims WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!claim) return res.status(404).json({ success: false, message: 'Warranty claim not found' });

    const nonCancellable = ['resolved', 'closed', 'rejected'];
    if (nonCancellable.includes(claim.status)) {
      return res.status(400).json({ success: false, message: `Cannot close a warranty claim that is already ${claim.status}` });
    }

    await execute(
      "UPDATE warranty_claims SET status = 'closed', resolved_at = NOW() WHERE id = ? AND workshop_id = ?",
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Warranty claim closed' });
  } catch (err) {
    console.error('DELETE /warranty-claims/:id error:', err);
    return res.status(500).json({ success: false, message: 'Failed to close warranty claim' });
  }
});

export default router;
