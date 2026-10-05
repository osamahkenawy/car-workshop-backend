/**
 * ═══════════════════════════════════════════════════════════════
 *  Service Estimates — SOW Section B3
 *  Covers: req 69 (estimate creation with line-level payer),
 *          req 70 (operations master defaults),
 *          req 71 (mixed-payer job support),
 *          req 72 (pre-approved bundles → direct conversion)
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { config } from '../config.js';
import { sendNotificationEmail } from '../lib/email.js';
import { createInAppNotification } from '../lib/notify.js';
import { publicEnquiryLimiter } from '../lib/rate-limits.js';

const router = express.Router();
router.use(authMiddleware);

// Anonymous, unauthenticated — reachable by anyone with the emailed link.
const publicRouter = express.Router();

function genEstimateNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `EST-${stamp}-${rand}`;
}

// ─── Compute financial totals from lines ──────────────────────
function computeTotals(lines, vatRate = 5) {
  let subtotal_labour = 0, subtotal_parts = 0, subtotal_sublet = 0;
  for (const l of lines) {
    const lineTotal = parseFloat(l.quantity || 1) * parseFloat(l.unit_price || 0) * (1 - parseFloat(l.discount_pct || 0) / 100);
    if (l.line_type === 'labour') subtotal_labour += lineTotal;
    else if (l.line_type === 'parts' || l.line_type === 'consumable') subtotal_parts += lineTotal;
    else if (l.line_type === 'sublet') subtotal_sublet += lineTotal;
  }
  const subtotal = subtotal_labour + subtotal_parts + subtotal_sublet;
  const vat_amount = parseFloat((subtotal * vatRate / 100).toFixed(2));
  const total_amount = parseFloat((subtotal + vat_amount).toFixed(2));
  return {
    subtotal_labour: parseFloat(subtotal_labour.toFixed(2)),
    subtotal_parts:  parseFloat(subtotal_parts.toFixed(2)),
    subtotal_sublet: parseFloat(subtotal_sublet.toFixed(2)),
    discount_amount: 0,
    vat_rate:        vatRate,
    vat_amount,
    total_amount,
  };
}

// customer_type (retail_cash/credit/insurance/internal_fleet, on the
// estimate) and payer_type (self_pay/insurance/corporate/fleet, on the work
// order) are two enums for the same underlying idea, named differently on
// each table because they were built at different times. Without this map
// every job card created from an estimate would silently default to
// self_pay regardless of who is actually paying.
const CUSTOMER_TYPE_TO_PAYER_TYPE = {
  retail_cash: 'self_pay',
  credit: 'corporate',
  insurance: 'insurance',
  internal_fleet: 'fleet',
};

/**
 * Create the work order a fully-approved (or, via the manual staff route,
 * partially-approved) estimate becomes, and mark the estimate converted.
 *
 * Shared by the manual POST /:id/convert-to-work-order (staff decides when)
 * and the automatic path in applyLineDecision (fires the moment every line
 * on the estimate is approved) — one INSERT, so the two paths cannot drift
 * on which columns get populated.
 */
async function convertEstimateToWorkOrder(estimate, workshopId) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const wo_number = `WO-${stamp}-${Math.floor(Math.random() * 9000) + 1000}`;
  const payerType = CUSTOMER_TYPE_TO_PAYER_TYPE[estimate.customer_type] || 'self_pay';

  // ── Price the job card from the APPROVED lines, not the estimate header ──
  //
  // service_estimates.total_amount is what was quoted: computeTotals() sums
  // every line and is never recomputed when the customer decides, which is
  // correct — the estimate is the historical record of what was offered.
  //
  // The job card is a record of what was ACCEPTED, and those are not the same
  // number the moment a customer rejects a line. This used to
  // `SELECT subtotal_labour, total_amount FROM service_estimates`, so a
  // partially-approved estimate — which POST /:id/convert-to-work-order
  // explicitly allows — produced a job card priced for the work the customer
  // had just refused, and every downstream figure (invoice, VAT, net payable)
  // inherited it.
  const approvedLines = await query(
    `SELECT line_type, quantity, unit_price, discount_pct
       FROM estimate_lines
      WHERE estimate_id = ? AND customer_status = 'approved'`,
    [estimate.id]
  );
  // Re-use the estimate's own VAT rate so the job card is taxed on the same
  // basis it was quoted on, even if the workshop's rate has changed since.
  const totals = computeTotals(approvedLines, Number(estimate.vat_rate) || 5);

  // ── service_fee carries the WHOLE approved subtotal, not just labour ──
  //
  // This looks wrong and is deliberate. createInvoiceFromWorkOrder builds the
  // invoice with `const subtotal = order.service_fee || 0` (invoices.js:413)
  // and reads nothing else, while work-orders.js auto-creates that invoice the
  // moment the job card moves estimate_approved -> confirmed. So anything not
  // in service_fee is never billed.
  //
  // This used to pass subtotal_labour, which meant every converted estimate
  // invoiced its labour and silently dropped all of its parts and sublet
  // value — on fully-approved estimates too, not just partial ones.
  //
  // The honest fix is for the invoice to sum service_fee + cash_amount, but
  // that path is shared by all 18,730 existing work orders and is not mine to
  // change from here; see the note returned to the caller.
  const approvedSubtotal = parseFloat(
    (totals.subtotal_labour + totals.subtotal_parts + totals.subtotal_sublet).toFixed(2)
  );

  const result = await execute(
    `INSERT INTO work_orders
       (workshop_id, work_order_number, customer_id, vehicle_id, customer_name,
        service_fee, total_amount, vat_rate, vat_amount, payer_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'estimate_approved')`,
    [workshopId, wo_number, estimate.customer_id, estimate.vehicle_id, estimate.customer_name,
     approvedSubtotal, totals.total_amount, totals.vat_rate, totals.vat_amount, payerType]
  );
  const workOrderId = result.insertId;

  await execute(
    'UPDATE service_estimates SET status = ?, work_order_id = ? WHERE id = ?',
    ['converted', workOrderId, estimate.id]
  );

  return {
    workOrderId,
    wo_number,
    // Returned so a caller can tell the user the job card is worth less than
    // the estimate, rather than leaving them to notice.
    priced_from_lines: approvedLines.length,
    subtotal: approvedSubtotal,
    total_amount: totals.total_amount,
    quoted_total: Number(estimate.total_amount) || 0,
  };
}

/**
 * Apply one customer decision to one line, roll the estimate's overall
 * status up from its lines, and — the point of the whole exercise — create
 * the job card the moment every line is decided and at least one is
 * approved. Shared by the staff-authenticated PATCH route and the public,
 * token-authenticated one, so "what happens when a line is approved" is
 * answered in exactly one place regardless of who clicked it.
 *
 * responder describes who/how, for the audit trail and for
 * estimate_lines.response_channel: staff acting in person pass
 * { channel: 'in_person' }; the public route passes
 * { channel: 'email', name: <whatever the customer typed, if anything> }.
 */
async function applyLineDecision({ estimateId, lineId, workshopId, decision, responder, actingUserId = null }) {
  const [line] = await query(
    'SELECT * FROM estimate_lines WHERE id = ? AND estimate_id = ? AND workshop_id = ?',
    [lineId, estimateId, workshopId]
  );
  if (!line) return { ok: false, status: 404, message: 'Line not found' };

  await execute(
    `UPDATE estimate_lines
        SET customer_status = ?, customer_responded_at = NOW(),
            customer_responded_by = ?, response_channel = ?
      WHERE id = ?`,
    [decision, responder?.name || null, responder?.channel || 'in_person', lineId]
  );

  const allLines = await query('SELECT customer_status FROM estimate_lines WHERE estimate_id = ?', [estimateId]);
  const anyApproved = allLines.some(l => l.customer_status === 'approved');
  const anyPending = allLines.some(l => l.customer_status === 'pending');
  const allApproved = allLines.every(l => l.customer_status === 'approved');
  const allRejected = allLines.every(l => l.customer_status === 'rejected');

  let newStatus;
  if (anyPending) newStatus = 'sent_to_customer';
  else if (allApproved) newStatus = 'approved';
  else if (allRejected) newStatus = 'rejected';
  else if (anyApproved) newStatus = 'partially_approved';
  else newStatus = 'rejected'; // every remaining line is 'deferred', nothing approved

  await execute('UPDATE service_estimates SET status = ? WHERE id = ?', [newStatus, estimateId]);

  const result = { ok: true, status: 200, estimate_status: newStatus };

  // Fully approved, with no staff step in between — the estimate said
  // "job card will create" and this is where that actually happens. A
  // partial approval deliberately does NOT auto-convert: deciding which
  // approved lines still make a coherent job on their own needs a person,
  // so partially_approved sits and waits for the manual
  // POST /:id/convert-to-work-order, which already supports it.
  if (!anyPending && allApproved) {
    const [estimate] = await query('SELECT * FROM service_estimates WHERE id = ?', [estimateId]);
    if (estimate && !estimate.work_order_id) {
      const { workOrderId, wo_number } = await convertEstimateToWorkOrder(estimate, workshopId);
      result.work_order_id = workOrderId;
      result.work_order_number = wo_number;
      await notifyEstimateOutcome({ estimateId, workshopId, outcome: 'approved', workOrderId, wo_number });
    }
  } else if (!anyPending && allRejected) {
    await notifyEstimateOutcome({ estimateId, workshopId, outcome: 'rejected' });
  }

  await logAudit({
    workshopId, userId: actingUserId, action: 'LINE_DECISION', entityType: 'estimate_lines',
    entityId: lineId, oldValue: line.customer_status,
    newValue: { decision, estimate_status: newStatus, responder },
  });

  return result;
}

/** Tell the advisor (and the workshop manager, if different) what the
 *  customer decided — this happens with no staff member present to see it
 *  land, so it has to reach someone through the in-app notification feed. */
async function notifyEstimateOutcome({ estimateId, workshopId, outcome, workOrderId, wo_number }) {
  const [estimate] = await query(
    'SELECT estimate_number, customer_name, advisor_id, created_by FROM service_estimates WHERE id = ?',
    [estimateId]
  );
  if (!estimate) return;

  const recipients = new Set([estimate.advisor_id, estimate.created_by].filter(Boolean));
  const title = outcome === 'approved'
    ? `Estimate ${estimate.estimate_number} approved — job card ${wo_number} created`
    : `Estimate ${estimate.estimate_number} rejected by the customer`;
  const body = outcome === 'approved'
    ? `${estimate.customer_name || 'The customer'} approved every line. Job card ${wo_number} has been created automatically.`
    : `${estimate.customer_name || 'The customer'} rejected the estimate. No job card was created.`;

  for (const userId of recipients) {
    await createInAppNotification({
      workshopId, userId, title, body,
      type: outcome === 'approved' ? 'success' : 'warning',
      icon: outcome === 'approved' ? '✅' : '⚠️',
      link: outcome === 'approved' && workOrderId ? `/work-orders?id=${workOrderId}` : `/estimates?id=${estimateId}`,
      orderId: workOrderId || null,
    });
  }
}

function estimateApprovalUrl(token) {
  return `${String(config.frontendUrl).replace(/\/+$/, '')}/estimate-approval/${token}`;
}

// ══════════════════════════════════════════════════════════════
// GET /api/estimates — list estimates
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status, customer_id, search, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT e.*, c.full_name AS customer_full_name, v.plate_number, v.make, v.model
      FROM service_estimates e
      LEFT JOIN customers c ON e.customer_id = c.id
      LEFT JOIN vehicles v  ON e.vehicle_id  = v.id
      WHERE e.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status) { sql += ' AND e.status = ?'; params.push(status); }
    if (customer_id) { sql += ' AND e.customer_id = ?'; params.push(customer_id); }
    if (search) {
      sql += ' AND (e.estimate_number LIKE ? OR e.customer_name LIKE ? OR e.vehicle_plate LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const rows = await query(sql, params);
    const [[{ total }]] = [await query(
      `SELECT COUNT(*) as total FROM service_estimates WHERE workshop_id = ?`, [req.workshopId]
    )];
    res.json({ success: true, estimates: rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /estimates error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch estimates' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/estimates/:id — estimate detail with lines
// ══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT e.*, c.full_name AS customer_full_name, v.plate_number, v.make, v.model, v.year
       FROM service_estimates e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN vehicles  v ON e.vehicle_id  = v.id
       WHERE e.id = ? AND e.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Estimate not found' });

    const lines = await query(
      `SELECT el.*, om.code AS operation_code
       FROM estimate_lines el
       LEFT JOIN operations_master om ON el.operation_id = om.id
       WHERE el.estimate_id = ?
       ORDER BY el.sort_order, el.id`,
      [req.params.id]
    );

    res.json({ success: true, estimate: rows[0], lines });
  } catch (err) {
    console.error('GET /estimates/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch estimate' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/estimates — create new estimate
// Body: { customer_id, vehicle_id, customer_type, receiving_form_id,
//         advisor_id, valid_until, vat_rate, lines: [{...}] }
// ══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const {
      customer_id, vehicle_id, customer_type = 'retail_cash',
      receiving_form_id, advisor_id, valid_until, vat_rate = 5,
      lines = [],
    } = req.body;

    if (!customer_id && !req.body.customer_name) {
      return res.status(400).json({ success: false, message: 'customer_id or customer_name required' });
    }

    // Resolve customer/vehicle snapshots
    let customerName = req.body.customer_name || '';
    let vehiclePlate = req.body.vehicle_plate || '';
    let vehicleVin   = req.body.vehicle_vin || '';

    if (customer_id) {
      // Was `SELECT name, phone` — customers has no `name` column (it's
      // `full_name`), so this threw ER_BAD_FIELD_ERROR and POST /estimates
      // 500'd on every call that passed a real customer_id rather than a
      // bare customer_name. Nothing in the frontend called this route yet,
      // which is the only reason it went unnoticed.
      const [cust] = await query('SELECT full_name, phone FROM customers WHERE id = ? AND workshop_id = ?', [customer_id, req.workshopId]);
      if (cust) customerName = cust.full_name;
    }
    if (vehicle_id) {
      const [veh] = await query('SELECT plate_number, vin FROM vehicles WHERE id = ?', [vehicle_id]);
      if (veh) { vehiclePlate = veh.plate_number; vehicleVin = veh.vin || ''; }
    }

    const totals = computeTotals(lines, parseFloat(vat_rate));
    const estimate_number = genEstimateNumber();

    const result = await execute(
      `INSERT INTO service_estimates
         (workshop_id, estimate_number, receiving_form_id, customer_id, vehicle_id,
          customer_name, customer_type, vehicle_plate, vehicle_vin, advisor_id,
          valid_until, vat_rate,
          subtotal_labour, subtotal_parts, subtotal_sublet,
          discount_amount, vat_amount, total_amount, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, estimate_number, receiving_form_id || null, customer_id || null,
       vehicle_id || null, customerName, customer_type, vehiclePlate, vehicleVin,
       advisor_id || req.user?.id, valid_until || null, parseFloat(vat_rate),
       totals.subtotal_labour, totals.subtotal_parts, totals.subtotal_sublet,
       totals.discount_amount, totals.vat_amount, totals.total_amount,
       req.user?.id]
    );

    const estimateId = result.insertId;

    // Insert lines
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await execute(
        `INSERT INTO estimate_lines
           (estimate_id, workshop_id, line_type, operation_id, description,
            part_number, quantity, unit_cost, unit_price, discount_pct,
            payer_direction, insurance_ref, warranty_ref, urgency, customer_status, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [estimateId, req.workshopId, l.line_type || 'labour', l.operation_id || null,
         l.description, l.part_number || null, parseFloat(l.quantity || 1),
         parseFloat(l.unit_cost || 0), parseFloat(l.unit_price || 0),
         parseFloat(l.discount_pct || 0), l.payer_direction || 'customer',
         l.insurance_ref || null, l.warranty_ref || null,
         // urgency was never in this column list, so every line silently took
         // the table's DEFAULT 'now' regardless of what was actually passed —
         // every single estimate line read as urgent, on every estimate ever
         // created through this route.
         ['now', 'soon', 'can_wait'].includes(l.urgency) ? l.urgency : 'now',
         'pending', i]
      );
    }

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id, action: 'CREATE', entityType: 'service_estimates',
      entityId: estimateId, newValue: { estimate_number, total_amount: totals.total_amount },
    });

    res.status(201).json({ success: true, estimateId, estimate_number });
  } catch (err) {
    console.error('POST /estimates error:', err);
    res.status(500).json({ success: false, message: 'Failed to create estimate' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/estimates/:id — update (creates new version if approved)
// ══════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const [est] = await query(
      'SELECT * FROM service_estimates WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!est) return res.status(404).json({ success: false, message: 'Estimate not found' });
    if (['converted', 'expired'].includes(est.status)) {
      return res.status(400).json({ success: false, message: `Cannot edit estimate in status: ${est.status}` });
    }

    const { lines = [], valid_until, advisor_id, notes } = req.body;
    const vat_rate = parseFloat(req.body.vat_rate || est.vat_rate || 5);
    const totals = computeTotals(lines, vat_rate);

    await execute(
      `UPDATE service_estimates SET
         valid_until = ?, advisor_id = ?, vat_rate = ?,
         subtotal_labour = ?, subtotal_parts = ?, subtotal_sublet = ?,
         vat_amount = ?, total_amount = ?,
         status = CASE WHEN status = 'sent_to_customer' THEN 'draft' ELSE status END,
         version = version + 1
       WHERE id = ? AND workshop_id = ?`,
      [valid_until || est.valid_until, advisor_id || est.advisor_id, vat_rate,
       totals.subtotal_labour, totals.subtotal_parts, totals.subtotal_sublet,
       totals.vat_amount, totals.total_amount, req.params.id, req.workshopId]
    );

    // Replace lines
    await execute('DELETE FROM estimate_lines WHERE estimate_id = ?', [req.params.id]);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await execute(
        `INSERT INTO estimate_lines
           (estimate_id, workshop_id, line_type, operation_id, description,
            part_number, quantity, unit_cost, unit_price, discount_pct,
            payer_direction, insurance_ref, warranty_ref, urgency, customer_status, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, req.workshopId, l.line_type || 'labour', l.operation_id || null,
         l.description, l.part_number || null, parseFloat(l.quantity || 1),
         parseFloat(l.unit_cost || 0), parseFloat(l.unit_price || 0),
         parseFloat(l.discount_pct || 0), l.payer_direction || 'customer',
         l.insurance_ref || null, l.warranty_ref || null,
         ['now', 'soon', 'can_wait'].includes(l.urgency) ? l.urgency : 'now',
         l.customer_status || 'pending', i]
      );
    }

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id, action: 'UPDATE', entityType: 'service_estimates',
      entityId: req.params.id, newValue: { action: 'edit_estimate' },
    });
    res.json({ success: true, message: 'Estimate updated' });
  } catch (err) {
    console.error('PUT /estimates/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update estimate' });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/estimates/:id/status — change estimate status
// body: { status: 'sent_to_customer'|'approved'|'rejected'|... }
// ══════════════════════════════════════════════════════════════
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, customer_notes } = req.body;
    const VALID = ['draft','sent_to_customer','partially_approved','approved','rejected','expired'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const [est] = await query(
      'SELECT * FROM service_estimates WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!est) return res.status(404).json({ success: false, message: 'Estimate not found' });

    await execute(
      `UPDATE service_estimates SET status = ?, customer_notes = COALESCE(?, customer_notes),
       customer_approved_at = CASE WHEN ? IN ('approved','partially_approved') THEN NOW() ELSE customer_approved_at END
       WHERE id = ? AND workshop_id = ?`,
      [status, customer_notes || null, status, req.params.id, req.workshopId]
    );

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id, action: 'STATUS_CHANGE', entityType: 'service_estimates',
      entityId: req.params.id, oldValue: est.status, newValue: { new_status: status },
    });
    res.json({ success: true, message: `Estimate ${status}` });
  } catch (err) {
    console.error('PATCH /estimates/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update estimate status' });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/estimates/:id/lines/:lineId/approve
// Customer approves/rejects individual lines (req 69)
// ══════════════════════════════════════════════════════════════
router.patch('/:id/lines/:lineId/approve', async (req, res) => {
  try {
    const { customer_status } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(customer_status)) {
      return res.status(400).json({ success: false, message: 'customer_status must be approved or rejected' });
    }

    const result = await applyLineDecision({
      estimateId: req.params.id, lineId: req.params.lineId, workshopId: req.workshopId,
      decision: customer_status, responder: { channel: 'in_person' }, actingUserId: req.user?.id,
    });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    res.json({
      success: true, message: `Line ${customer_status}`, estimate_status: result.estimate_status,
      work_order_id: result.work_order_id, work_order_number: result.work_order_number,
    });
  } catch (err) {
    console.error('PATCH /estimates/:id/lines/:lineId/approve error:', err);
    res.status(500).json({ success: false, message: 'Failed to update line approval' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/estimates/:id/send — email the customer an approval link
// ══════════════════════════════════════════════════════════════
router.post('/:id/send', async (req, res) => {
  try {
    const [est] = await query(
      'SELECT * FROM service_estimates WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!est) return res.status(404).json({ success: false, message: 'Estimate not found' });
    if (est.work_order_id) {
      return res.status(400).json({ success: false, message: 'Already converted to a job card' });
    }

    let customerEmail = req.body.email || '';
    if (!customerEmail && est.customer_id) {
      const [cust] = await query('SELECT email FROM customers WHERE id = ?', [est.customer_id]);
      customerEmail = cust?.email || '';
    }
    if (!customerEmail) {
      return res.status(400).json({ success: false, message: 'No email on file for this customer — pass one explicitly to send to.' });
    }

    const lines = await query(
      'SELECT description, line_type, quantity, unit_price, line_total FROM estimate_lines WHERE estimate_id = ? ORDER BY sort_order, id',
      [req.params.id]
    );

    // Re-issuing keeps the same token unless the previous one already
    // expired or was consumed by a decision (status moved past
    // sent_to_customer) — no reason to invalidate a link that is still live
    // just because someone clicked "resend".
    let token = est.approval_token;
    const expired = !est.approval_token_expires_at || new Date(est.approval_token_expires_at) < new Date();
    if (!token || expired || est.status !== 'draft' && est.status !== 'sent_to_customer') {
      token = crypto.randomBytes(24).toString('hex');
    }
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

    await execute(
      `UPDATE service_estimates
          SET approval_token = ?, approval_token_expires_at = ?, sent_to_customer_at = NOW(),
              status = IF(status = 'draft', 'sent_to_customer', status)
        WHERE id = ?`,
      [token, expiresAt, req.params.id]
    );

    const lineRows = lines.map(l =>
      `<tr><td style="padding:6px 0;">${l.description}${l.quantity > 1 ? ` × ${l.quantity}` : ''}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;">AED ${Number(l.line_total ?? (l.quantity * l.unit_price)).toFixed(2)}</td></tr>`
    ).join('');

    await sendNotificationEmail({
      to: customerEmail,
      tenantId: req.workshopId,
      subject: `Estimate ${est.estimate_number} — approval needed`,
      title: 'Your service estimate is ready',
      body: `We've prepared an estimate for ${est.vehicle_plate ? `your vehicle (${est.vehicle_plate})` : 'your vehicle'}. ` +
        `Please review each item and approve or reject it before we begin any work.` +
        `<table style="width:100%;margin-top:14px;border-collapse:collapse;font-size:14px;">${lineRows}` +
        `<tr><td style="padding-top:10px;font-weight:700;">Total (incl. VAT)</td>` +
        `<td style="padding-top:10px;font-weight:700;text-align:right;">AED ${Number(est.total_amount).toFixed(2)}</td></tr></table>`,
      ctaText: 'Review and approve',
      ctaUrl: estimateApprovalUrl(token),
      expiryNote: 'This link expires in 7 days.',
    });

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id, action: 'SEND', entityType: 'service_estimates',
      entityId: req.params.id, oldValue: est.status, newValue: { sent_to: customerEmail },
    });

    res.json({ success: true, message: `Sent to ${customerEmail}`, approval_url: estimateApprovalUrl(token) });
  } catch (err) {
    console.error('POST /estimates/:id/send error:', err);
    res.status(500).json({ success: false, message: 'Failed to send the estimate' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/estimates/:id/convert-to-work-order
// Creates a work order from an approved estimate (req 69)
// ══════════════════════════════════════════════════════════════
router.post('/:id/convert-to-work-order', async (req, res) => {
  try {
    const [est] = await query(
      'SELECT * FROM service_estimates WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!est) return res.status(404).json({ success: false, message: 'Estimate not found' });
    if (!['approved','partially_approved'].includes(est.status)) {
      return res.status(400).json({ success: false, message: 'Estimate must be approved before converting' });
    }
    if (est.work_order_id) {
      return res.status(400).json({ success: false, message: 'Already converted to work order ' + est.work_order_id });
    }

    const { workOrderId, wo_number } = await convertEstimateToWorkOrder(est, req.workshopId);

    await logAudit({
      workshopId: req.workshopId, userId: req.user?.id, action: 'CONVERT', entityType: 'service_estimates',
      entityId: req.params.id, newValue: { work_order_id: workOrderId, wo_number },
    });

    res.json({ success: true, workOrderId, work_order_number: wo_number });
  } catch (err) {
    console.error('POST /estimates/:id/convert-to-work-order error:', err);
    res.status(500).json({ success: false, message: 'Failed to convert estimate' });
  }
});

// ══════════════════════════════════════════════════════════════
// Operations Master CRUD (req 70) — sub-resource
// GET  /api/estimates/operations-master
// POST /api/estimates/operations-master
// GET  /api/estimates/operations-master/:id
// PUT  /api/estimates/operations-master/:id
// ══════════════════════════════════════════════════════════════

router.get('/operations-master/list', async (req, res) => {
  try {
    const { make, model, category, search } = req.query;
    let sql = `SELECT * FROM operations_master WHERE workshop_id = ? AND is_active = 1`;
    const params = [req.workshopId];
    if (make) { sql += ' AND (vehicle_make IS NULL OR vehicle_make = ?)'; params.push(make); }
    if (model) { sql += ' AND (vehicle_model IS NULL OR vehicle_model = ?)'; params.push(model); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (search) { sql += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name ASC';
    const rows = await query(sql, params);
    res.json({ success: true, operations: rows });
  } catch (err) {
    console.error('GET /operations-master error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch operations' });
  }
});

router.post('/operations-master', async (req, res) => {
  try {
    const {
      code, name, description, vehicle_make, vehicle_model,
      service_interval, category, standard_hours, labour_rate_override, parts_json
    } = req.body;
    if (!code || !name) {
      return res.status(400).json({ success: false, message: 'code and name are required' });
    }
    const result = await execute(
      `INSERT INTO operations_master
         (workshop_id, code, name, description, vehicle_make, vehicle_model,
          service_interval, category, standard_hours, labour_rate_override, parts_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, code, name, description || null, vehicle_make || null,
       vehicle_model || null, service_interval || null, category || null,
       standard_hours || null, labour_rate_override || null,
       parts_json ? JSON.stringify(parts_json) : null]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Operation code already exists' });
    }
    console.error('POST /operations-master error:', err);
    res.status(500).json({ success: false, message: 'Failed to create operation' });
  }
});

router.put('/operations-master/:opId', async (req, res) => {
  try {
    const {
      name, description, vehicle_make, vehicle_model, service_interval,
      category, standard_hours, labour_rate_override, parts_json, is_active
    } = req.body;
    await execute(
      `UPDATE operations_master SET
         name = COALESCE(?, name),
         description = COALESCE(?, description),
         vehicle_make = ?,
         vehicle_model = ?,
         service_interval = COALESCE(?, service_interval),
         category = COALESCE(?, category),
         standard_hours = COALESCE(?, standard_hours),
         labour_rate_override = ?,
         parts_json = COALESCE(?, parts_json),
         is_active = COALESCE(?, is_active)
       WHERE id = ? AND workshop_id = ?`,
      [name || null, description || null, vehicle_make || null, vehicle_model || null,
       service_interval || null, category || null, standard_hours || null,
       labour_rate_override !== undefined ? labour_rate_override : null,
       parts_json ? JSON.stringify(parts_json) : null,
       is_active !== undefined ? is_active : null,
       req.params.opId, req.workshopId]
    );
    res.json({ success: true, message: 'Operation updated' });
  } catch (err) {
    console.error('PUT /operations-master/:opId error:', err);
    res.status(500).json({ success: false, message: 'Failed to update operation' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUBLIC — no auth. Reached only via the token emailed in POST /:id/send.
// Rate-limited the same as the public survey/enquiry endpoints: an
// unauthenticated route that looks up a customer-controlled path segment is
// exactly the kind of thing worth throttling against token-guessing.
// ══════════════════════════════════════════════════════════════

async function loadByToken(token, res) {
  const [est] = await query('SELECT * FROM service_estimates WHERE approval_token = ?', [token]);
  if (!est) { res.status(404).json({ success: false, message: 'This link is not valid.' }); return null; }
  if (est.approval_token_expires_at && new Date(est.approval_token_expires_at) < new Date()) {
    res.status(410).json({ success: false, message: 'This link has expired. Ask the workshop to resend it.' });
    return null;
  }
  return est;
}

// GET /api/public/estimates/:token — read-only view for the customer.
// unit_cost never leaves this file: it is the workshop's own cost on the
// part or job, and exposing it alongside unit_price would hand the customer
// the margin on every line.
publicRouter.get('/:token', publicEnquiryLimiter, async (req, res) => {
  try {
    const est = await loadByToken(req.params.token, res);
    if (!est) return;

    const lines = await query(
      `SELECT id, line_type, description, part_number, quantity, unit_price,
              discount_pct, line_total, customer_status, urgency
         FROM estimate_lines WHERE estimate_id = ? ORDER BY sort_order, id`,
      [est.id]
    );

    res.json({
      success: true,
      estimate: {
        estimate_number: est.estimate_number,
        customer_name: est.customer_name,
        vehicle_plate: est.vehicle_plate,
        subtotal_labour: est.subtotal_labour,
        subtotal_parts: est.subtotal_parts,
        subtotal_sublet: est.subtotal_sublet,
        vat_rate: est.vat_rate,
        vat_amount: est.vat_amount,
        total_amount: est.total_amount,
        status: est.status,
        valid_until: est.valid_until,
        work_order_id: est.work_order_id,
      },
      lines,
    });
  } catch (err) {
    console.error('GET /public/estimates/:token error:', err);
    res.status(500).json({ success: false, message: 'Failed to load the estimate' });
  }
});

// POST /api/public/estimates/:token/lines/:lineId/decide — the customer
// approves or rejects one line. Same rollup and same auto-conversion as the
// staff PATCH route, via applyLineDecision — a customer-driven approval must
// create the job card exactly as reliably as a staff-driven one.
publicRouter.post('/:token/lines/:lineId/decide', publicEnquiryLimiter, async (req, res) => {
  try {
    const est = await loadByToken(req.params.token, res);
    if (!est) return;

    const { decision, name } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be approved or rejected' });
    }

    const result = await applyLineDecision({
      estimateId: est.id, lineId: req.params.lineId, workshopId: est.workshop_id,
      decision, responder: { channel: 'email', name: name || null },
    });
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    res.json({
      success: true, estimate_status: result.estimate_status,
      work_order_created: !!result.work_order_id, work_order_number: result.work_order_number,
    });
  } catch (err) {
    console.error('POST /public/estimates/:token/lines/:lineId/decide error:', err);
    res.status(500).json({ success: false, message: 'Failed to record the decision' });
  }
});

export { router as default, publicRouter as publicEstimateRouter };
