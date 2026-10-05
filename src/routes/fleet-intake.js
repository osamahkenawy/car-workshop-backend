/**
 * Fleet coordinator intake — the vehicle information section, on its own page.
 *
 * Step 2 of the approved process (whiteboard, 15 Sep 2026) lists five ways the
 * vehicle details and the vehicle issue can reach us: a service advisor typing
 * them, a link for fleet coordinators, the website, WhatsApp and social media.
 * This file is the second of those, and it is the one that replaces real paper
 * — an Aman Taxi "Work Order Generation" sheet, filled in by their fleet
 * supervisor, handed over, and then re-keyed by our advisor. The re-keying is
 * where the chassis numbers get lost.
 *
 * Two deliberate decisions:
 *
 *   1. A coordinator is not a system user. They work for the fleet, not for
 *      Pioneer, and giving each of them a login to maintain (and to revoke
 *      when they change jobs) is a cost with no return. So the page is
 *      tokenised per account, the same pattern as the estimate approval link.
 *      The token says which fleet is submitting, which is why the form never
 *      asks them to pick a customer — they could only get it wrong.
 *
 *   2. A submission is a request, not a work order. Some are duplicates of a
 *      car already in the bay, some are rejected. Writing them straight into
 *      work_orders would put rejected rows into every count, every dashboard
 *      and every month-end figure, so they live in their own table until a
 *      human converts them.
 */

import express from 'express';
import crypto from 'crypto';
import pool, { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkupFields, clampTextFields } from '../lib/sanitize.js';
import { logAudit } from '../lib/audit.js';
import { notifyWorkOrderStatus } from '../lib/notify.js';

const IDENTITY = [
  'plate_number', 'plate_code', 'plate_emirate', 'make', 'model', 'color',
  'vin', 'engine_no', 'fleet_code', 'work_type', 'external_ref',
  'driver_name', 'driver_phone', 'permit_id', 'submitted_by', 'label',
  'contact_name', 'contact_phone',
];
const FREE_TEXT = ['complaint', 'review_note'];
const _clean = (body) => clampTextFields(stripMarkupFields(body || {}, IDENTITY), FREE_TEXT);

/* Shared field normalisation, used by both the public submit and the staff
 * create path so the two cannot drift apart. */
function normaliseSubmission(body) {
  const b = _clean(body);
  const int = (v, max) => {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0 || n > max) return null;
    return n;
  };
  return {
    plate_number:  b.plate_number  ? String(b.plate_number).trim().slice(0, 50) : null,
    plate_code:    b.plate_code    ? String(b.plate_code).trim().slice(0, 10) : null,
    plate_emirate: b.plate_emirate ? String(b.plate_emirate).trim().slice(0, 50) : null,
    make:          b.make          ? String(b.make).trim().slice(0, 100) : null,
    model:         b.model         ? String(b.model).trim().slice(0, 100) : null,
    // A year outside this range is a typo, not a car. Stored as NULL rather
    // than rejected, because a coordinator mistyping the year should not stop
    // a broken taxi being booked in.
    year:          (() => { const y = int(b.year, 2100); return y && y >= 1900 ? y : null; })(),
    color:         b.color         ? String(b.color).trim().slice(0, 50) : null,
    vin:           b.vin           ? String(b.vin).trim().toUpperCase().slice(0, 50) : null,
    engine_no:     b.engine_no     ? String(b.engine_no).trim().slice(0, 50) : null,
    fleet_code:    b.fleet_code    ? String(b.fleet_code).trim().slice(0, 50) : null,
    odometer:      int(b.odometer, 9999999),
    complaint:     b.complaint ? String(b.complaint).trim().slice(0, 2000) : '',
    work_type:     b.work_type     ? String(b.work_type).trim().slice(0, 60) : null,
    external_ref:  b.external_ref  ? String(b.external_ref).trim().slice(0, 60) : null,
    driver_name:   b.driver_name   ? String(b.driver_name).trim().slice(0, 150) : null,
    driver_phone:  b.driver_phone  ? String(b.driver_phone).trim().slice(0, 50) : null,
    permit_id:     b.permit_id     ? String(b.permit_id).trim().slice(0, 60) : null,
    submitted_by:  b.submitted_by  ? String(b.submitted_by).trim().slice(0, 150) : null,
    preferred_date: /^\d{4}-\d{2}-\d{2}$/.test(b.preferred_date || '') ? b.preferred_date : null,
  };
}

/* The three things the process makes mandatory, checked in one place so the
 * public form and the staff form give the same answer. */
function validateSubmission(f) {
  if (!f.complaint) return 'Describe the problem with the vehicle.';
  if (!f.vin) return 'VIN / chassis number is required.';
  if (f.odometer == null) return 'Mileage (odometer reading) is required.';
  if (!f.plate_number && !f.fleet_code) {
    return 'Give either the plate number or your own unit code so we can identify the vehicle.';
  }
  return '';
}

/* Best-effort vehicle match, in confidence order. Never auto-assigns on a
 * weak match: an intake attached to the wrong car writes service history
 * onto a vehicle that was never here, and that is far more expensive to
 * unpick than asking an advisor to confirm. */
async function findVehicleMatch(workshopId, customerId, f) {
  if (f.vin) {
    const [byVin] = await query(
      'SELECT * FROM vehicles WHERE workshop_id = ? AND vin = ? AND is_active = 1 LIMIT 1',
      [workshopId, f.vin]
    );
    if (byVin) return { vehicle: byVin, matched_on: 'vin' };
  }
  if (f.plate_number) {
    const [byPlate] = await query(
      `SELECT * FROM vehicles WHERE workshop_id = ? AND customer_id = ?
         AND plate_number = ? AND is_active = 1 LIMIT 1`,
      [workshopId, customerId, f.plate_number]
    );
    if (byPlate) return { vehicle: byPlate, matched_on: 'plate' };
  }
  if (f.fleet_code) {
    const [byCode] = await query(
      `SELECT * FROM vehicles WHERE workshop_id = ? AND customer_id = ?
         AND fleet_code = ? AND is_active = 1 LIMIT 1`,
      [workshopId, customerId, f.fleet_code]
    );
    if (byCode) return { vehicle: byCode, matched_on: 'fleet_code' };
  }
  return { vehicle: null, matched_on: null };
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC ROUTER — no login. Mounted at /api/public/fleet-intake
   ═══════════════════════════════════════════════════════════════════════ */
const publicRouter = express.Router();

async function loadLink(token) {
  if (!token || !/^[a-f0-9]{16,64}$/i.test(token)) return null;
  const [link] = await query(
    `SELECT l.*, c.full_name AS customer_name, c.code AS customer_code,
            c.customer_class, c.customer_subcategory,
            w.name AS workshop_name
       FROM fleet_intake_links l
       JOIN customers c ON c.id = l.customer_id
       JOIN workshops w ON w.id = l.workshop_id
      WHERE l.token = ?`,
    [token]
  );
  return link || null;
}

// GET /api/public/fleet-intake/:token — what the coordinator sees on open
publicRouter.get('/:token', async (req, res) => {
  try {
    const link = await loadLink(req.params.token);
    // One message for "no such link", "deactivated" and "expired". Telling
    // an anonymous caller which of the three it is turns the endpoint into
    // an oracle for probing valid tokens.
    if (!link || !link.is_active || (link.expires_at && new Date(link.expires_at) < new Date())) {
      return res.status(404).json({ success: false, message: 'This link is no longer valid. Please ask your service contact for a new one.' });
    }

    // Their own vehicles, so the form can offer them rather than making
    // someone retype a chassis number they have given us twenty times.
    const vehicles = await query(
      `SELECT id, plate_number, plate_code, plate_emirate, make, model, year,
              color, vin, engine_no, fleet_code, mileage
         FROM vehicles
        WHERE workshop_id = ? AND customer_id = ? AND is_active = 1
        ORDER BY plate_number LIMIT 500`,
      [link.workshop_id, link.customer_id]
    );

    return res.json({
      success: true,
      data: {
        workshop_name: link.workshop_name,
        customer_name: link.customer_name,
        customer_code: link.customer_code,
        contact_name: link.contact_name,
        label: link.label,
        vehicles,
      },
    });
  } catch (err) {
    console.error('[FleetIntake] Public load error:', err);
    return res.status(500).json({ success: false, message: 'Could not open this form' });
  }
});

// POST /api/public/fleet-intake/:token — submit one vehicle
publicRouter.post('/:token', async (req, res) => {
  try {
    const link = await loadLink(req.params.token);
    if (!link || !link.is_active || (link.expires_at && new Date(link.expires_at) < new Date())) {
      return res.status(404).json({ success: false, message: 'This link is no longer valid. Please ask your service contact for a new one.' });
    }

    const f = normaliseSubmission(req.body);
    const msg = validateSubmission(f);
    if (msg) return res.status(400).json({ success: false, message: msg });

    const { vehicle } = await findVehicleMatch(link.workshop_id, link.customer_id, f);

    // Guard against the same car being submitted twice — a coordinator
    // refreshing the page, or two people in the same office sending the same
    // breakdown. Matched on plate/VIN within the last 24 hours and still
    // unconverted, so a car that legitimately comes back next week is not
    // blocked.
    const [recentDup] = await query(
      `SELECT id, created_at FROM fleet_intake_requests
        WHERE workshop_id = ? AND customer_id = ?
          AND status IN ('submitted', 'accepted')
          AND (   (vin IS NOT NULL AND vin = ?)
               OR (plate_number IS NOT NULL AND plate_number = ?) )
          AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        LIMIT 1`,
      [link.workshop_id, link.customer_id, f.vin, f.plate_number]
    );
    if (recentDup) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_SUBMITTED',
        message: 'This vehicle was already sent to us in the last 24 hours and is waiting to be booked in. Call us if it is urgent.',
      });
    }

    const result = await execute(
      `INSERT INTO fleet_intake_requests
         (workshop_id, link_id, customer_id, vehicle_id,
          plate_number, plate_code, plate_emirate, make, model, year, color,
          vin, engine_no, fleet_code, odometer,
          complaint, work_type, external_ref, driver_name, driver_phone,
          permit_id, submitted_by, preferred_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      [link.workshop_id, link.id, link.customer_id, vehicle ? vehicle.id : null,
       f.plate_number, f.plate_code, f.plate_emirate, f.make, f.model, f.year, f.color,
       f.vin, f.engine_no, f.fleet_code, f.odometer,
       f.complaint, f.work_type, f.external_ref, f.driver_name, f.driver_phone,
       f.permit_id, f.submitted_by || link.contact_name, f.preferred_date]
    );

    await execute(
      'UPDATE fleet_intake_links SET last_used_at = NOW(), submission_count = submission_count + 1 WHERE id = ?',
      [link.id]
    );

    // The reference is what the coordinator writes on their own paperwork,
    // so it has to come back on the response — not just a success tick.
    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        reference: `FI-${String(result.insertId).padStart(6, '0')}`,
        matched_vehicle: vehicle ? { plate_number: vehicle.plate_number, make: vehicle.make, model: vehicle.model } : null,
      },
      message: 'Received. Our service team will confirm shortly.',
    });
  } catch (err) {
    console.error('[FleetIntake] Public submit error:', err);
    return res.status(500).json({ success: false, message: 'Could not send this form. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   STAFF ROUTER — mounted at /api/fleet-intake
   ═══════════════════════════════════════════════════════════════════════ */
const router = express.Router();
router.use(authMiddleware);

/* ── The queue ──────────────────────────────────────────────────────── */
// GET /api/fleet-intake
router.get('/', async (req, res) => {
  try {
    const { status, customer_id, search, page = 1, limit = 50 } = req.query;
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (pg - 1) * lim;

    let where = 'WHERE r.workshop_id = ?';
    const params = [req.workshopId];

    if (status) {
      const wanted = String(status).split(',').map(s => s.trim())
        .filter(s => ['submitted', 'accepted', 'rejected', 'converted'].includes(s));
      if (wanted.length) {
        where += ` AND r.status IN (${wanted.map(() => '?').join(',')})`;
        params.push(...wanted);
      }
    }
    if (customer_id) { where += ' AND r.customer_id = ?'; params.push(customer_id); }
    if (search) {
      where += ` AND (r.plate_number LIKE ? OR r.vin LIKE ? OR r.fleet_code LIKE ?
                      OR r.external_ref LIKE ? OR c.full_name LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM fleet_intake_requests r
         JOIN customers c ON c.id = r.customer_id ${where}`,
      params
    );

    const rows = await query(
      `SELECT r.*,
              c.full_name AS customer_name, c.code AS customer_code,
              c.customer_subcategory,
              v.plate_number AS matched_plate, v.make AS matched_make, v.model AS matched_model,
              l.label AS link_label,
              o.work_order_number
         FROM fleet_intake_requests r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         LEFT JOIN fleet_intake_links l ON l.id = r.link_id
         LEFT JOIN work_orders o ON o.id = r.work_order_id
         ${where}
         ORDER BY FIELD(r.status, 'submitted', 'accepted', 'rejected', 'converted'), r.created_at DESC
         LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    // Counts come from their own query rather than from the rows above: the
    // rows are one page, so counting them would make the "waiting" badge read
    // 50 whatever the real backlog is.
    const countRows = await query(
      `SELECT status, COUNT(*) AS n FROM fleet_intake_requests
        WHERE workshop_id = ? GROUP BY status`,
      [req.workshopId]
    );
    const counts = { submitted: 0, accepted: 0, rejected: 0, converted: 0 };
    for (const r of countRows) counts[r.status] = Number(r.n);

    return res.json({
      success: true,
      data: rows,
      counts,
      pagination: { total: Number(total), page: pg, limit: lim },
    });
  } catch (err) {
    console.error('[FleetIntake] Queue error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load the intake queue' });
  }
});

/* ── Coordinator links ──────────────────────────────────────────────────
 * Defined above GET /:id, because Express matches in definition order and
 * /links would otherwise be swallowed as an id. */
// GET /api/fleet-intake/links
router.get('/links', async (req, res) => {
  try {
    const rows = await query(
      `SELECT l.*, c.full_name AS customer_name, c.code AS customer_code,
              c.customer_subcategory
         FROM fleet_intake_links l
         JOIN customers c ON c.id = l.customer_id
        WHERE l.workshop_id = ?
        ORDER BY c.full_name, l.created_at DESC`,
      [req.workshopId]
    );
    const base = process.env.FRONTEND_URL || '';
    return res.json({
      success: true,
      data: rows.map(r => ({ ...r, url: `${base}/fleet-intake/${r.token}` })),
    });
  } catch (err) {
    console.error('[FleetIntake] Links error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load links' });
  }
});

// POST /api/fleet-intake/links — issue a link to a coordinator
router.post('/links', async (req, res) => {
  try {
    const { customer_id, label, contact_name, contact_phone, expires_at } = _clean(req.body);
    if (!customer_id) {
      return res.status(400).json({ success: false, message: 'Choose the fleet account this link is for' });
    }
    const [customer] = await query(
      'SELECT id, full_name, customer_class FROM customers WHERE id = ? AND workshop_id = ?',
      [customer_id, req.workshopId]
    );
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const token = crypto.randomBytes(24).toString('hex');
    const result = await execute(
      `INSERT INTO fleet_intake_links
         (workshop_id, customer_id, token, label, contact_name, contact_phone, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, customer_id, token,
       label ? String(label).slice(0, 150) : null,
       contact_name ? String(contact_name).slice(0, 150) : null,
       contact_phone ? String(contact_phone).slice(0, 50) : null,
       /^\d{4}-\d{2}-\d{2}/.test(expires_at || '') ? expires_at : null,
       req.user.id]
    );

    await logAudit({
      workshopId: req.workshopId, userId: req.user.id,
      action: 'fleet_intake_link.create', entityType: 'fleet_intake_link', entityId: result.insertId,
      newValue: { customer_id, customer_name: customer.full_name, label: label || null },
    });

    const base = process.env.FRONTEND_URL || '';
    return res.status(201).json({
      success: true,
      data: { id: result.insertId, token, url: `${base}/fleet-intake/${token}` },
    });
  } catch (err) {
    console.error('[FleetIntake] Link create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create the link' });
  }
});

// PATCH /api/fleet-intake/links/:id — activate / deactivate
router.patch('/links/:id', async (req, res) => {
  try {
    const [link] = await query(
      'SELECT id FROM fleet_intake_links WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!link) return res.status(404).json({ success: false, message: 'Link not found' });

    const isActive = req.body.is_active ? 1 : 0;
    await execute('UPDATE fleet_intake_links SET is_active = ? WHERE id = ?', [isActive, link.id]);
    await logAudit({
      workshopId: req.workshopId, userId: req.user.id,
      action: isActive ? 'fleet_intake_link.enable' : 'fleet_intake_link.disable',
      entityType: 'fleet_intake_link', entityId: link.id,
    });
    return res.json({ success: true, message: isActive ? 'Link enabled' : 'Link disabled' });
  } catch (err) {
    console.error('[FleetIntake] Link patch error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update the link' });
  }
});

/* ── One request ────────────────────────────────────────────────────── */
// GET /api/fleet-intake/:id
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT r.*, c.full_name AS customer_name, c.code AS customer_code, c.phone AS customer_phone,
              c.customer_class, c.customer_subcategory,
              l.label AS link_label, l.contact_name AS link_contact,
              o.work_order_number
         FROM fleet_intake_requests r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN fleet_intake_links l ON l.id = r.link_id
         LEFT JOIN work_orders o ON o.id = r.work_order_id
        WHERE r.id = ? AND r.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });

    // Re-run the match at read time, not just at submit. A car whose VIN was
    // added to our records after the coordinator sent this in would otherwise
    // still show as unmatched, and the advisor would create a second vehicle.
    const { vehicle, matched_on } = row.vehicle_id
      ? { vehicle: (await query('SELECT * FROM vehicles WHERE id = ?', [row.vehicle_id]))[0] || null, matched_on: 'stored' }
      : await findVehicleMatch(req.workshopId, row.customer_id, row);

    // Where our record and their form disagree. This is the part an advisor
    // actually needs to look at: overwriting silently is how a fleet's own
    // chassis number quietly replaces the one we read off the car.
    const discrepancies = [];
    if (vehicle) {
      const cmp = [
        ['vin', 'VIN'], ['plate_number', 'Plate number'], ['engine_no', 'Engine number'],
        ['make', 'Make'], ['model', 'Model'], ['fleet_code', 'Unit code'],
      ];
      for (const [field, label] of cmp) {
        const ours = (vehicle[field] || '').toString().trim().toUpperCase();
        const theirs = (row[field] || '').toString().trim().toUpperCase();
        if (ours && theirs && ours !== theirs) {
          discrepancies.push({ field, label, ours: vehicle[field], submitted: row[field] });
        }
      }
    }

    return res.json({
      success: true,
      data: { ...row, matched_vehicle: vehicle || null, matched_on, discrepancies },
    });
  } catch (err) {
    console.error('[FleetIntake] Fetch error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load the request' });
  }
});

// POST /api/fleet-intake/:id/review — accept or reject
router.post('/:id/review', async (req, res) => {
  try {
    const { decision, review_note } = _clean(req.body);
    if (!['accepted', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'Decision must be accepted or rejected' });
    }
    const [row] = await query(
      'SELECT * FROM fleet_intake_requests WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (row.status === 'converted') {
      return res.status(409).json({ success: false, message: 'This request is already a job card and cannot be reviewed again' });
    }
    if (decision === 'rejected' && !String(review_note || '').trim()) {
      // A rejection with no reason is useless to the coordinator who has to
      // act on it, and to whoever reads the queue next week.
      return res.status(400).json({ success: false, message: 'Give a reason when rejecting, so the fleet knows what to fix' });
    }

    await execute(
      `UPDATE fleet_intake_requests
          SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [decision, review_note ? String(review_note).slice(0, 2000) : null, req.user.id, row.id]
    );
    await logAudit({
      workshopId: req.workshopId, userId: req.user.id,
      action: `fleet_intake.${decision}`, entityType: 'fleet_intake_request', entityId: row.id,
      oldValue: { status: row.status },
      newValue: { status: decision, plate_number: row.plate_number, vin: row.vin },
    });

    return res.json({ success: true, message: decision === 'accepted' ? 'Accepted' : 'Rejected' });
  } catch (err) {
    console.error('[FleetIntake] Review error:', err);
    return res.status(500).json({ success: false, message: 'Failed to record the decision' });
  }
});

/**
 * POST /api/fleet-intake/:id/convert — turn a submission into a job card.
 *
 * Body (all optional):
 *   vehicle_id        — confirm the match, or pick a different vehicle
 *   create_vehicle    — true to add the submitted vehicle as a new record
 *   update_vehicle    — true to write the submitted VIN/engine/unit code onto
 *                       the matched vehicle where ours is blank
 *   service_category, work_order_type, scheduled_at
 *
 * Runs as one transaction. Half a conversion — a vehicle created but no job
 * card, or a job card with the request still showing as waiting — is worse
 * than a clean failure, because the queue then lies to whoever looks at it
 * next.
 */
router.post('/:id/convert', async (req, res) => {
  // First transaction in the codebase — everything else runs statement by
  // statement through query()/execute(). A conversion writes to four tables
  // and must not be able to land partly, so it takes a connection of its own.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Locked for the duration: two advisors working the queue at the same
    // moment would otherwise both pass the status check and create two job
    // cards for one broken taxi.
    const [[row]] = await conn.query(
      'SELECT * FROM fleet_intake_requests WHERE id = ? AND workshop_id = ? FOR UPDATE',
      [req.params.id, req.workshopId]
    );
    if (!row) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (row.status === 'converted') {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        code: 'ALREADY_CONVERTED',
        message: 'This request has already been turned into a job card.',
        data: { work_order_id: row.work_order_id },
      });
    }
    if (row.status === 'rejected') {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'This request was rejected. Accept it first if you want to book it in.' });
    }

    const {
      vehicle_id, create_vehicle, update_vehicle,
      service_category = 'general_maintenance',
      work_order_type = 'standard',
      scheduled_at,
    } = req.body || {};

    const [[customer]] = await conn.query(
      'SELECT id, full_name, phone, email FROM customers WHERE id = ? AND workshop_id = ?',
      [row.customer_id, req.workshopId]
    );
    if (!customer) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'The fleet account on this request no longer exists' });
    }

    /* ── Resolve the vehicle ── */
    let vehId = vehicle_id || row.vehicle_id || null;

    if (vehId) {
      const [[veh]] = await conn.query(
        'SELECT id FROM vehicles WHERE id = ? AND workshop_id = ? AND customer_id = ?',
        [vehId, req.workshopId, row.customer_id]
      );
      if (!veh) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'That vehicle does not belong to this fleet account' });
      }
    } else if (create_vehicle) {
      if (!row.make || !row.model) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Make and model are needed to add this vehicle. Edit the request or pick an existing vehicle.' });
      }
      // The VIN check is not repeated here: findVehicleMatch already looks up
      // by VIN first, so reaching this branch with a VIN we hold would mean
      // the match returned a vehicle and vehId would be set. Belt and braces
      // anyway, because an advisor can pass create_vehicle explicitly.
      if (row.vin) {
        const [[dup]] = await conn.query(
          'SELECT id FROM vehicles WHERE workshop_id = ? AND vin = ? AND is_active = 1 LIMIT 1',
          [req.workshopId, row.vin]
        );
        if (dup) {
          await conn.rollback();
          return res.status(409).json({
            success: false,
            code: 'VIN_DUPLICATE',
            message: 'A vehicle with this VIN already exists. Match to it instead of creating a second record.',
            data: { vehicle_id: dup.id },
          });
        }
      }
      const [ins] = await conn.query(
        `INSERT INTO vehicles (workshop_id, customer_id, make, model, year, plate_number,
           plate_code, plate_emirate, vin, engine_no, fleet_code, color, mileage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.workshopId, row.customer_id, row.make, row.model, row.year, row.plate_number,
         row.plate_code, row.plate_emirate, row.vin, row.engine_no, row.fleet_code,
         row.color, row.odometer]
      );
      vehId = ins.insertId;
    } else {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        code: 'VEHICLE_REQUIRED',
        message: 'Match this request to a vehicle, or tick "add as a new vehicle".',
      });
    }

    /* ── Optionally fill gaps on the matched vehicle ──
     * COALESCE only, never an overwrite. Where our record has a value and
     * theirs differs, the difference is surfaced as a discrepancy on the
     * detail screen and a human decides — a fleet's paperwork is not
     * automatically more correct than the number read off the car. */
    if (update_vehicle && vehId) {
      await conn.query(
        `UPDATE vehicles
            SET vin           = COALESCE(NULLIF(vin, ''), ?),
                engine_no     = COALESCE(NULLIF(engine_no, ''), ?),
                fleet_code    = COALESCE(NULLIF(fleet_code, ''), ?),
                plate_code    = COALESCE(NULLIF(plate_code, ''), ?),
                plate_emirate = COALESCE(NULLIF(plate_emirate, ''), ?)
          WHERE id = ? AND workshop_id = ?`,
        [row.vin, row.engine_no, row.fleet_code, row.plate_code, row.plate_emirate,
         vehId, req.workshopId]
      );
    }

    /* ── The mandatory three, checked against what will actually be stored ──
     * The submission passed validation when it came in, but an advisor can
     * have matched it to a vehicle that has no VIN of its own, and that job
     * card would then breach the rule the counter is held to. */
    const [[finalVeh]] = await conn.query(
      'SELECT id, vin, plate_number FROM vehicles WHERE id = ?', [vehId]
    );
    if (!finalVeh?.vin || !String(finalVeh.vin).trim()) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        code: 'VIN_REQUIRED',
        message: 'The matched vehicle has no VIN on file. Tick "copy missing details onto the vehicle", or add the VIN to the vehicle first.',
      });
    }
    if (row.odometer == null) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'This request has no mileage reading. Add one before booking it in.' });
    }

    /* ── The job card ── */
    const VALID_CATEGORIES = ['oil_change', 'brake_repair', 'diagnostic', 'bodywork', 'tire_service',
      'engine_repair', 'transmission', 'electrical', 'general_maintenance', 'other'];
    const VALID_TYPES = ['standard', 'express', 'same_day', 'scheduled', 'warranty'];
    const _cat = VALID_CATEGORIES.includes(service_category) ? service_category : 'general_maintenance';
    const _type = VALID_TYPES.includes(work_order_type) ? work_order_type : 'standard';

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const work_order_number = `WO-${stamp}-${Math.floor(Math.random() * 9000) + 1000}`;

    // Their own reference is kept in the description, not just in a column:
    // it is the first thing the fleet quotes when they call to chase, and an
    // advisor should see it without opening another panel.
    const descParts = [row.complaint];
    if (row.external_ref) descParts.push(`[Fleet ref: ${row.external_ref}]`);
    if (row.work_type) descParts.push(`[Work type: ${row.work_type}]`);

    const notesParts = [];
    if (row.driver_name) notesParts.push(`Driver: ${row.driver_name}${row.driver_phone ? ` (${row.driver_phone})` : ''}`);
    if (row.permit_id) notesParts.push(`Permit ID: ${row.permit_id}`);
    if (row.submitted_by) notesParts.push(`Submitted by: ${row.submitted_by}`);
    notesParts.push(`Fleet intake FI-${String(row.id).padStart(6, '0')}`);

    const [woIns] = await conn.query(
      `INSERT INTO work_orders
         (workshop_id, work_order_number, customer_id, vehicle_id, odometer_in,
          intake_channel, fleet_intake_id, work_order_type, service_category,
          customer_name, customer_phone, customer_email,
          description, scheduled_at, status, service_status_token, notes)
       VALUES (?, ?, ?, ?, ?, 'fleet_link', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [req.workshopId, work_order_number, row.customer_id, vehId, row.odometer,
       row.id, _type, _cat,
       customer.full_name, customer.phone, customer.email || null,
       descParts.join(' '),
       /^\d{4}-\d{2}-\d{2}/.test(scheduled_at || '') ? scheduled_at : (row.preferred_date || null),
       crypto.randomBytes(16).toString('hex'),
       notesParts.join(' | ')]
    );
    const workOrderId = woIns.insertId;

    await conn.query(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [workOrderId, 'pending', req.user.id, `Created from fleet intake FI-${String(row.id).padStart(6, '0')}`]
    );

    // Same monotonic guard as the counter path — a fleet submitting a reading
    // lower than the last one we took must not wind the vehicle backwards.
    await conn.query(
      'UPDATE vehicles SET mileage = ? WHERE id = ? AND (mileage IS NULL OR mileage < ?)',
      [row.odometer, vehId, row.odometer]
    );

    await conn.query(
      `UPDATE fleet_intake_requests
          SET status = 'converted', work_order_id = ?, vehicle_id = ?,
              reviewed_by = ?, reviewed_at = NOW()
        WHERE id = ?`,
      [workOrderId, vehId, req.user.id, row.id]
    );

    await conn.commit();

    // Audited and notified after the commit, so a failure in either cannot
    // roll back a job card that the workshop can already see.
    logAudit({
      workshopId: req.workshopId, userId: req.user.id,
      action: 'fleet_intake.convert', entityType: 'work_order', entityId: workOrderId,
      oldValue: { fleet_intake_id: row.id, status: row.status },
      newValue: { work_order_number, vehicle_id: vehId, odometer_in: row.odometer },
    }).catch(e => console.error('[FleetIntake] Audit error:', e.message));

    const [workOrder] = await query('SELECT * FROM work_orders WHERE id = ?', [workOrderId]);
    notifyWorkOrderStatus({
      order: workOrder, status: 'pending', workshopId: req.workshopId, changedBy: req.user.id,
    }).catch(e => console.error('[FleetIntake] Notify error:', e.message));

    return res.status(201).json({
      success: true,
      data: { work_order_id: workOrderId, work_order_number, vehicle_id: vehId },
      message: `Job card ${work_order_number} created`,
    });
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already gone */ }
    console.error('[FleetIntake] Convert error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create the job card' });
  } finally {
    conn.release();
  }
});

export { router as default, publicRouter as publicFleetIntakeRouter, normaliseSubmission, findVehicleMatch };
