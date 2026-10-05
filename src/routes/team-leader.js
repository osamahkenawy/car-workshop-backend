/**
 * ═══════════════════════════════════════════════════════════════
 *  Team Leader — the board a team leader works from.
 *
 *  A job card comes back from estimate approval and sits waiting for a
 *  technician. The team leader is who puts one on it, and who books the
 *  window that technician is expected to work. This module answers the
 *  four questions that board has to answer:
 *
 *    1. Who are my technicians?
 *    2. Which vehicles are on my team right now?
 *    3. What is each technician booked for?
 *    4. Who is working and who is free?
 *
 *  Scoping: a team_leader sees their own technicians (mechanics.
 *  team_leader_id = their user id). Anyone above them — GM, workshop
 *  manager, admin — sees every team, because a board that renders empty
 *  for the person checking on it is worse than no board. They can narrow
 *  to one leader with ?team_leader_id=.
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

/** Statuses that mean "this job card is live on the floor right now". */
const ACTIVE_STATUSES = ['assigned', 'accepted', 'in_progress', 'inspection'];

/** Statuses that mean "approved, but nobody is on it yet". */
const AWAITING_STATUSES = ['estimate_approved', 'pending', 'confirmed'];

/**
 * Who this request is allowed to see.
 *
 * Returns { scoped: true, leaderId } to restrict to one leader's team, or
 * { scoped: false } for the whole workshop. A team leader is always scoped
 * to themselves and cannot widen it by passing someone else's id — that is
 * the one place this needs to be a rule rather than a filter.
 */
function resolveScope(req) {
  // role_slug, not role: users.role is a fixed enum that has no
  // team_leader value, so the dynamic roles table is the only place this
  // can be read from (see middleware/auth.js).
  const isLeader = req.user?.role_slug === 'team_leader';
  if (isLeader) return { scoped: true, leaderId: req.user.id };

  const requested = req.query.team_leader_id;
  if (requested) return { scoped: true, leaderId: Number(requested) };
  return { scoped: false };
}

/**
 * GET /api/team-leader/overview
 * One call, because the board renders as a single screen and four
 * round-trips to paint it would show four different moments in time.
 */
router.get('/overview', async (req, res) => {
  try {
    const scope = resolveScope(req);
    const teamWhere = scope.scoped ? 'AND m.team_leader_id = ?' : '';
    const teamParams = scope.scoped ? [scope.leaderId] : [];

    // ── 1. The technicians, each with what they are actually on ────────
    // live_jobs counts real open work orders rather than trusting
    // mechanics.status, which is self-reported and drifts: a technician
    // who forgets to flip themselves back to "available" would otherwise
    // read as busy forever.
    const technicians = await query(
      `SELECT m.id, m.full_name, m.phone, m.email, m.specialty, m.status,
              m.avatar_url, m.photo_url, m.rating, m.total_jobs_completed,
              m.service_bay_id, sb.name AS service_bay_name,
              m.team_leader_id, u.full_name AS team_leader_name,
              (SELECT COUNT(*) FROM work_orders wo
                WHERE wo.mechanic_id = m.id
                  AND wo.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})) AS live_jobs,
              (SELECT MIN(wa.scheduled_start_at) FROM work_order_assignments wa
                WHERE wa.mechanic_id = m.id AND wa.is_current = 1
                  AND wa.scheduled_end_at >= NOW()) AS next_booking_at
         FROM mechanics m
         LEFT JOIN service_bays sb ON sb.id = m.service_bay_id
         LEFT JOIN users u ON u.id = m.team_leader_id
        WHERE m.workshop_id = ? AND m.is_active = 1 ${teamWhere}
        ORDER BY m.full_name ASC`,
      [...ACTIVE_STATUSES, req.workshopId, ...teamParams]
    );

    // ── 2. The vehicles on the team right now ──────────────────────────
    const activeJobs = await query(
      `SELECT wo.id, wo.work_order_number, wo.status, wo.service_category,
              wo.description, wo.created_at, wo.customer_name,
              wo.mechanic_id, m.full_name AS mechanic_name,
              v.make AS vehicle_make, v.model AS vehicle_model,
              v.plate_number, v.year AS vehicle_year,
              wa.scheduled_start_at, wa.scheduled_end_at, wa.assigned_at
         FROM work_orders wo
         JOIN mechanics m ON m.id = wo.mechanic_id
         LEFT JOIN vehicles v ON v.id = wo.vehicle_id
         LEFT JOIN work_order_assignments wa
                ON wa.work_order_id = wo.id AND wa.mechanic_id = m.id AND wa.is_current = 1
        WHERE wo.workshop_id = ?
          AND wo.status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
          ${scope.scoped ? 'AND m.team_leader_id = ?' : ''}
        ORDER BY wa.scheduled_start_at IS NULL, wa.scheduled_start_at ASC, wo.created_at DESC
        LIMIT 100`,
      [req.workshopId, ...ACTIVE_STATUSES, ...teamParams]
    );

    // ── 3. Job cards approved and waiting for a technician ─────────────
    // This is the queue the team leader is here to clear.
    const awaiting = await query(
      `SELECT wo.id, wo.work_order_number, wo.status, wo.service_category,
              wo.description, wo.created_at, wo.customer_name, wo.total_amount,
              v.make AS vehicle_make, v.model AS vehicle_model,
              v.plate_number, v.year AS vehicle_year
         FROM work_orders wo
         LEFT JOIN vehicles v ON v.id = wo.vehicle_id
        WHERE wo.workshop_id = ?
          AND wo.mechanic_id IS NULL
          AND wo.status IN (${AWAITING_STATUSES.map(() => '?').join(',')})
        ORDER BY wo.created_at ASC
        LIMIT 50`,
      [req.workshopId, ...AWAITING_STATUSES]
    );

    // ── 4. Today's booked windows ──────────────────────────────────────
    const bookings = await query(
      `SELECT wa.work_order_id, wa.mechanic_id, m.full_name AS mechanic_name,
              wa.scheduled_start_at, wa.scheduled_end_at,
              wo.work_order_number, wo.status,
              v.plate_number, v.make AS vehicle_make, v.model AS vehicle_model
         FROM work_order_assignments wa
         JOIN mechanics m ON m.id = wa.mechanic_id
         JOIN work_orders wo ON wo.id = wa.work_order_id
         LEFT JOIN vehicles v ON v.id = wo.vehicle_id
        WHERE wa.is_current = 1
          AND m.workshop_id = ?
          AND wa.scheduled_start_at IS NOT NULL
          AND DATE(wa.scheduled_start_at) = CURDATE()
          ${scope.scoped ? 'AND m.team_leader_id = ?' : ''}
        ORDER BY wa.scheduled_start_at ASC`,
      [req.workshopId, ...teamParams]
    );

    // The queue list is capped at 50 so the payload stays sane, which means
    // its length is not the count — with 171 job cards waiting it would have
    // read "50 waiting" forever, and the number on a board like this is the
    // whole point. Counted separately.
    const [{ awaiting_total }] = await query(
      `SELECT COUNT(*) AS awaiting_total
         FROM work_orders wo
        WHERE wo.workshop_id = ?
          AND wo.mechanic_id IS NULL
          AND wo.status IN (${AWAITING_STATUSES.map(() => '?').join(',')})`,
      [req.workshopId, ...AWAITING_STATUSES]
    );

    // Free / working is derived from live_jobs, with the self-reported
    // status only breaking the tie for someone with no open job — that is
    // the only case where "on break" or "offline" tells us anything the
    // job data cannot.
    const working = technicians.filter(t => Number(t.live_jobs) > 0).length;
    const free = technicians.filter(t => Number(t.live_jobs) === 0 && t.status === 'available').length;
    const unavailable = technicians.filter(t => Number(t.live_jobs) === 0 && t.status !== 'available').length;

    res.json({
      success: true,
      scope: scope.scoped ? { team_leader_id: scope.leaderId } : { all_teams: true },
      summary: {
        technicians: technicians.length,
        working, free, unavailable,
        awaiting_assignment: Number(awaiting_total),
        awaiting_shown: awaiting.length,
        booked_today: bookings.length,
      },
      technicians, activeJobs, awaiting, bookings,
    });
  } catch (err) {
    console.error('GET /team-leader/overview error:', err);
    res.status(500).json({ success: false, message: 'Failed to load the team board' });
  }
});

/**
 * POST /api/team-leader/assign
 * Put a technician on a job card and book their window.
 *
 * Body: { work_order_id, mechanic_id, scheduled_start_at, scheduled_end_at }
 *
 * Writes the same two places the existing assign flow does —
 * work_orders.mechanic_id and a current work_order_assignments row — so a
 * job assigned from this board is indistinguishable downstream from one
 * assigned anywhere else. The booked window is the new part.
 */
router.post('/assign', async (req, res) => {
  try {
    const { work_order_id, mechanic_id, scheduled_start_at, scheduled_end_at } = req.body || {};
    if (!work_order_id || !mechanic_id) {
      return res.status(400).json({ success: false, message: 'work_order_id and mechanic_id are required.' });
    }

    if (scheduled_start_at && scheduled_end_at
        && new Date(scheduled_end_at) <= new Date(scheduled_start_at)) {
      return res.status(400).json({ success: false, message: 'The end of the window must be after its start.' });
    }

    const [workOrder] = await query(
      'SELECT id, work_order_number, status, mechanic_id FROM work_orders WHERE id = ? AND workshop_id = ?',
      [work_order_id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Job card not found.' });

    const [mechanic] = await query(
      'SELECT id, full_name, team_leader_id FROM mechanics WHERE id = ? AND workshop_id = ? AND is_active = 1',
      [mechanic_id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Technician not found.' });

    // A team leader assigns from their own team. Managers are not limited.
    const scope = resolveScope(req);
    if (scope.scoped && Number(mechanic.team_leader_id) !== Number(scope.leaderId)) {
      return res.status(403).json({
        success: false,
        message: `${mechanic.full_name} is not on your team.`,
      });
    }

    // Overlap check: the point of booking a window is knowing it is free.
    // Reported rather than refused — a leader double-booking deliberately
    // (a quick job inside a long one) is a real thing, and blocking it
    // outright would send them back to assigning with no window at all.
    let conflict = null;
    if (scheduled_start_at && scheduled_end_at) {
      const [clash] = await query(
        `SELECT wa.work_order_id, wo.work_order_number,
                wa.scheduled_start_at, wa.scheduled_end_at
           FROM work_order_assignments wa
           JOIN work_orders wo ON wo.id = wa.work_order_id
          WHERE wa.mechanic_id = ? AND wa.is_current = 1
            AND wa.work_order_id <> ?
            AND wa.scheduled_start_at IS NOT NULL
            AND wa.scheduled_start_at < ?
            AND wa.scheduled_end_at   > ?
          LIMIT 1`,
        [mechanic_id, work_order_id, scheduled_end_at, scheduled_start_at]
      );
      if (clash) conflict = clash;
    }

    // Retire any previous assignment, then write the new one.
    await execute(
      'UPDATE work_order_assignments SET is_current = 0 WHERE work_order_id = ? AND is_current = 1',
      [work_order_id]
    );
    await execute(
      `INSERT INTO work_order_assignments
         (work_order_id, mechanic_id, assigned_by, assigned_at,
          scheduled_start_at, scheduled_end_at, is_current)
       VALUES (?, ?, ?, NOW(), ?, ?, 1)`,
      [work_order_id, mechanic_id, req.user?.id || null,
       scheduled_start_at || null, scheduled_end_at || null]
    );

    // 'assigned' is a legal next step from every status a job card can be
    // sitting in while it waits for someone (see VALID_TRANSITIONS in
    // work-orders.js), so this does not need a transition guard of its own.
    await execute(
      `UPDATE work_orders
          SET mechanic_id = ?, status = 'assigned', updated_at = NOW()
        WHERE id = ? AND workshop_id = ?`,
      [mechanic_id, work_order_id, req.workshopId]
    );
    await execute('UPDATE mechanics SET status = ? WHERE id = ?', ['busy', mechanic_id]);

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id,
      action: 'ASSIGN', entityType: 'work_orders', entityId: work_order_id,
      oldValue: workOrder.mechanic_id,
      newValue: { mechanic_id, scheduled_start_at, scheduled_end_at },
    });

    res.json({
      success: true,
      message: `${workOrder.work_order_number} assigned to ${mechanic.full_name}.`,
      conflict,
    });
  } catch (err) {
    console.error('POST /team-leader/assign error:', err);
    res.status(500).json({ success: false, message: 'Failed to assign the job card' });
  }
});

/**
 * GET /api/team-leader/unassigned-technicians
 * Active technicians with no team leader yet — what the "build my team"
 * picker offers. Without this the board is correct and empty on day one,
 * which reads as broken.
 */
router.get('/unassigned-technicians', async (req, res) => {
  try {
    const rows = await query(
      `SELECT id, full_name, phone, specialty, status
         FROM mechanics
        WHERE workshop_id = ? AND is_active = 1 AND team_leader_id IS NULL
        ORDER BY full_name ASC
        LIMIT 200`,
      [req.workshopId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('GET /team-leader/unassigned-technicians error:', err);
    res.status(500).json({ success: false, message: 'Failed to load technicians' });
  }
});

/**
 * POST /api/team-leader/team
 * Add or remove technicians from a leader's team.
 * Body: { mechanic_ids: [...], team_leader_id?, action: 'add' | 'remove' }
 */
router.post('/team', async (req, res) => {
  try {
    const { mechanic_ids, action = 'add' } = req.body || {};
    if (!Array.isArray(mechanic_ids) || !mechanic_ids.length) {
      return res.status(400).json({ success: false, message: 'Pick at least one technician.' });
    }
    if (!['add', 'remove'].includes(action)) {
      return res.status(400).json({ success: false, message: "action must be 'add' or 'remove'." });
    }

    const scope = resolveScope(req);
    const leaderId = scope.scoped ? scope.leaderId : Number(req.body.team_leader_id) || req.user?.id;
    if (!leaderId) {
      return res.status(400).json({ success: false, message: 'No team leader to assign these technicians to.' });
    }

    const placeholders = mechanic_ids.map(() => '?').join(',');
    const result = await execute(
      `UPDATE mechanics SET team_leader_id = ?
        WHERE workshop_id = ? AND id IN (${placeholders})`,
      [action === 'add' ? leaderId : null, req.workshopId, ...mechanic_ids]
    );

    res.json({
      success: true,
      message: action === 'add'
        ? `${result.affectedRows} technician(s) added to the team.`
        : `${result.affectedRows} technician(s) removed from the team.`,
    });
  } catch (err) {
    console.error('POST /team-leader/team error:', err);
    res.status(500).json({ success: false, message: 'Failed to update the team' });
  }
});

export default router;
