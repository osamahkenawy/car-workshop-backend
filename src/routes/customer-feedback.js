import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Journey step 12 — the 48-hour follow-up call.
 *
 * The `customer_feedback` table already existed (migrations/post/03_customer_journey.sql)
 * but had no route file. Rows are auto-scheduled by work-orders.js when a
 * work order is marked completed; this file lets staff see the queue and
 * record the outcome of each call.
 */

const router = express.Router();
router.use(authMiddleware);

// GET /api/customer-feedback — list follow-up calls (optionally filtered by status)
router.get('/', async (req, res) => {
  try {
    const { status, work_order_id } = req.query;
    const params = [req.workshopId];
    let where = 'WHERE cf.workshop_id = ?';
    if (status) { where += ' AND cf.status = ?'; params.push(status); }
    if (work_order_id) { where += ' AND cf.work_order_id = ?'; params.push(work_order_id); }

    const rows = await query(
      `SELECT cf.*, wo.work_order_number, wo.customer_name, wo.customer_phone
       FROM customer_feedback cf
       JOIN work_orders wo ON wo.id = cf.work_order_id
       ${where}
       ORDER BY cf.scheduled_at ASC`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[CustomerFeedback] List error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load follow-up calls' });
  }
});

// PATCH /api/customer-feedback/:id — record the outcome of a follow-up call
router.patch('/:id', async (req, res) => {
  try {
    const { status, satisfied, rating, nps_score, comments, channel } = req.body;
    const validStatuses = ['scheduled', 'attempted', 'completed', 'skipped'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const [row] = await query(
      'SELECT id FROM customer_feedback WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Follow-up call not found' });

    const fields = [];
    const values = [];
    if (status) {
      fields.push('status = ?'); values.push(status);
      fields.push('attempts = attempts + 1');
      if (status === 'completed' || status === 'skipped') { fields.push('completed_at = NOW()'); }
      if (status === 'attempted' || status === 'completed') { fields.push('contacted_at = NOW()'); }
    }
    if (channel !== undefined) { fields.push('channel = ?'); values.push(channel); }
    if (satisfied !== undefined) { fields.push('satisfied = ?'); values.push(satisfied ? 1 : 0); }
    if (rating !== undefined) { fields.push('rating = ?'); values.push(rating); }
    if (nps_score !== undefined) { fields.push('nps_score = ?'); values.push(nps_score); }
    if (comments !== undefined) { fields.push('comments = ?'); values.push(comments); }
    fields.push('handled_by = ?'); values.push(req.user.id);

    if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    values.push(req.params.id, req.workshopId);
    await execute(`UPDATE customer_feedback SET ${fields.join(', ')} WHERE id = ? AND workshop_id = ?`, values);

    const [updated] = await query('SELECT * FROM customer_feedback WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[CustomerFeedback] Update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update follow-up call' });
  }
});

export default router;
