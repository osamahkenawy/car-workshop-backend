/**
 * ═══════════════════════════════════════════════════════════════
 *  Vehicle Receiving Form — SOW Section B1, req 59
 *  Digital intake replacing paper VRF.
 *  Single screen: creates customer + vehicle records automatically
 *  if they do not already exist, avoids separate manual steps.
 *
 *  Also covers:
 *    req 62 (photo/doc capture with auto-extraction hints),
 *    req 65 (vehicle contacts — owner vs presenter distinction),
 *    req 66 (four customer types),
 *    req 67 (credit facility check before credit billing)
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

function genFormNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `VRF-${stamp}-${Math.floor(Math.random()*9000)+1000}`;
}

// ══════════════════════════════════════════════════════════════
// GET /api/vehicle-receiving — list VRFs
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status, date, search, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT vrf.*,
             c.full_name AS customer_full_name,
             v.make, v.model, v.year,
             u.full_name AS advisor_full_name
      FROM vehicle_receiving_forms vrf
      LEFT JOIN customers c ON vrf.customer_id = c.id
      LEFT JOIN vehicles  v ON vrf.vehicle_id  = v.id
      LEFT JOIN users     u ON vrf.advisor_id  = u.id
      WHERE vrf.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status) { sql += ' AND vrf.status = ?'; params.push(status); }
    if (date)   { sql += ' AND DATE(vrf.created_at) = ?'; params.push(date); }
    if (search) {
      sql += ' AND (vrf.form_number LIKE ? OR vrf.customer_name LIKE ? OR vrf.vehicle_plate LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY vrf.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const rows = await query(sql, params);
    res.json({ success: true, forms: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /vehicle-receiving error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch VRFs' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/vehicle-receiving/:id
// ══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const [form] = await query(
      `SELECT vrf.*, c.full_name AS customer_full_name, c.phone, c.email,
              v.make, v.model, v.year, v.plate_number, v.vin,
              u.full_name AS advisor_full_name
       FROM vehicle_receiving_forms vrf
       LEFT JOIN customers c ON vrf.customer_id = c.id
       LEFT JOIN vehicles  v ON vrf.vehicle_id  = v.id
       LEFT JOIN users     u ON vrf.advisor_id  = u.id
       WHERE vrf.id = ? AND vrf.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!form) return res.status(404).json({ success: false, message: 'VRF not found' });

    // Load additional contacts (req 65)
    const contacts = await query(
      'SELECT * FROM vehicle_contacts WHERE vehicle_id = ? AND workshop_id = ?',
      [form.vehicle_id, req.workshopId]
    );

    res.json({ success: true, form, contacts });
  } catch (err) {
    console.error('GET /vehicle-receiving/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch VRF' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/vehicle-receiving — create VRF (req 59, req 62)
// Auto-creates customer and vehicle if not found.
// Body: {
//   appointment_id?,
//   customer_id?,          — if existing customer
//   customer_name, customer_phone, customer_email,
//   customer_type,         — retail_cash|credit|insurance|internal_fleet
//   vehicle_id?,           — if existing vehicle
//   vehicle_make, vehicle_model, vehicle_year, vehicle_plate,
//   vehicle_vin, vehicle_color,
//   odometer_in, fuel_level,
//   complaints,
//   condition_notes,
//   condition_photos: [],  — array of S3/upload URLs
//   mulkia_photo,          — registration doc photo URL
//   id_photo,              — customer ID photo URL
//   advisor_id,
//   additional_contacts: [{name, phone, email, relationship, is_primary_presenter}]
// }
// ══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const {
      appointment_id,
      customer_id: existingCustomerId,
      customer_name, customer_phone, customer_email,
      customer_type = 'retail_cash',
      vehicle_id: existingVehicleId,
      vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_vin, vehicle_color,
      odometer_in, fuel_level,
      complaints, condition_notes, condition_photos,
      mulkia_photo, id_photo,
      advisor_id,
      additional_contacts = [],
    } = req.body;

    if (!customer_name && !existingCustomerId) {
      return res.status(400).json({ success: false, message: 'customer_name or customer_id required' });
    }
    if (!vehicle_plate && !existingVehicleId) {
      return res.status(400).json({ success: false, message: 'vehicle_plate or vehicle_id required' });
    }

    // ── Auto-create or resolve customer (req 59) ──────────────
    let customerId = existingCustomerId || null;
    if (!customerId && customer_phone) {
      // Look up by phone
      const [existing] = await query(
        'SELECT id FROM customers WHERE workshop_id = ? AND phone = ?',
        [req.workshopId, customer_phone]
      );
      customerId = existing?.id || null;
    }
    if (!customerId) {
      // Create new customer
      const custResult = await execute(
        `INSERT INTO customers (workshop_id, name, phone, email, customer_type, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.workshopId, customer_name, customer_phone || null,
         customer_email || null, customer_type, req.userId]
      );
      customerId = custResult.insertId;
    }

    // If credit customer, verify credit facility is approved (req 67)
    if (customer_type === 'credit') {
      const [facility] = await query(
        `SELECT status FROM credit_facilities
         WHERE workshop_id = ? AND customer_id = ? AND status = 'approved'`,
        [req.workshopId, customerId]
      );
      if (!facility) {
        return res.status(403).json({
          success: false,
          message: 'Credit billing not permitted: customer credit facility is not approved. Please use a different customer type or initiate credit approval first.'
        });
      }
    }

    // ── Auto-create or resolve vehicle (req 59) ───────────────
    let vehicleId = existingVehicleId || null;
    if (!vehicleId && vehicle_plate) {
      const [existingVeh] = await query(
        'SELECT id FROM vehicles WHERE workshop_id = ? AND plate_number = ?',
        [req.workshopId, vehicle_plate]
      );
      vehicleId = existingVeh?.id || null;
    }
    if (!vehicleId) {
      const vehResult = await execute(
        `INSERT INTO vehicles (workshop_id, customer_id, make, model, year, plate_number, vin, color)
         VALUES (?,?,?,?,?,?,?,?)`,
        [req.workshopId, customerId, vehicle_make || null, vehicle_model || null,
         vehicle_year || null, vehicle_plate, vehicle_vin || null, vehicle_color || null]
      );
      vehicleId = vehResult.insertId;
    }

    // ── Create VRF ────────────────────────────────────────────
    const form_number = genFormNumber();
    const result = await execute(
      `INSERT INTO vehicle_receiving_forms
         (workshop_id, form_number, appointment_id, customer_id, vehicle_id,
          customer_name, customer_phone, customer_email, customer_type,
          vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_vin, vehicle_color,
          odometer_in, fuel_level, complaints, condition_notes, condition_photos,
          mulkia_photo, id_photo, advisor_id, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)`,
      [req.workshopId, form_number, appointment_id || null, customerId, vehicleId,
       customer_name, customer_phone || null, customer_email || null, customer_type,
       vehicle_make || null, vehicle_model || null, vehicle_year || null,
       vehicle_plate, vehicle_vin || null, vehicle_color || null,
       odometer_in || null, fuel_level || null,
       complaints || null, condition_notes || null,
       condition_photos ? JSON.stringify(condition_photos) : null,
       mulkia_photo || null, id_photo || null,
       advisor_id || req.userId, req.userId]
    );
    const formId = result.insertId;

    // ── Additional contacts (req 65) ──────────────────────────
    for (const contact of additional_contacts) {
      await execute(
        `INSERT INTO vehicle_contacts (workshop_id, vehicle_id, customer_id, contact_name, contact_phone, contact_email, relationship, is_primary_presenter)
         VALUES (?,?,?,?,?,?,?,?)`,
        [req.workshopId, vehicleId, customerId, contact.name, contact.phone || null,
         contact.email || null, contact.relationship || 'other', contact.is_primary_presenter ? 1 : 0]
      );
    }

    // ── Link appointment ───────────────────────────────────────
    if (appointment_id) {
      await execute(
        `UPDATE appointments SET status = 'arrived', customer_id = ?, vehicle_id = ?
         WHERE id = ? AND workshop_id = ?`,
        [customerId, vehicleId, appointment_id, req.workshopId]
      );
    }

    await logAudit(req.workshopId, req.userId, 'CREATE', 'vehicle_receiving_forms', formId, null,
      { form_number, customer_type, new_customer: !existingCustomerId, new_vehicle: !existingVehicleId });

    res.status(201).json({
      success: true, formId, form_number,
      customerId, vehicleId,
      new_customer_created: !existingCustomerId,
      new_vehicle_created:  !existingVehicleId,
    });
  } catch (err) {
    console.error('POST /vehicle-receiving error:', err);
    res.status(500).json({ success: false, message: 'Failed to create VRF' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/vehicle-receiving/:id — update VRF (still draft)
// ══════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const [form] = await query(
      'SELECT * FROM vehicle_receiving_forms WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!form) return res.status(404).json({ success: false, message: 'VRF not found' });
    if (form.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only draft VRFs can be edited' });
    }

    const {
      odometer_in, fuel_level, complaints, condition_notes, condition_photos,
      mulkia_photo, id_photo, advisor_id
    } = req.body;

    await execute(
      `UPDATE vehicle_receiving_forms SET
         odometer_in     = COALESCE(?, odometer_in),
         fuel_level      = COALESCE(?, fuel_level),
         complaints      = COALESCE(?, complaints),
         condition_notes = COALESCE(?, condition_notes),
         condition_photos = COALESCE(?, condition_photos),
         mulkia_photo    = COALESCE(?, mulkia_photo),
         id_photo        = COALESCE(?, id_photo),
         advisor_id      = COALESCE(?, advisor_id)
       WHERE id = ? AND workshop_id = ?`,
      [odometer_in || null, fuel_level || null, complaints || null,
       condition_notes || null,
       condition_photos ? JSON.stringify(condition_photos) : null,
       mulkia_photo || null, id_photo || null, advisor_id || null,
       req.params.id, req.workshopId]
    );

    res.json({ success: true, message: 'VRF updated' });
  } catch (err) {
    console.error('PUT /vehicle-receiving/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to update VRF' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/vehicle-receiving/:id/submit — submit VRF
// Transitions status to submitted, creates estimate if needed
// ══════════════════════════════════════════════════════════════
router.post('/:id/submit', async (req, res) => {
  try {
    const [form] = await query(
      'SELECT * FROM vehicle_receiving_forms WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!form) return res.status(404).json({ success: false, message: 'VRF not found' });
    if (form.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'VRF already submitted' });
    }

    await execute(
      `UPDATE vehicle_receiving_forms SET status = 'submitted', submitted_at = NOW()
       WHERE id = ? AND workshop_id = ?`,
      [req.params.id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'SUBMIT', 'vehicle_receiving_forms', req.params.id, 'draft', { status: 'submitted' });
    res.json({ success: true, message: 'VRF submitted' });
  } catch (err) {
    console.error('POST /vehicle-receiving/:id/submit error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit VRF' });
  }
});

// ══════════════════════════════════════════════════════════════
// CREDIT FACILITY MANAGEMENT (req 67)
// ══════════════════════════════════════════════════════════════

// GET /api/vehicle-receiving/credit-facilities?status=
router.get('/credit-facilities/list', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT cf.*, c.full_name AS customer_name, c.phone
               FROM credit_facilities cf
               JOIN customers c ON cf.customer_id = c.id
               WHERE cf.workshop_id = ?`;
    const params = [req.workshopId];
    if (status) { sql += ' AND cf.status = ?'; params.push(status); }
    sql += ' ORDER BY cf.created_at DESC';
    const rows = await query(sql, params);
    res.json({ success: true, facilities: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch credit facilities' });
  }
});

// POST /api/vehicle-receiving/credit-facilities — apply for credit facility
router.post('/credit-facilities', async (req, res) => {
  try {
    const {
      customer_id, company_name, trade_licence_no, trade_licence_expiry,
      tax_registration_no, commercial_reg_no, credit_limit, payment_terms_days
    } = req.body;
    if (!customer_id || !credit_limit) {
      return res.status(400).json({ success: false, message: 'customer_id and credit_limit required' });
    }

    const result = await execute(
      `INSERT INTO credit_facilities
         (workshop_id, customer_id, company_name, trade_licence_no, trade_licence_expiry,
          tax_registration_no, commercial_reg_no, credit_limit, payment_terms_days, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         company_name = VALUES(company_name), trade_licence_no = VALUES(trade_licence_no),
         credit_limit = VALUES(credit_limit), status = 'pending_approval'`,
      [req.workshopId, customer_id, company_name || null, trade_licence_no || null,
       trade_licence_expiry || null, tax_registration_no || null, commercial_reg_no || null,
       parseFloat(credit_limit), parseInt(payment_terms_days || 30), req.userId]
    );

    await logAudit(req.workshopId, req.userId, 'CREATE', 'credit_facilities', result.insertId, null, { customer_id, credit_limit });
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create credit facility' });
  }
});

// PATCH /api/vehicle-receiving/credit-facilities/:id/approve
router.patch('/credit-facilities/:id/approve', async (req, res) => {
  try {
    const { status, rejection_reason } = req.body; // approved | rejected
    if (!['approved','rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be approved or rejected' });
    }
    await execute(
      `UPDATE credit_facilities SET status = ?, approved_by = ?, approved_at = NOW(),
       rejection_reason = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END
       WHERE id = ? AND workshop_id = ?`,
      [status, req.userId, status, rejection_reason || null, req.params.id, req.workshopId]
    );
    await logAudit(req.workshopId, req.userId, 'APPROVE', 'credit_facilities', req.params.id, null, { status });
    res.json({ success: true, message: `Credit facility ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update credit facility' });
  }
});

export default router;
