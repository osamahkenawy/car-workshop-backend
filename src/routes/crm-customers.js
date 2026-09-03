/**
 * crm-customers.js — Customer 360.
 *
 * One screen per customer, assembling history the platform already captures.
 * Enquiries, work orders, invoices, vehicles, feedback and messages each live
 * in their own table; nothing here copies them into a timeline table, because
 * two sources of truth drift. The timeline is built on read.
 *
 * The only stored records are in customer_activities, and only for things a
 * person types in — a phone call, a walk-in, a note.
 *
 *   GET  /api/crm/customers/:id            the 360 view
 *   GET  /api/crm/customers/:id/timeline   just the timeline, paged
 *   POST /api/crm/customers/:id/activities log a call or a note
 *   PATCH /api/crm/customers/:id/consent   marketing consent + channel
 */

import { Router } from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkup, clampText } from '../lib/sanitize.js';

const router = Router();
router.use(authMiddleware);

/** Does a table exist? Several are optional depending on migration state. */
const tableCache = new Map();
async function tableExists(name) {
  if (tableCache.has(name)) return tableCache.get(name);
  const rows = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`, [name]
  );
  const ok = rows.length > 0;
  tableCache.set(name, ok);
  return ok;
}

/* ═══════════════════════════════════════════════════════════
   GET /:id — everything known about one customer
   ═══════════════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId < 1) {
      return res.status(400).json({ success: false, message: 'Invalid customer id' });
    }

    const [customer] = await query(
      `SELECT id, full_name, company_name, phone, phone_alt, email,
              address_line1, address_line2, area, city, emirate,
              type, client_category, credit_limit, notes, is_active,
              marketing_consent, marketing_consent_at, preferred_channel,
              created_at
         FROM customers WHERE id = ? AND workshop_id = ?`,
      [customerId, req.workshopId]
    );
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    // ── Vehicles, each with its last completed job ──
    const vehicles = await query(
      `SELECT v.id, v.make, v.model, v.year, v.plate_number, v.color, v.mileage,
              v.fuel_type, v.transmission,
              (SELECT MAX(o.completed_at) FROM work_orders o
                WHERE o.vehicle_id = v.id AND o.status = 'completed') AS last_service_at,
              (SELECT COUNT(*) FROM work_orders o
                WHERE o.vehicle_id = v.id AND o.status = 'completed') AS jobs_completed
         FROM vehicles v
        WHERE v.customer_id = ? AND v.workshop_id = ?
        ORDER BY v.created_at DESC`,
      [customerId, req.workshopId]
    );

    // ── The numbers that decide how you treat this customer ──
    const [spend] = await query(
      `SELECT COUNT(*) AS jobs_total,
              SUM(status = 'completed') AS jobs_completed,
              SUM(status = 'cancelled') AS jobs_lost,
              -- NULLIF before COALESCE: total_amount is 0.00 rather than NULL on
              -- much of the existing data, and COALESCE returns the first
              -- NON-NULL value, so a plain COALESCE returns that zero and never
              -- reaches service_fee. That reported AED 0 lifetime value for a
              -- customer with 55 completed jobs.
              COALESCE(SUM(CASE WHEN status = 'completed'
                    THEN COALESCE(NULLIF(total_amount, 0), service_fee, 0) ELSE 0 END), 0) AS lifetime_value,
              COALESCE(AVG(CASE WHEN status = 'completed'
                    THEN COALESCE(NULLIF(total_amount, 0), service_fee, 0) END), 0) AS avg_job_value,
              MAX(completed_at) AS last_visit_at,
              MIN(created_at)   AS first_seen_at
         FROM work_orders WHERE customer_id = ? AND workshop_id = ?`,
      [customerId, req.workshopId]
    );

    const [enq] = await query(
      `SELECT COUNT(*) AS enquiries_total,
              SUM(status = 'converted') AS enquiries_converted,
              SUM(status IN ('new','quoted','nurture')) AS enquiries_open
         FROM enquiries WHERE customer_id = ? AND workshop_id = ?`,
      [customerId, req.workshopId]
    );

    // ── Feedback, when the survey module has data for them ──
    let feedback = null;
    if (await tableExists('survey_responses')) {
      const [f] = await query(
        `SELECT COUNT(*) AS responses,
                ROUND(AVG(nps_score), 1)  AS avg_nps,
                ROUND(AVG(csat_avg), 1)  AS avg_csat,
                MAX(created_at)           AS last_response_at
           FROM survey_responses
          WHERE workshop_id = ? AND customer_id = ?`,
        [req.workshopId, customerId]
      ).catch(() => [null]);
      feedback = f || null;
    }

    const timeline = await buildTimeline(req.workshopId, customerId, 40, 0);

    // Open tasks for this customer, so the 360 view is actionable rather than
    // just informative.
    const tasks = await query(
      `SELECT id, title, task_type, priority, status, due_at, assigned_to
         FROM crm_tasks
        WHERE workshop_id = ? AND customer_id = ? AND status IN ('open','in_progress')
        ORDER BY due_at IS NULL, due_at ASC LIMIT 20`,
      [req.workshopId, customerId]
    );

    const reminders = await query(
      `SELECT r.id, r.service_type, r.due_at, r.due_mileage, r.status, r.send_channel,
              v.make, v.model, v.plate_number
         FROM service_reminders r
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.workshop_id = ? AND r.customer_id = ?
          AND r.status NOT IN ('dismissed','expired','converted')
        ORDER BY r.due_at ASC LIMIT 20`,
      [req.workshopId, customerId]
    );

    return res.json({
      success: true,
      data: {
        customer,
        vehicles,
        stats: {
          ...spend,
          ...enq,
          // A returning customer is worth knowing about at a glance.
          is_repeat: Number(spend?.jobs_completed || 0) > 1,
          days_since_last_visit: spend?.last_visit_at
            ? Math.floor((Date.now() - new Date(spend.last_visit_at)) / 86400000)
            : null,
        },
        feedback,
        timeline,
        tasks,
        reminders,
      },
    });
  } catch (err) {
    console.error('[CRM360] error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load customer' });
  }
});

/* ═══════════════════════════════════════════════════════════
   The timeline — one ordered stream from several tables.

   Each source contributes rows in a common shape, then the lot is sorted by
   date. Paging is applied after the merge, which is correct but means the
   sources are each queried with the same window; fine at the volumes a single
   customer produces, and it avoids a UNION over tables whose columns differ.
   ═══════════════════════════════════════════════════════════ */
async function buildTimeline(workshopId, customerId, limit = 40, offset = 0) {
  const window = limit + offset + 20;
  const events = [];

  const enquiries = await query(
    `SELECT id, enquiry_number, status, service_requested, source_channel,
            quoted_amount, created_at
       FROM enquiries WHERE workshop_id = ? AND customer_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    [workshopId, customerId, window]
  );
  for (const e of enquiries) {
    events.push({
      kind: 'enquiry', id: e.id, at: e.created_at,
      title: `Enquiry ${e.enquiry_number}`,
      detail: e.service_requested || null,
      meta: { status: e.status, channel: e.source_channel, amount: e.quoted_amount },
    });
  }

  const orders = await query(
    `SELECT o.id, o.work_order_number, o.status, o.service_category,
            COALESCE(NULLIF(o.total_amount, 0), o.service_fee) AS amount,
            o.created_at, o.completed_at,
            v.make, v.model, v.plate_number
       FROM work_orders o
       LEFT JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.workshop_id = ? AND o.customer_id = ?
      ORDER BY o.created_at DESC LIMIT ?`,
    [workshopId, customerId, window]
  );
  for (const o of orders) {
    const vehicle = [o.make, o.model].filter(Boolean).join(' ') || null;
    events.push({
      kind: 'work_order', id: o.id, at: o.created_at,
      title: `Work order ${o.work_order_number}`,
      detail: [vehicle, o.plate_number].filter(Boolean).join(' · ') || null,
      meta: { status: o.status, category: o.service_category, amount: o.amount },
    });
    // A completed job is a separate moment from the job being raised, and it is
    // usually the one staff are looking for.
    if (o.completed_at) {
      events.push({
        kind: 'work_order_completed', id: o.id, at: o.completed_at,
        title: `Completed ${o.work_order_number}`,
        detail: vehicle,
        meta: { amount: o.amount },
      });
    }
  }

  if (await tableExists('invoices')) {
    const invoices = await query(
      `SELECT id, invoice_number, status, total_amount, created_at
         FROM invoices WHERE workshop_id = ? AND customer_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      [workshopId, customerId, window]
    ).catch(() => []);
    for (const i of invoices) {
      events.push({
        kind: 'invoice', id: i.id, at: i.created_at,
        title: `Invoice ${i.invoice_number || i.id}`,
        detail: null,
        meta: { status: i.status, amount: i.total_amount },
      });
    }
  }

  if (await tableExists('survey_responses')) {
    const responses = await query(
      `SELECT id, nps_score, csat_avg, ces_avg, nps_reason, created_at
         FROM survey_responses WHERE workshop_id = ? AND customer_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      [workshopId, customerId, window]
    ).catch(() => []);
    for (const r of responses) {
      events.push({
        kind: 'feedback', id: r.id, at: r.created_at,
        title: 'Feedback received',
        detail: r.nps_reason || null,
        meta: { nps: r.nps_score, csat: r.csat_avg, ces: r.ces_avg },
      });
    }
  }

  const activities = await query(
    `SELECT a.id, a.activity_type, a.subject, a.body, a.occurred_at,
            u.full_name AS by_name
       FROM customer_activities a
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.workshop_id = ? AND a.customer_id = ?
      ORDER BY a.occurred_at DESC LIMIT ?`,
    [workshopId, customerId, window]
  );
  for (const a of activities) {
    events.push({
      kind: 'activity', id: a.id, at: a.occurred_at,
      title: a.subject || a.activity_type.replace(/_/g, ' '),
      detail: a.body || null,
      meta: { activity_type: a.activity_type, by: a.by_name },
    });
  }

  const reminders = await query(
    `SELECT id, service_type, status, sent_at, due_at, send_channel
       FROM service_reminders
      WHERE workshop_id = ? AND customer_id = ? AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT ?`,
    [workshopId, customerId, window]
  );
  for (const r of reminders) {
    events.push({
      kind: 'reminder_sent', id: r.id, at: r.sent_at,
      title: 'Service reminder sent',
      detail: r.service_type.replace(/_/g, ' '),
      meta: { channel: r.send_channel, status: r.status, due_at: r.due_at },
    });
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { total: events.length, events: events.slice(offset, offset + limit) };
}

/* ═══════════════════════════════════════════════════════════
   GET /:id/timeline — paged, for "load more"
   ═══════════════════════════════════════════════════════════ */
router.get('/:id/timeline', async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const timeline = await buildTimeline(req.workshopId, customerId, limit, offset);
    return res.json({ success: true, data: timeline });
  } catch (err) {
    console.error('[CRM360] timeline error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load timeline' });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /:id/activities — log a call, a visit, a note
   ═══════════════════════════════════════════════════════════ */
const ACTIVITY_TYPES = ['call_in', 'call_out', 'whatsapp', 'email', 'visit', 'note', 'complaint', 'other'];
const RELATED_TYPES = ['enquiry', 'work_order', 'invoice', 'quote', 'warranty_claim', 'none'];

router.post('/:id/activities', async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const [exists] = await query(
      'SELECT id FROM customers WHERE id = ? AND workshop_id = ? LIMIT 1',
      [customerId, req.workshopId]
    );
    if (!exists) return res.status(404).json({ success: false, message: 'Customer not found' });

    const b = req.body || {};
    const activityType = ACTIVITY_TYPES.includes(b.activity_type) ? b.activity_type : 'note';
    const relatedType = RELATED_TYPES.includes(b.related_type) ? b.related_type : 'none';

    if (!b.subject && !b.body) {
      return res.status(422).json({
        success: false, message: 'Add a subject or a note so the entry means something later',
      });
    }

    // occurred_at may legitimately be backdated - staff log a call after the
    // fact - but not into the future.
    let occurredAt = new Date();
    if (b.occurred_at && !Number.isNaN(Date.parse(b.occurred_at))) {
      const parsed = new Date(b.occurred_at);
      if (parsed <= new Date()) occurredAt = parsed;
    }
    const pad = n => String(n).padStart(2, '0');
    const asMysql = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const result = await execute(
      `INSERT INTO customer_activities
         (workshop_id, customer_id, vehicle_id, activity_type, subject, body,
          related_type, related_id, occurred_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        req.workshopId, customerId,
        b.vehicle_id ? Number(b.vehicle_id) : null,
        activityType,
        stripMarkup(b.subject, 200),
        clampText(b.body, 5000),
        relatedType,
        b.related_id ? Number(b.related_id) : null,
        asMysql(occurredAt),
        req.user?.id || null,
      ]
    );

    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    console.error('[CRM360] activity error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to save the entry' });
  }
});

/* ═══════════════════════════════════════════════════════════
   PATCH /:id/consent — marketing consent and preferred channel

   Kept explicit rather than folded into the customer update, so consent is
   always an intentional act with a timestamp and a recorded source.
   ═══════════════════════════════════════════════════════════ */
router.patch('/:id/consent', async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [];

    if (b.marketing_consent !== undefined) {
      const on = b.marketing_consent === true || b.marketing_consent === 1 || b.marketing_consent === '1';
      sets.push('marketing_consent = ?', 'marketing_consent_at = ?', 'marketing_consent_source = ?');
      params.push(on ? 1 : 0, on ? new Date() : null,
        on ? stripMarkup(b.source || 'staff', 60) : null);
    }
    if (['whatsapp', 'sms', 'email', 'call'].includes(b.preferred_channel)) {
      sets.push('preferred_channel = ?');
      params.push(b.preferred_channel);
    }
    if (!sets.length) {
      return res.status(422).json({ success: false, message: 'Nothing to update' });
    }

    const result = await execute(
      `UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND workshop_id = ?`,
      [...params, customerId, req.workshopId]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    return res.json({ success: true, message: 'Preferences updated' });
  } catch (err) {
    console.error('[CRM360] consent error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to update preferences' });
  }
});

export default router;
