/**
 * crm-reminders.js — Service Reminders.
 *
 * Of the CRM modules this is the one that makes money rather than saving time:
 * it brings cars back. The workshop's own enquiry data shows the
 * "owned & repeat" channel converting better than any other, and this
 * manufactures more of it.
 *
 * The engine is deliberately simple and explainable. For each vehicle it finds
 * the last completed job of a given service type, adds that service's interval
 * (months, or kilometres against the recorded odometer), and raises one
 * reminder for the resulting due date. A UNIQUE key on
 * (workshop, vehicle, service_type, due_at) means running it twice raises
 * nothing new — important, because it runs from a daily cron.
 *
 *   GET   /api/crm/reminders           list, filterable
 *   GET   /api/crm/reminders/stats     KPI cards
 *   POST  /api/crm/reminders/generate  run the engine now
 *   POST  /api/crm/reminders           create one by hand
 *   POST  /api/crm/reminders/:id/send  send it on the customer's channel
 *   PATCH /api/crm/reminders/:id       snooze, dismiss, mark booked
 */

import { Router } from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkup, clampText } from '../lib/sanitize.js';

const router = Router();
router.use(authMiddleware);

/**
 * Service intervals. months is the primary rule because every workshop knows
 * a date; km applies only when the vehicle has an odometer reading on file.
 *
 * These are conservative defaults for UAE conditions — heat and dust shorten
 * oil and filter life relative to European schedules. Editable per workshop is
 * a phase-2 concern; hard-coding them now keeps the module shippable.
 */
export const SERVICE_INTERVALS = {
  oil_change:          { months: 6,  km: 10000, label: 'Oil change' },
  general_maintenance: { months: 12, km: 20000, label: 'Periodic maintenance' },
  tire_service:        { months: 24, km: 40000, label: 'Tyre check / rotation' },
  brake_repair:        { months: 18, km: 30000, label: 'Brake inspection' },
  diagnostic:          { months: 12, km: null,  label: 'Diagnostic check' },
  electrical:          { months: 24, km: null,  label: 'Battery / electrical check' },
  transmission:        { months: 36, km: 60000, label: 'Transmission service' },
};

const STATUSES = ['scheduled', 'due', 'sent', 'snoozed', 'booked', 'converted', 'dismissed', 'expired'];
const CHANNELS = ['whatsapp', 'sms', 'email', 'call', 'none'];

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* ═══════════════════════════════════════════════════════════
   The engine.

   Exported so the cron can call it without going through HTTP.
   ═══════════════════════════════════════════════════════════ */
export async function generateReminders(workshopId, { horizonDays = 45, createdBy = null } = {}) {
  // Last completed job per vehicle per service category, with the customer and
  // the odometer reading we hold. Vehicles never serviced are skipped: there is
  // no interval to measure from, and guessing produces reminders nobody trusts.
  const rows = await query(
    `SELECT v.id                AS vehicle_id,
            v.customer_id,
            v.make, v.model, v.plate_number, v.mileage AS current_mileage,
            o.service_category  AS service_type,
            MAX(o.completed_at) AS last_service_at,
            SUBSTRING_INDEX(GROUP_CONCAT(o.id ORDER BY o.completed_at DESC), ',', 1) AS last_wo_id
       FROM vehicles v
       JOIN work_orders o
         ON o.vehicle_id = v.id
        AND o.workshop_id = v.workshop_id
        AND o.status = 'completed'
        AND o.completed_at IS NOT NULL
      WHERE v.workshop_id = ?
        AND v.is_active = 1
        AND v.customer_id IS NOT NULL
      GROUP BY v.id, v.customer_id, v.make, v.model, v.plate_number, v.mileage, o.service_category`,
    [workshopId]
  );

  const horizon = new Date();
  horizon.setDate(horizon.getDate() + horizonDays);

  let created = 0, skipped = 0, considered = 0;

  for (const r of rows) {
    const interval = SERVICE_INTERVALS[r.service_type];
    if (!interval) { skipped++; continue; }   // no rule for this category
    considered++;

    const last = new Date(r.last_service_at);
    const due = new Date(last);
    due.setMonth(due.getMonth() + interval.months);

    // Only raise reminders for what is due within the horizon. Anything
    // further out will be picked up by a later run, which keeps the list short
    // enough for someone to actually work through.
    if (due > horizon) { skipped++; continue; }

    const dueMileage = interval.km && r.current_mileage
      ? Number(r.current_mileage) + interval.km
      : null;

    // How to reach this customer, from their own preference.
    const [cust] = await query(
      'SELECT preferred_channel, phone, email FROM customers WHERE id = ? AND workshop_id = ?',
      [r.customer_id, workshopId]
    );
    let channel = cust?.preferred_channel || 'sms';
    // Do not schedule a channel we cannot actually use.
    if (channel === 'email' && !cust?.email) channel = cust?.phone ? 'sms' : 'none';
    if ((channel === 'sms' || channel === 'whatsapp') && !cust?.phone) channel = cust?.email ? 'email' : 'none';

    try {
      const result = await execute(
        `INSERT INTO service_reminders
           (workshop_id, customer_id, vehicle_id, service_type,
            due_at, due_mileage, last_service_at, last_service_wo_id,
            current_mileage, status, send_channel, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          workshopId, r.customer_id, r.vehicle_id, r.service_type,
          isoDate(due), dueMileage, isoDate(last), Number(r.last_wo_id) || null,
          r.current_mileage || null,
          due <= new Date() ? 'due' : 'scheduled',
          channel, createdBy,
        ]
      );
      if (result.affectedRows) created++;
    } catch (e) {
      // The UNIQUE key doing its job: this reminder already exists.
      if (e.code === 'ER_DUP_ENTRY') { skipped++; continue; }
      throw e;
    }
  }

  // Anything scheduled whose date has arrived becomes due, so the list is
  // correct without the cron having to re-derive it.
  const promoted = await execute(
    `UPDATE service_reminders SET status = 'due'
      WHERE workshop_id = ? AND status = 'scheduled' AND due_at <= CURDATE()`,
    [workshopId]
  );

  // A snooze that has run out is due again.
  const unsnoozed = await execute(
    `UPDATE service_reminders SET status = 'due', snoozed_until = NULL
      WHERE workshop_id = ? AND status = 'snoozed'
        AND snoozed_until IS NOT NULL AND snoozed_until <= CURDATE()`,
    [workshopId]
  );

  return {
    vehicles_considered: considered,
    created,
    skipped,
    promoted_to_due: promoted.affectedRows || 0,
    unsnoozed: unsnoozed.affectedRows || 0,
  };
}

/* ═══════════════════════════════════════════════════════════
   GET / — the reminder list
   ═══════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const { status, service_type, channel, view, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = (page - 1) * limit;

    const where = ['r.workshop_id = ?'];
    const params = [req.workshopId];

    if (view === 'due') where.push("r.status = 'due'");
    else if (view === 'overdue') where.push("r.status IN ('due','sent')", 'r.due_at < CURDATE()');
    else if (view === 'upcoming') where.push("r.status = 'scheduled'");
    else if (view === 'sent') where.push("r.status = 'sent'");
    else if (view === 'won') where.push("r.status IN ('booked','converted')");
    else if (!status) where.push("r.status NOT IN ('dismissed','expired')");

    if (status && STATUSES.includes(status)) { where.push('r.status = ?'); params.push(status); }
    if (service_type) { where.push('r.service_type = ?'); params.push(service_type); }
    if (channel && CHANNELS.includes(channel)) { where.push('r.send_channel = ?'); params.push(channel); }
    if (search) {
      // Make and model are in the search because the table shows the vehicle
      // in column two, so "Toyota" is the obvious thing to type — and it used
      // to return nothing.
      where.push(
        '(c.full_name LIKE ? OR c.phone LIKE ? OR v.plate_number LIKE ?'
        + ' OR v.make LIKE ? OR v.model LIKE ?)'
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }

    const clause = where.join(' AND ');

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM service_reminders r
         LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN vehicles  v ON v.id = r.vehicle_id
        WHERE ${clause}`, params
    );

    const rows = await query(
      `SELECT r.*,
              c.full_name AS customer_name, c.phone AS customer_phone,
              c.email AS customer_email, c.preferred_channel,
              v.make, v.model, v.year, v.plate_number, v.mileage AS vehicle_mileage,
              (r.due_at < CURDATE()) AS is_overdue,
              DATEDIFF(r.due_at, CURDATE()) AS days_until_due
         FROM service_reminders r
         LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN vehicles  v ON v.id = r.vehicle_id
        WHERE ${clause}
        ORDER BY r.due_at ASC, r.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return res.json({ success: true, data: rows, pagination: { page, limit, total } });
  } catch (err) {
    console.error('[CRMReminders] list error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load reminders' });
  }
});

/* ═══════════════════════════════════════════════════════════
   GET /stats — KPI cards, including whether this module pays
   ═══════════════════════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  try {
    const [t] = await query(
      // COALESCE throughout: SUM() over zero rows returns NULL, which reaches
      // the KPI cards as the literal "null".
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'due'), 0)       AS due_now,
              COALESCE(SUM(status = 'scheduled'), 0) AS upcoming,
              COALESCE(SUM(status = 'sent'), 0)      AS awaiting_reply,
              COALESCE(SUM(status IN ('booked','converted')), 0) AS won,
              COALESCE(SUM(status = 'dismissed'), 0) AS dismissed,
              COALESCE(SUM(status IN ('due','sent') AND due_at < CURDATE()), 0) AS overdue
         FROM service_reminders WHERE workshop_id = ?`,
      [req.workshopId]
    );

    // The number that justifies the module: of the reminders actually sent,
    // how many produced a booking. Sent is the denominator, not total — an
    // unsent reminder has had no chance to convert.
    const [conv] = await query(
      `SELECT COALESCE(SUM(sent_at IS NOT NULL), 0) AS sent_total,
              COALESCE(SUM(status IN ('booked','converted')), 0) AS converted_total,
              COALESCE(ROUND(100 * SUM(status IN ('booked','converted'))
                    / NULLIF(SUM(sent_at IS NOT NULL), 0), 1), 0) AS conversion_rate
         FROM service_reminders WHERE workshop_id = ?`,
      [req.workshopId]
    );

    const byType = await query(
      `SELECT service_type, COUNT(*) AS total,
              SUM(status = 'due') AS due_now,
              SUM(status IN ('booked','converted')) AS won
         FROM service_reminders WHERE workshop_id = ?
        GROUP BY service_type ORDER BY total DESC`,
      [req.workshopId]
    );

    return res.json({ success: true, data: { totals: { ...t, ...conv }, by_type: byType } });
  } catch (err) {
    console.error('[CRMReminders] stats error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load reminder stats' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /generate — run the engine on demand
   ═══════════════════════════════════════════════════════════ */
router.post('/generate', async (req, res) => {
  try {
    const horizonDays = Math.min(Math.max(parseInt(req.body?.horizon_days, 10) || 45, 1), 365);
    const result = await generateReminders(req.workshopId, {
      horizonDays, createdBy: req.user?.id || null,
    });
    return res.json({
      success: true,
      message: `${result.created} reminder${result.created === 1 ? '' : 's'} created`,
      data: result,
    });
  } catch (err) {
    console.error('[CRMReminders] generate error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to generate reminders' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST / — create one by hand
   ═══════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.vehicle_id || !b.due_at) {
      return res.status(422).json({
        success: false, message: 'Pick a vehicle and a due date',
        errors: [
          ...(!b.vehicle_id ? [{ field: 'vehicle_id', message: 'Choose a vehicle' }] : []),
          ...(!b.due_at ? [{ field: 'due_at', message: 'Set a due date' }] : []),
        ],
      });
    }

    const [vehicle] = await query(
      'SELECT id, customer_id, mileage FROM vehicles WHERE id = ? AND workshop_id = ?',
      [Number(b.vehicle_id), req.workshopId]
    );
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });
    if (!vehicle.customer_id) {
      return res.status(422).json({
        success: false, message: 'That vehicle has no customer on file, so there is nobody to remind',
      });
    }

    const serviceType = SERVICE_INTERVALS[b.service_type] ? b.service_type : 'general_maintenance';
    const [cust] = await query(
      'SELECT preferred_channel FROM customers WHERE id = ?', [vehicle.customer_id]
    );

    try {
      const result = await execute(
        `INSERT INTO service_reminders
           (workshop_id, customer_id, vehicle_id, service_type, due_at, due_mileage,
            current_mileage, status, send_channel, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.workshopId, vehicle.customer_id, vehicle.id, serviceType,
          String(b.due_at).slice(0, 10),
          b.due_mileage ? Number(b.due_mileage) : null,
          vehicle.mileage || null,
          new Date(b.due_at) <= new Date() ? 'due' : 'scheduled',
          CHANNELS.includes(b.send_channel) ? b.send_channel : (cust?.preferred_channel || 'sms'),
          clampText(b.notes, 2000),
          req.user?.id || null,
        ]
      );
      const [row] = await query('SELECT * FROM service_reminders WHERE id = ?', [result.insertId]);
      return res.status(201).json({ success: true, data: row });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          message: 'That vehicle already has a reminder for this service on that date',
        });
      }
      throw e;
    }
  } catch (err) {
    console.error('[CRMReminders] create error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create the reminder' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/send — deliver it

   Uses whichever sender the channel calls for. Failure is recorded on the row
   rather than thrown away, so a reminder that could not be delivered is
   visible in the list instead of looking sent.
   ═══════════════════════════════════════════════════════════ */
router.post('/:id/send', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [r] = await query(
      `SELECT r.*, c.full_name, c.phone, c.email, v.make, v.model, v.plate_number
         FROM service_reminders r
         LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN vehicles  v ON v.id = r.vehicle_id
        WHERE r.id = ? AND r.workshop_id = ?`,
      [id, req.workshopId]
    );
    if (!r) return res.status(404).json({ success: false, message: 'Reminder not found' });
    if (r.status === 'converted' || r.status === 'dismissed') {
      return res.status(409).json({ success: false, message: `This reminder is already ${r.status}` });
    }

    const label = SERVICE_INTERVALS[r.service_type]?.label || 'a service';
    const vehicle = [r.make, r.model].filter(Boolean).join(' ') || 'your vehicle';
    const plate = r.plate_number ? ` (${r.plate_number})` : '';
    const message =
      `Hello ${r.full_name || 'there'}, your ${vehicle}${plate} is due for ${label.toLowerCase()}. ` +
      `Reply to book a slot at Pioneer Car Service Center, or call 80077799.`;

    let sent = false;
    let error = null;

    try {
      if (r.send_channel === 'email' && r.email) {
        const { sendEmail } = await import('../lib/email.js');
        await sendEmail({
          to: r.email,
          subject: `${vehicle} — ${label} due`,
          html: `<p>${message}</p>`,
          tenantId: req.workshopId,   // email.js names this tenantId
        });
        sent = true;
      } else if ((r.send_channel === 'sms' || r.send_channel === 'whatsapp') && r.phone) {
        const { sendSMS } = await import('../lib/sms.js');
        await sendSMS(r.phone, message);
        sent = true;
      } else if (r.send_channel === 'call') {
        // A call is a person's job. Record the intent and let the task list
        // carry it, rather than pretending a message went out.
        await execute(
          `INSERT INTO crm_tasks
             (workshop_id, title, details, task_type, priority, status,
              customer_id, vehicle_id, related_type, related_id, due_at, created_by)
           VALUES (?,?,?,'call_back','normal','open',?,?,'reminder',?,NOW(),?)`,
          [req.workshopId, `Call ${r.full_name || 'customer'} — ${label} due`, message,
           r.customer_id, r.vehicle_id, r.id, req.user?.id || null]
        );
        return res.json({
          success: true, message: 'Added to the task list as a call back',
          data: { channel: 'call', task_created: true },
        });
      } else {
        error = `No usable ${r.send_channel} contact on file for this customer`;
      }
    } catch (e) {
      error = e.message?.slice(0, 300) || 'Send failed';
    }

    await execute(
      `UPDATE service_reminders
          SET status = ?, sent_at = ?, send_attempts = send_attempts + 1, last_error = ?
        WHERE id = ?`,
      [sent ? 'sent' : r.status, sent ? new Date() : r.sent_at, sent ? null : error, id]
    );

    if (!sent) {
      return res.status(422).json({ success: false, message: error || 'Could not send the reminder' });
    }
    return res.json({ success: true, message: `Reminder sent by ${r.send_channel}` });
  } catch (err) {
    console.error('[CRMReminders] send error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to send the reminder' });
  }
});

/* ═══════════════════════════════════════════════════════════
   PATCH /:id — snooze, dismiss, mark booked
   ═══════════════════════════════════════════════════════════ */
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [];

    if (b.status && STATUSES.includes(b.status)) {
      sets.push('status = ?'); params.push(b.status);
      if (b.status === 'booked' || b.status === 'converted') {
        sets.push('converted_at = NOW()');
      }
    }
    if (b.snooze_days) {
      const days = Math.min(Math.max(Number(b.snooze_days), 1), 365);
      sets.push("status = 'snoozed'", 'snoozed_until = DATE_ADD(CURDATE(), INTERVAL ? DAY)');
      params.push(days);
    }
    if (b.send_channel && CHANNELS.includes(b.send_channel)) {
      sets.push('send_channel = ?'); params.push(b.send_channel);
    }
    if (b.due_at) { sets.push('due_at = ?'); params.push(String(b.due_at).slice(0, 10)); }
    if (b.notes !== undefined) { sets.push('notes = ?'); params.push(clampText(b.notes, 2000)); }
    if (b.converted_work_order_id) {
      sets.push('converted_work_order_id = ?', "status = 'converted'", 'converted_at = NOW()');
      params.push(Number(b.converted_work_order_id));
    }

    if (!sets.length) return res.status(422).json({ success: false, message: 'Nothing to update' });

    const result = await execute(
      `UPDATE service_reminders SET ${sets.join(', ')} WHERE id = ? AND workshop_id = ?`,
      [...params, id, req.workshopId]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Reminder not found' });

    const [row] = await query('SELECT * FROM service_reminders WHERE id = ?', [id]);
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[CRMReminders] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update the reminder' });
  }
});

export default router;
