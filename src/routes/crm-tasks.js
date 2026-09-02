/**
 * crm-tasks.js — Tasks & Follow-ups.
 *
 * One list of what staff owe customers, across every kind of record. The
 * Enquiries page already does this for enquiries via enquiries.follow_up_at,
 * and that keeps working untouched — migrating it would break the KPI on that
 * page. The list here reads crm_tasks, and the stats endpoint reports enquiry
 * follow-ups alongside so the two are visible together rather than competing.
 *
 *   GET   /api/crm/tasks         list, filterable
 *   GET   /api/crm/tasks/stats   the KPI cards
 *   POST  /api/crm/tasks         create
 *   PATCH /api/crm/tasks/:id     update / reassign / reschedule
 *   POST  /api/crm/tasks/:id/complete
 *   DELETE /api/crm/tasks/:id
 */

import { Router } from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkup, clampText } from '../lib/sanitize.js';

const router = Router();
router.use(authMiddleware);

const TASK_TYPES = ['follow_up', 'call_back', 'quote_chase', 'collect_payment',
  'check_part', 'complaint', 'reminder', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
const RELATED = ['enquiry', 'work_order', 'invoice', 'quote', 'warranty_claim', 'reminder', 'none'];

const pad = n => String(n).padStart(2, '0');
const mysqlDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Parse a client-supplied datetime, or null. */
function parseWhen(v) {
  if (!v || Number.isNaN(Date.parse(v))) return null;
  return mysqlDate(new Date(v));
}

/* ═══════════════════════════════════════════════════════════
   GET / — the task list
   ═══════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const { status, assigned_to, priority, task_type, customer_id, view, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = (page - 1) * limit;

    const where = ['t.workshop_id = ?'];
    const params = [req.workshopId];

    // `view` is the shortcut the page's tabs use. Default hides finished work,
    // because a task list that shows everything ever done is not a task list.
    if (view === 'overdue') {
      where.push("t.status IN ('open','in_progress')", 't.due_at IS NOT NULL', 't.due_at <= NOW()');
    } else if (view === 'today') {
      where.push("t.status IN ('open','in_progress')", 'DATE(t.due_at) = CURDATE()');
    } else if (view === 'unassigned') {
      where.push("t.status IN ('open','in_progress')", 't.assigned_to IS NULL');
    } else if (view === 'mine') {
      where.push("t.status IN ('open','in_progress')", 't.assigned_to = ?');
      params.push(req.user?.id || 0);
    } else if (view === 'done') {
      where.push("t.status IN ('done','cancelled')");
    } else if (!status) {
      where.push("t.status IN ('open','in_progress')");
    }

    if (status && STATUSES.includes(status)) { where.push('t.status = ?'); params.push(status); }
    if (priority && PRIORITIES.includes(priority)) { where.push('t.priority = ?'); params.push(priority); }
    if (task_type && TASK_TYPES.includes(task_type)) { where.push('t.task_type = ?'); params.push(task_type); }
    if (customer_id) { where.push('t.customer_id = ?'); params.push(Number(customer_id)); }
    if (assigned_to === 'none') { where.push('t.assigned_to IS NULL'); }
    else if (assigned_to) { where.push('t.assigned_to = ?'); params.push(Number(assigned_to)); }
    if (search) {
      where.push('(t.title LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const clause = where.join(' AND ');

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM crm_tasks t
         LEFT JOIN customers c ON c.id = t.customer_id
        WHERE ${clause}`, params
    );

    const rows = await query(
      `SELECT t.*,
              c.full_name AS customer_name, c.phone AS customer_phone,
              v.make, v.model, v.plate_number,
              au.full_name AS assigned_name,
              cu.full_name AS created_name,
              (t.due_at IS NOT NULL AND t.due_at <= NOW()
                AND t.status IN ('open','in_progress')) AS is_overdue
         FROM crm_tasks t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN vehicles  v ON v.id = t.vehicle_id
         LEFT JOIN users    au ON au.id = t.assigned_to
         LEFT JOIN users    cu ON cu.id = t.created_by
        WHERE ${clause}
        ORDER BY
          FIELD(t.priority, 'urgent','high','normal','low'),
          t.due_at IS NULL, t.due_at ASC, t.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total },
    });
  } catch (err) {
    console.error('[CRMTasks] list error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load tasks' });
  }
});

/* ═══════════════════════════════════════════════════════════
   GET /stats — KPI cards
   ═══════════════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const [t] = await query(
      // COALESCE throughout: SUM() over zero rows returns NULL, which reaches
      // the KPI cards as the literal "null".
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status IN ('open','in_progress')), 0) AS open_count,
              COALESCE(SUM(status IN ('open','in_progress')
                           AND due_at IS NOT NULL AND due_at <= NOW()), 0) AS overdue,
              COALESCE(SUM(status IN ('open','in_progress')
                           AND DATE(due_at) = CURDATE()), 0) AS due_today,
              COALESCE(SUM(status IN ('open','in_progress')
                           AND assigned_to IS NULL), 0) AS unassigned,
              COALESCE(SUM(status = 'done'
                           AND DATE(completed_at) = CURDATE()), 0) AS done_today,
              COALESCE(SUM(status IN ('open','in_progress')
                           -- HIGH_PRIORITY is a MySQL reserved word (SELECT
                           -- HIGH_PRIORITY ...), so it cannot be a bare alias.
                           AND priority IN ('high','urgent')), 0) AS high_urgent
         FROM crm_tasks WHERE workshop_id = ?`,
      [req.workshopId]
    );

    // Enquiry follow-ups still live on the enquiry, and the Enquiries page
    // counts them. Reported here too so nobody has to remember there are two
    // places a follow-up can hide.
    const [e] = await query(
      `SELECT COALESCE(SUM(follow_up_at IS NOT NULL AND follow_up_at <= NOW()
                  AND status IN ('new','quoted','nurture')), 0) AS enquiry_follow_ups_due
         FROM enquiries WHERE workshop_id = ?`,
      [req.workshopId]
    );

    const byAssignee = await query(
      `SELECT t.assigned_to, u.full_name AS name,
              COUNT(*) AS open_count,
              COALESCE(SUM(t.due_at IS NOT NULL AND t.due_at <= NOW()), 0) AS overdue
         FROM crm_tasks t
         LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.workshop_id = ? AND t.status IN ('open','in_progress')
        GROUP BY t.assigned_to, u.full_name
        ORDER BY open_count DESC`,
      [req.workshopId]
    );

    return res.json({
      success: true,
      data: { totals: { ...t, ...e }, by_assignee: byAssignee },
    });
  } catch (err) {
    console.error('[CRMTasks] stats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load task stats' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST / — create
   ═══════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) {
      return res.status(422).json({
        success: false, message: 'Give the task a title so it is clear what needs doing',
        errors: [{ field: 'title', message: 'A title is required' }],
      });
    }

    const result = await execute(
      `INSERT INTO crm_tasks
         (workshop_id, title, details, task_type, priority, status,
          customer_id, vehicle_id, related_type, related_id,
          assigned_to, due_at, created_by)
       VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?)`,
      [
        req.workshopId,
        stripMarkup(b.title, 200),
        clampText(b.details, 5000),
        TASK_TYPES.includes(b.task_type) ? b.task_type : 'follow_up',
        PRIORITIES.includes(b.priority) ? b.priority : 'normal',
        b.customer_id ? Number(b.customer_id) : null,
        b.vehicle_id ? Number(b.vehicle_id) : null,
        RELATED.includes(b.related_type) ? b.related_type : 'none',
        b.related_id ? Number(b.related_id) : null,
        b.assigned_to ? Number(b.assigned_to) : null,
        parseWhen(b.due_at),
        req.user?.id || null,
      ]
    );

    const [row] = await query('SELECT * FROM crm_tasks WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('[CRMTasks] create error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create the task' });
  }
});

/* ═══════════════════════════════════════════════════════════
   PATCH /:id — partial update

   Only keys present in the body are touched, so reassigning does not clear a
   due date and rescheduling does not clear an assignee.
   ═══════════════════════════════════════════════════════════ */
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [];
    const has = k => Object.prototype.hasOwnProperty.call(b, k);

    if (has('title') && String(b.title).trim()) { sets.push('title = ?'); params.push(stripMarkup(b.title, 200)); }
    if (has('details')) { sets.push('details = ?'); params.push(clampText(b.details, 5000)); }
    if (has('task_type') && TASK_TYPES.includes(b.task_type)) { sets.push('task_type = ?'); params.push(b.task_type); }
    if (has('priority') && PRIORITIES.includes(b.priority)) { sets.push('priority = ?'); params.push(b.priority); }
    if (has('assigned_to')) { sets.push('assigned_to = ?'); params.push(b.assigned_to ? Number(b.assigned_to) : null); }
    if (has('due_at')) { sets.push('due_at = ?'); params.push(parseWhen(b.due_at)); }
    if (has('customer_id')) { sets.push('customer_id = ?'); params.push(b.customer_id ? Number(b.customer_id) : null); }
    if (has('vehicle_id')) { sets.push('vehicle_id = ?'); params.push(b.vehicle_id ? Number(b.vehicle_id) : null); }
    if (has('outcome')) { sets.push('outcome = ?'); params.push(clampText(b.outcome, 5000)); }

    if (has('status') && STATUSES.includes(b.status)) {
      sets.push('status = ?');
      params.push(b.status);
      // Completion timestamps are derived from the status, never trusted from
      // the client, so "done" always carries a real time and a real person.
      if (b.status === 'done') {
        sets.push('completed_at = NOW()', 'completed_by = ?');
        params.push(req.user?.id || null);
      } else {
        sets.push('completed_at = NULL', 'completed_by = NULL');
      }
    }

    if (!sets.length) return res.status(422).json({ success: false, message: 'Nothing to update' });

    const result = await execute(
      `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = ? AND workshop_id = ?`,
      [...params, id, req.workshopId]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Task not found' });

    const [row] = await query('SELECT * FROM crm_tasks WHERE id = ?', [id]);
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[CRMTasks] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update the task' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/complete — the one-click path from the list
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/complete', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await execute(
      `UPDATE crm_tasks
          SET status = 'done', completed_at = NOW(), completed_by = ?, outcome = COALESCE(?, outcome)
        WHERE id = ? AND workshop_id = ? AND status IN ('open','in_progress')`,
      [req.user?.id || null, clampText(req.body?.outcome, 5000), id, req.workshopId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({
        success: false, message: 'That task is not open — it may already be done',
      });
    }
    return res.json({ success: true, message: 'Task completed' });
  } catch (err) {
    console.error('[CRMTasks] complete error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to complete the task' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await execute(
      'DELETE FROM crm_tasks WHERE id = ? AND workshop_id = ?',
      [Number(req.params.id), req.workshopId]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Task not found' });
    return res.json({ success: true, message: 'Task deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete the task' });
  }
});

export default router;
