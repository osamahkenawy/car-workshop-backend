import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { saveBase64Signature } from './uploads.js';

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Vehicle Inspection Form — the walk-around damage check
 * ═══════════════════════════════════════════════════════════════════
 *
 * Backs the visual inspection form: a car diagram the inspector clicks to
 * drop damage markers (legend codes: DS deep scratch, DD dents/dings, ...),
 * done with the customer present at intake (journey step 3) and again at
 * handover (step 9).
 *
 * Markers are stored in `vehicle_inspections.marks` as JSON —
 *   [{ id, view: top|left|right|front|rear, code, x: 0..1, y: 0..1, note }]
 * — with x/y normalised to the view box so they render correctly at any size.
 *
 * Completing an intake inspection stamps work_orders.intake_inspection_at, and
 * a joint inspection stamps joint_inspection_at, so the Customer Journey
 * checklist on the work order stays in sync without a second manual step.
 */

const router = express.Router();
router.use(authMiddleware);

const VIEWS = ['top', 'left', 'right', 'front', 'rear'];

// Damage legend. Codes mirror the printed form; two deliberate corrections:
// the source sheet used "GC" for BOTH Glass Chip and Gouges/Crease (so a mark
// was ambiguous) — Gouges/Crease is "GO" here; and "Pant Chip" was a typo.
export const DAMAGE_CODES = {
  SH: 'Swirls/Holograms',
  WS: 'Water Spots',
  OX: 'Oxidation',
  CF: 'Clearcoat Failure',
  DS: 'Deep Scratch',
  BD: 'Bird Dropping',
  RP: 'Rough Paint',
  UD: 'Unknown Defect',
  PT: 'Paint Transfer',
  PC: 'Paint Chip',
  GS: 'Glass Scratch',
  GC: 'Glass Chip',
  DD: 'Dents/Dings',
  SS: 'Side Swipe',
  CR: 'Curb Rash',
  WD: 'Wheel Damage',
  GO: 'Gouges/Crease',
  LM: 'Loose Molding',
};

// Keeps a stray click or a malformed payload from being persisted: anything
// that isn't a known code / known view / in-range coordinate is dropped rather
// than stored, since a marker with a bad view or x=1e9 renders nowhere.
function sanitizeMarks(marks) {
  if (!Array.isArray(marks)) return [];
  return marks
    .filter(m => m && VIEWS.includes(m.view) && DAMAGE_CODES[m.code])
    .map((m, i) => ({
      id: String(m.id || `m${i + 1}`).slice(0, 40),
      view: m.view,
      code: m.code,
      x: Math.min(1, Math.max(0, Number(m.x) || 0)),
      y: Math.min(1, Math.max(0, Number(m.y) || 0)),
      note: (m.note || '').toString().slice(0, 500),
    }))
    .slice(0, 500);
}

function parseMarks(row) {
  if (!row) return row;
  if (typeof row.marks === 'string') {
    try { row.marks = JSON.parse(row.marks); } catch { row.marks = []; }
  }
  row.marks = row.marks || [];
  return row;
}

// GET /api/vehicle-inspections/codes — the damage legend (single source of truth)
router.get('/codes', (req, res) => {
  return res.json({ success: true, data: DAMAGE_CODES });
});

// GET /api/vehicle-inspections?work_order_id=&status=&type=
router.get('/', async (req, res) => {
  try {
    const { work_order_id, status, type } = req.query;
    const params = [req.workshopId];
    let where = 'WHERE vi.workshop_id = ?';
    if (work_order_id) { where += ' AND vi.work_order_id = ?'; params.push(work_order_id); }
    if (status)        { where += ' AND vi.status = ?';        params.push(status); }
    if (type)          { where += ' AND vi.inspection_type = ?'; params.push(type); }

    const rows = await query(
      `SELECT vi.*, wo.work_order_number
         FROM vehicle_inspections vi
         LEFT JOIN work_orders wo ON wo.id = vi.work_order_id
         ${where}
        ORDER BY vi.created_at DESC
        LIMIT 200`,
      params
    );
    return res.json({ success: true, data: rows.map(parseMarks) });
  } catch (err) {
    console.error('[VehicleInspections] List error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load inspections' });
  }
});

// GET /api/vehicle-inspections/:id
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT vi.*, wo.work_order_number
         FROM vehicle_inspections vi
         LEFT JOIN work_orders wo ON wo.id = vi.work_order_id
        WHERE vi.id = ? AND vi.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Inspection not found' });
    return res.json({ success: true, data: parseMarks(row) });
  } catch (err) {
    console.error('[VehicleInspections] Get error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load inspection' });
  }
});

/**
 * POST /api/vehicle-inspections — start an inspection for a work order.
 *
 * The header fields are pre-filled from the work order + its vehicle/customer
 * so the inspector isn't retyping the plate and VIN at the car; anything passed
 * in the body wins over the pre-fill.
 */
router.post('/', async (req, res) => {
  try {
    const { work_order_id, inspection_type = 'intake', job_card_id = null } = req.body;
    if (!work_order_id) {
      return res.status(400).json({ success: false, message: 'work_order_id is required' });
    }
    if (!['intake', 'joint', 'qc'].includes(inspection_type)) {
      return res.status(400).json({ success: false, message: 'Invalid inspection_type' });
    }

    const [wo] = await query(
      `SELECT wo.*, v.year AS v_year, v.make AS v_make, v.model AS v_model,
              v.vin AS v_vin, v.plate_number AS v_plate, v.mileage AS v_mileage
         FROM work_orders wo
         LEFT JOIN vehicles v ON v.id = wo.vehicle_id
        WHERE wo.id = ? AND wo.workshop_id = ?`,
      [work_order_id, req.workshopId]
    );
    if (!wo) return res.status(404).json({ success: false, message: 'Work order not found' });

    // One inspection of a given type per work order — reopen the existing one
    // rather than silently creating duplicates if the page is opened twice.
    const [existing] = await query(
      'SELECT id FROM vehicle_inspections WHERE work_order_id = ? AND inspection_type = ? AND workshop_id = ?',
      [work_order_id, inspection_type, req.workshopId]
    );
    if (existing) {
      const [row] = await query('SELECT * FROM vehicle_inspections WHERE id = ?', [existing.id]);
      return res.json({ success: true, data: parseMarks(row), reused: true });
    }

    const b = req.body;
    const result = await execute(
      `INSERT INTO vehicle_inspections
         (workshop_id, work_order_id, job_card_id, vehicle_id, customer_id, inspection_type,
          estimate_date, original_estimate, customer_name, customer_phone, customer_email,
          vehicle_year, vehicle_make, vehicle_model, vin, plate_number, odometer,
          service_recommended, service_accepted, marks, notes, inspected_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        req.workshopId, work_order_id, job_card_id, wo.vehicle_id || null, wo.customer_id || null,
        inspection_type,
        b.estimate_date || new Date().toISOString().slice(0, 10),
        b.original_estimate ?? wo.service_fee ?? null,
        b.customer_name  ?? wo.customer_name  ?? null,
        b.customer_phone ?? wo.customer_phone ?? null,
        b.customer_email ?? wo.customer_email ?? null,
        b.vehicle_year   ?? (wo.v_year != null ? String(wo.v_year) : null),
        b.vehicle_make   ?? wo.v_make  ?? null,
        b.vehicle_model  ?? wo.v_model ?? null,
        b.vin            ?? wo.v_vin   ?? null,
        b.plate_number   ?? wo.v_plate ?? null,
        b.odometer       ?? wo.v_mileage ?? null,
        b.service_recommended ?? wo.description ?? null,
        b.service_accepted ?? null,
        JSON.stringify(sanitizeMarks(b.marks)),
        b.notes || null,
        req.user.id,
      ]
    );

    const [row] = await query('SELECT * FROM vehicle_inspections WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: parseMarks(row) });
  } catch (err) {
    console.error('[VehicleInspections] Create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create inspection' });
  }
});

// PUT /api/vehicle-inspections/:id — save the form (marks + header fields)
router.put('/:id', async (req, res) => {
  try {
    const [row] = await query(
      'SELECT id, status FROM vehicle_inspections WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Inspection not found' });

    const editable = [
      'estimate_date', 'original_estimate', 'customer_name', 'customer_phone', 'customer_email',
      'vehicle_year', 'vehicle_make', 'vehicle_model', 'vin', 'plate_number', 'odometer',
      'service_recommended', 'service_accepted', 'notes', 'signature_url', 'job_card_id',
    ];
    const fields = [];
    const values = [];
    for (const f of editable) {
      if (req.body[f] !== undefined) { fields.push(`${f} = ?`); values.push(req.body[f] === '' ? null : req.body[f]); }
    }
    if (req.body.marks !== undefined) {
      fields.push('marks = ?');
      values.push(JSON.stringify(sanitizeMarks(req.body.marks)));
    }
    if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    values.push(req.params.id, req.workshopId);
    await execute(`UPDATE vehicle_inspections SET ${fields.join(', ')} WHERE id = ? AND workshop_id = ?`, values);

    const [updated] = await query('SELECT * FROM vehicle_inspections WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: parseMarks(updated) });
  } catch (err) {
    console.error('[VehicleInspections] Update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save inspection' });
  }
});

/**
 * PATCH /api/vehicle-inspections/:id/complete — sign the inspection off.
 * Also stamps the matching Customer Journey checkpoint on the work order.
 */
router.patch('/:id/complete', async (req, res) => {
  try {
    const [row] = await query(
      'SELECT * FROM vehicle_inspections WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Inspection not found' });

    await execute(
      `UPDATE vehicle_inspections
          SET status = 'completed', completed_at = NOW(), inspected_by = ?
        WHERE id = ? AND workshop_id = ?`,
      [req.user.id, req.params.id, req.workshopId]
    );

    // Keep the work order's journey checklist in step with the inspection
    const journeyColumn = row.inspection_type === 'joint' ? 'joint_inspection_at'
                        : row.inspection_type === 'intake' ? 'intake_inspection_at'
                        : null;
    if (journeyColumn) {
      try {
        await execute(
          `UPDATE work_orders SET ${journeyColumn} = NOW()
            WHERE id = ? AND workshop_id = ? AND ${journeyColumn} IS NULL`,
          [row.work_order_id, req.workshopId]
        );
      } catch (e) {
        console.error('[VehicleInspections] Journey stamp failed:', e.message);
      }
    }

    // Auto-advance the work order's status now that a walk-around has been
    // signed off. Only nudges by one step and only from the safe pre-work
    // states — a mechanic can still override via the normal status controls.
    //  intake  : pending  \u2192 confirmed  (job accepted, ready to assign)
    //  joint   : in_progress \u2192 inspection (post-repair QC)
    try {
      if (row.inspection_type === 'intake') {
        const bump = await execute(
          `UPDATE work_orders
              SET status = 'confirmed'
            WHERE id = ? AND workshop_id = ? AND status = 'pending'`,
          [row.work_order_id, req.workshopId]
        );
        if (bump?.affectedRows > 0) {
          await execute(
            'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, created_at) VALUES (?, ?, ?, ?, NOW())',
            [row.work_order_id, 'confirmed', req.user.id, 'Auto-confirmed after intake inspection sign-off']
          );
        }
      } else if (row.inspection_type === 'joint') {
        const bump = await execute(
          `UPDATE work_orders
              SET status = 'inspection'
            WHERE id = ? AND workshop_id = ? AND status = 'in_progress'`,
          [row.work_order_id, req.workshopId]
        );
        if (bump?.affectedRows > 0) {
          await execute(
            'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, created_at) VALUES (?, ?, ?, ?, NOW())',
            [row.work_order_id, 'inspection', req.user.id, 'Auto-moved to inspection after joint walk-around']
          );
        }
      }
    } catch (e) {
      console.error('[VehicleInspections] Auto-status bump failed:', e.message);
    }

    const [updated] = await query('SELECT * FROM vehicle_inspections WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: parseMarks(updated) });
  } catch (err) {
    console.error('[VehicleInspections] Complete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to complete inspection' });
  }
});

/**
 * PATCH /api/vehicle-inspections/:id/signature — customer sign-off.
 * Body: { signature: "data:image/png;base64,..." }
 *
 * Stored against the inspection only. Deliberately does NOT touch
 * work_orders.signature_url, which is the completion/handover signature —
 * the walk-around sign-off is a different signature at a different moment.
 */
router.patch('/:id/signature', async (req, res) => {
  try {
    const { signature } = req.body;
    if (!signature || typeof signature !== 'string' || !signature.startsWith('data:image/')) {
      return res.status(400).json({ success: false, message: 'A base64 image data URL is required' });
    }
    const [row] = await query(
      'SELECT id, work_order_id FROM vehicle_inspections WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Inspection not found' });

    const url = await saveBase64Signature(signature, `insp${row.id}`);
    await execute('UPDATE vehicle_inspections SET signature_url = ? WHERE id = ? AND workshop_id = ?',
      [url, req.params.id, req.workshopId]);

    return res.json({ success: true, url });
  } catch (err) {
    console.error('[VehicleInspections] Signature error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to save signature' });
  }
});

// DELETE /api/vehicle-inspections/:id — discard a draft
router.delete('/:id', async (req, res) => {
  try {
    const [row] = await query(
      'SELECT id, status FROM vehicle_inspections WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Inspection not found' });
    if (row.status === 'completed') {
      return res.status(400).json({ success: false, message: 'A completed inspection cannot be deleted' });
    }
    await execute('DELETE FROM vehicle_inspections WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[VehicleInspections] Delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete inspection' });
  }
});

export default router;
