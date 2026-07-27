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

const router = express.Router();
router.use(authMiddleware);

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

// ══════════════════════════════════════════════════════════════
// GET /api/estimates — list estimates
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status, customer_id, search, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT e.*, c.name AS customer_full_name, v.plate_number, v.make, v.model
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
      `SELECT e.*, c.name AS customer_full_name, v.plate_number, v.make, v.model, v.year
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
      const [cust] = await query('SELECT name, phone FROM customers WHERE id = ? AND workshop_id = ?', [customer_id, req.workshopId]);
      if (cust) customerName = cust.name;
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
       advisor_id || req.userId, valid_until || null, parseFloat(vat_rate),
       totals.subtotal_labour, totals.subtotal_parts, totals.subtotal_sublet,
       totals.discount_amount, totals.vat_amount, totals.total_amount,
       req.userId]
    );

    const estimateId = result.insertId;

    // Insert lines
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await execute(
        `INSERT INTO estimate_lines
           (estimate_id, workshop_id, line_type, operation_id, description,
            part_number, quantity, unit_cost, unit_price, discount_pct,
            payer_direction, insurance_ref, warranty_ref, customer_status, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [estimateId, req.workshopId, l.line_type || 'labour', l.operation_id || null,
         l.description, l.part_number || null, parseFloat(l.quantity || 1),
         parseFloat(l.unit_cost || 0), parseFloat(l.unit_price || 0),
         parseFloat(l.discount_pct || 0), l.payer_direction || 'customer',
         l.insurance_ref || null, l.warranty_ref || null,
         'pending', i]
      );
    }

    await logAudit(req.workshopId, req.userId, 'CREATE', 'service_estimates', estimateId, null, { estimate_number, total_amount: totals.total_amount });

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
            payer_direction, insurance_ref, warranty_ref, customer_status, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, req.workshopId, l.line_type || 'labour', l.operation_id || null,
         l.description, l.part_number || null, parseFloat(l.quantity || 1),
         parseFloat(l.unit_cost || 0), parseFloat(l.unit_price || 0),
         parseFloat(l.discount_pct || 0), l.payer_direction || 'customer',
         l.insurance_ref || null, l.warranty_ref || null,
         l.customer_status || 'pending', i]
      );
    }

    await logAudit(req.workshopId, req.userId, 'UPDATE', 'service_estimates', req.params.id, null, { action: 'edit_estimate' });
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

    await logAudit(req.workshopId, req.userId, 'STATUS_CHANGE', 'service_estimates', req.params.id, est.status, { new_status: status });
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
    if (!['approved','rejected'].includes(customer_status)) {
      return res.status(400).json({ success: false, message: 'customer_status must be approved or rejected' });
    }

    const [line] = await query(
      'SELECT * FROM estimate_lines WHERE id = ? AND estimate_id = ? AND workshop_id = ?',
      [req.params.lineId, req.params.id, req.workshopId]
    );
    if (!line) return res.status(404).json({ success: false, message: 'Line not found' });

    await execute(
      'UPDATE estimate_lines SET customer_status = ? WHERE id = ?',
      [customer_status, req.params.lineId]
    );

    // Recalculate overall estimate status
    const allLines = await query('SELECT customer_status FROM estimate_lines WHERE estimate_id = ?', [req.params.id]);
    const anyApproved  = allLines.some(l => l.customer_status === 'approved');
    const anyPending   = allLines.some(l => l.customer_status === 'pending');
    const allRejected  = allLines.every(l => l.customer_status === 'rejected');

    let newEstStatus = anyPending ? 'sent_to_customer' : (anyApproved ? (allRejected ? 'rejected' : 'partially_approved') : 'rejected');
    if (!anyPending && anyApproved) newEstStatus = allLines.every(l => l.customer_status === 'approved') ? 'approved' : 'partially_approved';

    await execute('UPDATE service_estimates SET status = ? WHERE id = ?', [newEstStatus, req.params.id]);

    res.json({ success: true, message: `Line ${customer_status}`, estimate_status: newEstStatus });
  } catch (err) {
    console.error('PATCH /estimates/:id/lines/:lineId/approve error:', err);
    res.status(500).json({ success: false, message: 'Failed to update line approval' });
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

    // Create work order
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const wo_number = `WO-${stamp}-${Math.floor(Math.random()*9000)+1000}`;

    const woResult = await execute(
      `INSERT INTO work_orders
         (workshop_id, work_order_number, customer_id, vehicle_id, customer_name,
          customer_phone, service_fee, status, created_by)
       SELECT ?, ?, customer_id, vehicle_id, customer_name, NULL, total_amount, 'confirmed', ?
       FROM service_estimates WHERE id = ?`,
      [req.workshopId, wo_number, req.userId, req.params.id]
    );
    const workOrderId = woResult.insertId;

    // Update estimate
    await execute(
      'UPDATE service_estimates SET status = ?, work_order_id = ? WHERE id = ?',
      ['converted', workOrderId, req.params.id]
    );

    await logAudit(req.workshopId, req.userId, 'CONVERT', 'service_estimates', req.params.id, null, { work_order_id: workOrderId, wo_number });

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

export default router;
