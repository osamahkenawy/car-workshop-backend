/**
 * disputes.js — Complaints.
 *
 * The `disputes` table has existed since the original schema and was later
 * extended (post/03_customer_journey.sql) with a full intake-to-resolution
 * shape: case_number, owner_user_id, intake_channel, acknowledged_at (target:
 * "within one working day"), response_due_at, outcome, outcome_communicated_at
 * ("decision given in writing"), authority_level, changes_made. None of it was
 * ever wired to a route or a page — this file is that wiring.
 *
 * 20260911_complaint_severity_workflow.sql layered on the workshop's actual
 * complaint-management policy on top of that shape:
 *   - severity (S1 safety/repeat, S2 workmanship/billing, S3 conduct/info),
 *     each with its own working-day SLA (see SEVERITY_META) and default
 *     owning tier (authority_level doubles as the escalation tier: advisor
 *     = Tier 1 Service Advisor, manager = Tier 2 Branch Manager, senior =
 *     Tier 3 General Manager)
 *   - a second complaint on the same customer within 90 days is auto-flagged
 *     is_repeat and forced to S1, per policy
 *   - root_cause (+ category) and a corrective_action with an owner/due date,
 *     mandatory before closing an S1
 *   - customer_confirmed_at is the actual close gate: "a case is closed only
 *     when the customer confirms the outcome — not when the work is
 *     finished" — POST /:id/close now requires it (and root_cause for S1)
 *
 * What's deliberately NOT here: an automated escalation notifier. The "time"
 * escalation trigger (target date passes → rises a tier) is surfaced as a
 * computed field for the reporting/list views to act on, not as a cron job
 * that pages anyone — no notification channel for that exists yet.
 *
 *   GET   /api/disputes            list, filterable (supports from/to date range)
 *   GET   /api/disputes/stats      KPI cards (volume, SLA, resolution time, outcome mix, by severity)
 *   GET   /api/disputes/:id        detail
 *   POST  /api/disputes            create (opens as 'open')
 *   PATCH /api/disputes/:id        partial update (only keys present are touched)
 *   POST  /api/disputes/:id/acknowledge  stamp acknowledged_at
 *   POST  /api/disputes/:id/resolve      internal decision: status, outcome, resolution
 *   POST  /api/disputes/:id/communicate  stamp outcome_communicated_at (told the customer)
 *   POST  /api/disputes/:id/confirm      customer confirmed the outcome (the real close gate)
 *   POST  /api/disputes/:id/escalate     bump the owning tier (advisor → manager → senior)
 *   POST  /api/disputes/:id/close        final closure — requires customer confirmation
 *                                        (and root cause, if S1)
 */

import { Router } from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { clampText } from '../lib/sanitize.js';

const router = Router();
router.use(authMiddleware);

const STATUSES = ['open', 'investigating', 'resolved', 'closed'];
const INTAKE_CHANNELS = ['in_person', 'phone', 'email', 'whatsapp', 'portal', 'letter'];
const OUTCOMES = ['pending', 'refund_due', 'charge_correct', 'partial_refund', 'goodwill'];
const AUTHORITY_LEVELS = ['advisor', 'manager', 'senior'];
const SEVERITIES = ['S1', 'S2', 'S3'];
const ROOT_CAUSE_CATEGORIES = ['method', 'machine', 'material', 'manpower', 'measurement', 'environment'];

// Working-day SLA by severity, and who owns it by default (Tier 1/2/3 from
// the policy map onto the authority_level enum this schema already had).
const SEVERITY_META = {
  S1: { resolveDays: 2, defaultTier: 'manager' },   // Safety / repeat failure — 1-2 working days, Branch Manager
  S2: { resolveDays: 5, defaultTier: 'manager' },   // Workmanship / billing — 3-5 working days, Branch Manager
  S3: { resolveDays: 3, defaultTier: 'advisor' },   // Conduct / information — 2-3 working days, Service Advisor
};

function genCaseNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `CMP-${stamp}-${rand}`;
}

const pad = n => String(n).padStart(2, '0');
const mysqlDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
function parseWhen(v) {
  if (!v || Number.isNaN(Date.parse(v))) return null;
  return mysqlDate(new Date(v));
}

// Adds N working days to a date, skipping Fridays — an approximation (the
// real workshop roster isn't a fixed weekly day off, see the KPI import
// script's notes on this), close enough for a target-date estimate.
function addWorkingDays(date, days) {
  const d = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 5) remaining--;
  }
  return d;
}

/* ═══════════════════════════════════════════════════════════
   GET / — list, filterable
   ═══════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const { status, intake_channel, from, to, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
    const offset = (page - 1) * limit;

    const where = ['d.workshop_id = ?'];
    const params = [req.workshopId];

    if (status && STATUSES.includes(status)) { where.push('d.status = ?'); params.push(status); }
    else if (!status) { where.push("d.status IN ('open','investigating')"); }

    if (intake_channel && INTAKE_CHANNELS.includes(intake_channel)) {
      where.push('d.intake_channel = ?'); params.push(intake_channel);
    }
    if (from) { where.push('d.created_at >= ?'); params.push(`${from} 00:00:00`); }
    if (to) { where.push('d.created_at <= ?'); params.push(`${to} 23:59:59`); }
    if (search) {
      where.push('(d.case_number LIKE ? OR c.full_name LIKE ? OR c.phone LIKE ? OR d.reason LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const clause = where.join(' AND ');

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM disputes d
         LEFT JOIN customers c ON c.id = d.customer_id
        WHERE ${clause}`, params
    );

    const rows = await query(
      `SELECT d.id, d.case_number, d.status, d.intake_channel, d.reason, d.amount,
              d.severity, d.is_repeat, d.root_cause, d.root_cause_category,
              d.acknowledged_at, d.response_due_at, d.outcome, d.outcome_communicated_at,
              d.authority_level, d.resolution, d.resolved_at, d.customer_confirmed_at,
              d.escalated_at, d.created_at,
              c.full_name AS customer_name, c.phone AS customer_phone,
              wo.work_order_number,
              ou.full_name AS owner_name,
              (d.response_due_at IS NOT NULL AND d.response_due_at < NOW()
                AND d.status IN ('open','investigating')) AS is_escalation_due
         FROM disputes d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN work_orders wo ON wo.id = d.work_order_id
         LEFT JOIN users ou ON ou.id = d.owner_user_id
        WHERE ${clause}
        ORDER BY d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: Number(total), pages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    console.error('[disputes] list error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load complaints' });
  }
});

/* ═══════════════════════════════════════════════════════════
   GET /stats — KPI cards
   ═══════════════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = ['workshop_id = ?'];
    const params = [req.workshopId];
    if (from) { where.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
    if (to) { where.push('created_at <= ?'); params.push(`${to} 23:59:59`); }
    const clause = where.join(' AND ');

    const [h] = await query(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(status = 'open'), 0) AS open_count,
         COALESCE(SUM(status = 'investigating'), 0) AS investigating_count,
         COALESCE(SUM(status = 'resolved'), 0) AS resolved_count,
         COALESCE(SUM(status = 'closed'), 0) AS closed_count,
         COALESCE(SUM(acknowledged_at IS NOT NULL
                      AND TIMESTAMPDIFF(HOUR, created_at, acknowledged_at) <= 24), 0) AS ack_within_day,
         AVG(CASE WHEN acknowledged_at IS NOT NULL
                  THEN TIMESTAMPDIFF(MINUTE, created_at, acknowledged_at) END) AS avg_ack_minutes,
         AVG(CASE WHEN resolved_at IS NOT NULL
                  THEN TIMESTAMPDIFF(HOUR, created_at, resolved_at) END) AS avg_resolution_hours,
         COALESCE(SUM(response_due_at IS NOT NULL), 0) AS due_count,
         COALESCE(SUM(response_due_at IS NOT NULL AND outcome_communicated_at IS NOT NULL
                      AND outcome_communicated_at <= response_due_at), 0) AS response_on_time
       FROM disputes WHERE ${clause}`,
      params
    );

    const byChannel = await query(
      `SELECT intake_channel AS channel, COUNT(*) AS count
         FROM disputes WHERE ${clause} GROUP BY intake_channel ORDER BY count DESC`,
      params
    );
    const byOutcome = await query(
      `SELECT outcome, COUNT(*) AS count
         FROM disputes WHERE ${clause} GROUP BY outcome ORDER BY count DESC`,
      params
    );
    const bySeverity = await query(
      `SELECT severity,
              COUNT(*) AS count,
              AVG(CASE WHEN resolved_at IS NOT NULL
                       THEN TIMESTAMPDIFF(HOUR, created_at, resolved_at) END) AS avg_resolution_hours,
              COALESCE(SUM(resolved_at IS NOT NULL AND response_due_at IS NOT NULL
                           AND resolved_at <= response_due_at), 0) AS sla_met,
              COALESCE(SUM(resolved_at IS NOT NULL), 0) AS resolved_count
         FROM disputes WHERE ${clause} GROUP BY severity ORDER BY severity`,
      params
    );

    const pct = (num, den) => (den ? Math.round((Number(num) / Number(den)) * 100) : null);
    const total = Number(h.total);

    return res.json({
      success: true,
      data: {
        headline: {
          total,
          open: Number(h.open_count),
          investigating: Number(h.investigating_count),
          resolved: Number(h.resolved_count),
          closed: Number(h.closed_count),
          stillOpen: Number(h.open_count) + Number(h.investigating_count),
          ackSlaPct: pct(h.ack_within_day, total),
          avgAckHours: h.avg_ack_minutes != null ? Math.round((h.avg_ack_minutes / 60) * 10) / 10 : null,
          avgResolutionDays: h.avg_resolution_hours != null ? Math.round((h.avg_resolution_hours / 24) * 10) / 10 : null,
          responseSlaPct: pct(h.response_on_time, h.due_count),
          responseSlaTracked: Number(h.due_count),
          resolutionRatePct: pct(Number(h.resolved_count) + Number(h.closed_count), total),
        },
        by_channel: byChannel,
        by_outcome: byOutcome,
        by_severity: bySeverity.map(r => ({
          severity: r.severity,
          count: Number(r.count),
          avgResolutionDays: r.avg_resolution_hours != null ? Math.round((r.avg_resolution_hours / 24) * 10) / 10 : null,
          slaCompliancePct: pct(r.sla_met, r.resolved_count),
        })),
      },
    });
  } catch (err) {
    console.error('[disputes] stats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load complaint stats' });
  }
});

/* ═══════════════════════════════════════════════════════════
   GET /:id — detail
   ═══════════════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT d.*,
              c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
              wo.work_order_number,
              ou.full_name AS owner_name,
              cb.full_name AS created_by_name,
              rb.full_name AS resolved_by_name
         FROM disputes d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN work_orders wo ON wo.id = d.work_order_id
         LEFT JOIN users ou ON ou.id = d.owner_user_id
         LEFT JOIN users cb ON cb.id = d.created_by
         LEFT JOIN users rb ON rb.id = d.resolved_by
        WHERE d.id = ? AND d.workshop_id = ?`,
      [Number(req.params.id), req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Complaint not found' });
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[disputes] detail error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load the complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST / — create (opens as 'open')
   ═══════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.reason || !String(b.reason).trim()) {
      return res.status(422).json({
        success: false, message: 'Describe what the complaint is about',
        errors: [{ field: 'reason', message: 'A reason is required' }],
      });
    }

    const customerId = b.customer_id ? Number(b.customer_id) : null;

    // Repeat trigger: a second complaint on this customer within 90 days is
    // raised to S1 and reviewed at Tier 3, per policy — regardless of what
    // severity was picked on the form.
    let severity = SEVERITIES.includes(b.severity) ? b.severity : 'S2';
    let isRepeat = false;
    if (customerId) {
      const [{ c: priorCount } = { c: 0 }] = await query(
        `SELECT COUNT(*) AS c FROM disputes
          WHERE workshop_id = ? AND customer_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)`,
        [req.workshopId, customerId]
      );
      if (Number(priorCount) > 0) { isRepeat = true; severity = 'S1'; }
    }

    const meta = SEVERITY_META[severity];
    const responseDueAt = b.response_due_at ? parseWhen(b.response_due_at) : mysqlDate(addWorkingDays(new Date(), meta.resolveDays));
    const authorityLevel = AUTHORITY_LEVELS.includes(b.authority_level) ? b.authority_level : meta.defaultTier;

    const caseNumber = genCaseNumber();
    const result = await execute(
      `INSERT INTO disputes
         (workshop_id, work_order_id, invoice_id, customer_id, amount, reason, status,
          case_number, owner_user_id, intake_channel, response_due_at, authority_level,
          severity, is_repeat, created_by, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?,?,?,?,?, ?,?, ?, NOW())`,
      [
        req.workshopId,
        b.work_order_id ? Number(b.work_order_id) : null,
        b.invoice_id ? Number(b.invoice_id) : null,
        customerId,
        b.amount != null && b.amount !== '' ? Number(b.amount) : 0,
        clampText(b.reason, 5000),
        caseNumber,
        b.owner_user_id ? Number(b.owner_user_id) : (req.user?.id || null),
        INTAKE_CHANNELS.includes(b.intake_channel) ? b.intake_channel : 'in_person',
        responseDueAt,
        authorityLevel,
        severity,
        isRepeat ? 1 : 0,
        req.user?.id || null,
      ]
    );

    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('[disputes] create error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to log the complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════
   PATCH /:id — partial update (only keys present are touched)
   ═══════════════════════════════════════════════════════════ */
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [];
    const has = k => Object.prototype.hasOwnProperty.call(b, k);

    if (has('reason') && String(b.reason).trim()) { sets.push('reason = ?'); params.push(clampText(b.reason, 5000)); }
    if (has('amount')) { sets.push('amount = ?'); params.push(b.amount != null && b.amount !== '' ? Number(b.amount) : 0); }
    if (has('intake_channel') && INTAKE_CHANNELS.includes(b.intake_channel)) {
      sets.push('intake_channel = ?'); params.push(b.intake_channel);
    }
    if (has('authority_level') && AUTHORITY_LEVELS.includes(b.authority_level)) {
      sets.push('authority_level = ?'); params.push(b.authority_level);
    }
    if (has('owner_user_id')) { sets.push('owner_user_id = ?'); params.push(b.owner_user_id ? Number(b.owner_user_id) : null); }
    if (has('response_due_at')) { sets.push('response_due_at = ?'); params.push(parseWhen(b.response_due_at)); }
    if (has('work_order_id')) { sets.push('work_order_id = ?'); params.push(b.work_order_id ? Number(b.work_order_id) : null); }
    if (has('invoice_id')) { sets.push('invoice_id = ?'); params.push(b.invoice_id ? Number(b.invoice_id) : null); }
    if (has('customer_id')) { sets.push('customer_id = ?'); params.push(b.customer_id ? Number(b.customer_id) : null); }
    if (has('changes_made')) { sets.push('changes_made = ?'); params.push(clampText(b.changes_made, 5000)); }
    if (has('resolution')) { sets.push('resolution = ?'); params.push(clampText(b.resolution, 5000)); }
    if (has('outcome') && OUTCOMES.includes(b.outcome)) { sets.push('outcome = ?'); params.push(b.outcome); }
    if (has('severity') && SEVERITIES.includes(b.severity)) { sets.push('severity = ?'); params.push(b.severity); }
    if (has('root_cause')) { sets.push('root_cause = ?'); params.push(clampText(b.root_cause, 5000)); }
    if (has('root_cause_category') && (b.root_cause_category === null || ROOT_CAUSE_CATEGORIES.includes(b.root_cause_category))) {
      sets.push('root_cause_category = ?'); params.push(b.root_cause_category || null);
    }
    if (has('corrective_action')) { sets.push('corrective_action = ?'); params.push(clampText(b.corrective_action, 5000)); }
    if (has('corrective_action_owner')) { sets.push('corrective_action_owner = ?'); params.push(b.corrective_action_owner ? Number(b.corrective_action_owner) : null); }
    if (has('corrective_action_due_at')) { sets.push('corrective_action_due_at = ?'); params.push(b.corrective_action_due_at || null); }
    if (has('corrective_action_closed_at')) { sets.push('corrective_action_closed_at = ?'); params.push(parseWhen(b.corrective_action_closed_at)); }

    if (has('status') && STATUSES.includes(b.status)) {
      sets.push('status = ?'); params.push(b.status);
      if (b.status === 'investigating' && !has('acknowledged_at')) {
        // Moving a case into investigation is itself an acknowledgement if
        // nobody has stamped one yet — the case is demonstrably being looked at.
        sets.push('acknowledged_at = COALESCE(acknowledged_at, NOW())');
      }
    }

    if (!sets.length) return res.status(422).json({ success: false, message: 'Nothing to update' });

    const result = await execute(
      `UPDATE disputes SET ${sets.join(', ')} WHERE id = ? AND workshop_id = ?`,
      [...params, id, req.workshopId]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Complaint not found' });

    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[disputes] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update the complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/acknowledge — stamp acknowledged_at (idempotent)
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/acknowledge', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await execute(
      `UPDATE disputes SET acknowledged_at = COALESCE(acknowledged_at, NOW())
        WHERE id = ? AND workshop_id = ?`,
      [id, req.workshopId]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Complaint not found' });
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: 'Acknowledged.' });
  } catch (err) {
    console.error('[disputes] acknowledge error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to acknowledge the complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/resolve — the internal decision (status, outcome, resolution)

   Deliberately separate from /communicate: the schema tracks resolved_at
   (we decided) and outcome_communicated_at (we told the customer, in
   writing) as two different moments, because a decision sitting unwritten
   in someone's inbox is not the same as a customer who has actually heard it.
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/resolve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : 'pending';

    const [existing] = await query('SELECT severity FROM disputes WHERE id = ? AND workshop_id = ?', [id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Complaint not found' });
    if (existing.severity === 'S1' && !String(b.root_cause || '').trim()) {
      return res.status(422).json({
        success: false, message: 'Root cause is required for an S1 complaint before it can be resolved',
        errors: [{ field: 'root_cause', message: 'Required for S1' }],
      });
    }

    const result = await execute(
      `UPDATE disputes
          SET status = 'resolved', resolved_at = NOW(), resolved_by = ?,
              acknowledged_at = COALESCE(acknowledged_at, NOW()),
              outcome = ?,
              resolution = COALESCE(?, resolution),
              changes_made = COALESCE(?, changes_made),
              root_cause = COALESCE(?, root_cause),
              root_cause_category = COALESCE(?, root_cause_category),
              corrective_action = COALESCE(?, corrective_action),
              corrective_action_owner = COALESCE(?, corrective_action_owner),
              corrective_action_due_at = COALESCE(?, corrective_action_due_at)
        WHERE id = ? AND workshop_id = ? AND status IN ('open','investigating')`,
      [
        req.user?.id || null, outcome,
        b.resolution ? clampText(b.resolution, 5000) : null,
        b.changes_made ? clampText(b.changes_made, 5000) : null,
        b.root_cause ? clampText(b.root_cause, 5000) : null,
        ROOT_CAUSE_CATEGORIES.includes(b.root_cause_category) ? b.root_cause_category : null,
        b.corrective_action ? clampText(b.corrective_action, 5000) : null,
        b.corrective_action_owner ? Number(b.corrective_action_owner) : null,
        b.corrective_action_due_at || null,
        id, req.workshopId,
      ]
    );
    if (!result.affectedRows) {
      return res.status(409).json({
        success: false, message: 'That complaint is not open — it may already be resolved or closed',
      });
    }
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: 'Marked resolved.' });
  } catch (err) {
    console.error('[disputes] resolve error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to resolve the complaint' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/communicate — the decision was given to the customer, in writing
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/communicate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await execute(
      `UPDATE disputes SET outcome_communicated_at = COALESCE(outcome_communicated_at, NOW())
        WHERE id = ? AND workshop_id = ? AND status IN ('resolved','closed')`,
      [id, req.workshopId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({
        success: false, message: 'Resolve the complaint before recording that the outcome was communicated',
      });
    }
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: 'Recorded as communicated.' });
  } catch (err) {
    console.error('[disputes] communicate error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to record that' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/confirm — the customer confirmed the outcome. The actual close
   gate: "a case is closed only when the customer confirms the outcome — not
   when the work is finished."
   ════════════════════════════════════════════════════════ */
router.post('/:id/confirm', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await execute(
      `UPDATE disputes SET customer_confirmed_at = COALESCE(customer_confirmed_at, NOW())
        WHERE id = ? AND workshop_id = ? AND status = 'resolved'`,
      [id, req.workshopId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({
        success: false, message: 'Resolve the complaint before recording the customer\'s confirmation',
      });
    }
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: 'Customer confirmation recorded.' });
  } catch (err) {
    console.error('[disputes] confirm error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to record the confirmation' });
  }
});

/* ════════════════════════════════════════════════════════
   POST /:id/escalate — manual bump to the next tier (the "request" trigger:
   a customer asking for someone more senior, escalated without qualification).
   The "time" trigger (target date passed) is surfaced via is_escalation_due
   on the list instead of auto-escalating here — no notification channel
   exists yet to page anyone, so nothing should silently change ownership.
   ════════════════════════════════════════════════════════ */
const NEXT_TIER = { advisor: 'manager', manager: 'senior', senior: 'senior' };
router.post('/:id/escalate', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await query(
      'SELECT authority_level FROM disputes WHERE id = ? AND workshop_id = ?', [id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Complaint not found' });
    const nextTier = NEXT_TIER[existing.authority_level] || 'senior';

    await execute(
      `UPDATE disputes SET authority_level = ?, escalated_at = NOW() WHERE id = ? AND workshop_id = ?`,
      [nextTier, id, req.workshopId]
    );
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: `Escalated to ${nextTier}.` });
  } catch (err) {
    console.error('[disputes] escalate error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to escalate the complaint' });
  }
});
router.post('/:id/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await query(
      'SELECT status, severity, root_cause, customer_confirmed_at FROM disputes WHERE id = ? AND workshop_id = ?',
      [id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Complaint not found' });
    if (existing.status !== 'resolved') {
      return res.status(409).json({ success: false, message: 'Only a resolved complaint can be closed' });
    }
    if (!existing.customer_confirmed_at) {
      return res.status(422).json({
        success: false,
        message: 'The customer needs to confirm the outcome before this can be closed',
      });
    }
    if (existing.severity === 'S1' && !String(existing.root_cause || '').trim()) {
      return res.status(422).json({
        success: false,
        message: 'Root cause is required for an S1 complaint before it can be closed',
      });
    }

    const result = await execute(
      `UPDATE disputes SET status = 'closed'
        WHERE id = ? AND workshop_id = ? AND status = 'resolved'`,
      [id, req.workshopId]
    );
    if (!result.affectedRows) {
      return res.status(409).json({
        success: false, message: 'Only a resolved complaint can be closed',
      });
    }
    const [row] = await query('SELECT * FROM disputes WHERE id = ?', [id]);
    return res.json({ success: true, data: row, message: 'Closed.' });
  } catch (err) {
    console.error('[disputes] close error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to close the complaint' });
  }
});

export default router;
