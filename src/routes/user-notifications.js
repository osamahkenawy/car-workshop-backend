import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// =================================================================
//  GET /api/user-notifications — current user's in-app notifications
// =================================================================
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 30, unread_only } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = Math.min(parseInt(limit, 10) || 30, 100);
    const offset = (pg - 1) * lim;

    let where = 'WHERE un.user_id = ? AND un.workshop_id = ?';
    const params = [req.user.id, req.workshopId];
    if (unread_only === 'true') {
      where += ' AND un.is_read = FALSE';
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM user_notifications un ${where}`, params
    );
    const [{ unread }] = await query(
      `SELECT COUNT(*) as unread FROM user_notifications WHERE user_id = ? AND workshop_id = ? AND is_read = FALSE`,
      [req.user.id, req.workshopId]
    );

    const notifications = await query(
      `SELECT un.*, o.work_order_number
       FROM user_notifications un
       LEFT JOIN work_orders o ON un.work_order_id = o.id
       ${where}
       ORDER BY un.created_at DESC
       LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: notifications,
      unread,
      total,
      pagination: { page: pg, limit: lim, total },
    });
  } catch (err) {
    console.error('[UserNotifications] List error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
  }
});

// =================================================================
//  GET /api/user-notifications/unread-count — quick badge count
// =================================================================
router.get('/unread-count', async (req, res) => {
  try {
    const [{ count }] = await query(
      'SELECT COUNT(*) as count FROM user_notifications WHERE user_id = ? AND workshop_id = ? AND is_read = FALSE',
      [req.user.id, req.workshopId]
    );
    return res.json({ success: true, count });
  } catch (err) {
    return res.status(500).json({ success: false, count: 0 });
  }
});

// =================================================================
//  POST /api/user-notifications/:id/read — mark single as read
// =================================================================
router.post('/:id/read', async (req, res) => {
  try {
    await execute(
      'UPDATE user_notifications SET is_read = TRUE, read_at = NOW() WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to mark as read' });
  }
});

// =================================================================
//  POST /api/user-notifications/read-all — mark all as read
// =================================================================
router.post('/read-all', async (req, res) => {
  try {
    await execute(
      'UPDATE user_notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = ? AND workshop_id = ? AND is_read = FALSE',
      [req.user.id, req.workshopId]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to mark all as read' });
  }
});

// =================================================================
//  DELETE /api/user-notifications/:id — delete notification
// =================================================================
router.delete('/:id', async (req, res) => {
  try {
    await execute(
      'DELETE FROM user_notifications WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete notification' });
  }
});

// =================================================================
//  DELETE /api/user-notifications — clear all
// =================================================================
router.delete('/', async (req, res) => {
  try {
    await execute(
      'DELETE FROM user_notifications WHERE user_id = ? AND workshop_id = ?',
      [req.user.id, req.workshopId]
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to clear notifications' });
  }
});

export default router;
