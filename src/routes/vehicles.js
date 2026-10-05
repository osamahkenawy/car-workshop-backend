import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkupFields, clampTextFields } from '../lib/sanitize.js';

// SR-01/SR-16 — sanitise at the write boundary. Identity fields can never
// legitimately contain markup, so it is stripped; free text is stored verbatim
// because HTML-stripping a note destroys legitimate content such as
// "worn < 2mm". Only keys actually present in the body are touched, so the
// update routes' "default to the existing row" destructuring still works.
const VEHICLES_IDENTITY = ['make', 'model', 'plate_number', 'plate_code', 'plate_emirate', 'vin', 'engine_no', 'fleet_code', 'color', 'fuel_type', 'transmission'];
const VEHICLES_FREE_TEXT = ['notes'];
function _clean(body) {
  return clampTextFields(stripMarkupFields(body || {}, VEHICLES_IDENTITY), VEHICLES_FREE_TEXT);
}


const router = express.Router();
router.use(authMiddleware);

// NEW MODULE (not in original delivery-service source): customer-owned vehicles.
// A vehicle belongs to a customer within a workshop; work_orders reference
// vehicles via vehicle_id so service history can be tracked per-vehicle.

// GET /api/vehicles
router.get('/', async (req, res) => {
  try {
    const { search, customer_id, fuel_type, sort = 'recent', page = 1, limit = 50 } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 50;
    const offset = (pg - 1) * lim;
    let where = 'WHERE v.workshop_id = ? AND v.is_active = TRUE';
    const params = [req.workshopId];

    if (customer_id) { where += ' AND v.customer_id = ?'; params.push(customer_id); }
    if (fuel_type) { where += ' AND v.fuel_type = ?'; params.push(fuel_type); }
    if (search) {
      where += ' AND (v.plate_number LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR v.vin LIKE ? OR c.full_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const orderBy =
      sort === 'oldest'   ? 'v.created_at ASC'  :
      sort === 'mileage'  ? 'v.mileage DESC'    :
      sort === 'services' ? 'wo_count DESC'     :
      sort === 'make'     ? 'v.make ASC, v.model ASC' :
                            'v.created_at DESC';

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM vehicles v
       LEFT JOIN customers c ON c.id = v.customer_id ${where}`,
      params
    );

    const vehicles = await query(
      `SELECT v.*,
              c.full_name AS customer_name,
              c.phone     AS customer_phone,
              (SELECT COUNT(*)            FROM work_orders w WHERE w.vehicle_id = v.id AND w.workshop_id = v.workshop_id) AS wo_count,
              (SELECT MAX(w.created_at)   FROM work_orders w WHERE w.vehicle_id = v.id AND w.workshop_id = v.workshop_id) AS last_service_at,
              (SELECT COALESCE(SUM(COALESCE(NULLIF(w.total_amount,0), NULLIF(w.service_fee,0), 0)),0) FROM work_orders w WHERE w.vehicle_id = v.id AND w.workshop_id = v.workshop_id AND w.status = 'completed') AS total_spent
       FROM vehicles v
       LEFT JOIN customers c ON c.id = v.customer_id
       ${where} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    // ── Workshop-wide summary (KPIs + fuel breakdown) ──
    const [summary] = await query(
      `SELECT COUNT(*) AS total_vehicles,
              COUNT(DISTINCT v.customer_id) AS unique_owners,
              COALESCE(AVG(v.mileage),0) AS avg_mileage
       FROM vehicles v WHERE v.workshop_id = ? AND v.is_active = TRUE`,
      [req.workshopId]
    );
    const [woSummary] = await query(
      `SELECT COUNT(*) AS total_services,
              COALESCE(SUM(CASE WHEN status = 'completed'
                    THEN COALESCE(NULLIF(total_amount,0), NULLIF(service_fee,0), 0)
                    ELSE 0 END),0) AS total_service_value
       FROM work_orders WHERE workshop_id = ? AND vehicle_id IS NOT NULL`,
      [req.workshopId]
    );
    const fuelRows = await query(
      `SELECT fuel_type, COUNT(*) AS cnt FROM vehicles
       WHERE workshop_id = ? AND is_active = TRUE GROUP BY fuel_type`,
      [req.workshopId]
    );
    const fuel_breakdown = fuelRows.reduce((acc, r) => { acc[r.fuel_type || 'other'] = Number(r.cnt); return acc; }, {});

    return res.json({
      success: true,
      data: vehicles,
      pagination: { total, page: pg, limit: lim },
      summary: {
        total_vehicles: Number(summary?.total_vehicles || 0),
        unique_owners: Number(summary?.unique_owners || 0),
        avg_mileage: Math.round(Number(summary?.avg_mileage || 0)),
        total_services: Number(woSummary?.total_services || 0),
        total_service_value: Number(woSummary?.total_service_value || 0),
        fuel_breakdown,
      },
    });
  } catch (err) {
    console.error('[Vehicles] List error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch vehicles' });
  }
});

// GET /api/vehicles/:id
router.get('/:id', async (req, res) => {
  try {
    const [vehicle] = await query(
      `SELECT v.*, c.full_name as customer_name, c.phone as customer_phone
       FROM vehicles v
       LEFT JOIN customers c ON c.id = v.customer_id
       WHERE v.id = ? AND v.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const [workOrderStats] = await query(
      `SELECT COUNT(*) as total_work_orders,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed_work_orders
       FROM work_orders WHERE vehicle_id = ? AND workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    const workOrders = await query(
      `SELECT id, work_order_number, status, service_fee, total_amount, cash_amount, payment_method, created_at
       FROM work_orders WHERE vehicle_id = ? AND workshop_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, data: { ...vehicle, ...workOrderStats, work_orders: workOrders } });
  } catch (err) {
    console.error('[Vehicles] Fetch error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch vehicle' });
  }
});

// GET /api/vehicles/:id/work-orders — full service history for a vehicle
router.get('/:id/work-orders', async (req, res) => {
  try {
    const [vehicle] = await query('SELECT id FROM vehicles WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const workOrders = await query(
      `SELECT w.*, c.full_name as customer_name
       FROM work_orders w
       LEFT JOIN customers c ON c.id = w.customer_id
       WHERE w.vehicle_id = ? AND w.workshop_id = ?
       ORDER BY w.created_at DESC`,
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, data: workOrders });
  } catch (err) {
    console.error('[Vehicles] Work orders error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch work orders for vehicle' });
  }
});

// POST /api/vehicles
router.post('/', async (req, res) => {
  try {
    const {
      customer_id, make, model, year, plate_number, vin, color,
      mileage, fuel_type = 'petrol', transmission = 'automatic', notes,
      plate_code, plate_emirate, engine_no, fleet_code,
    } = _clean(req.body);

    if (!customer_id || !make || !model) {
      return res.status(400).json({ success: false, message: 'Customer, make and model required' });
    }

    // ── VIN is mandatory on every new vehicle (process change, 15 Sep 2026) ──
    // Only on create. The 5,694 vehicles already on file without one are
    // left alone; they get their VIN the next time the car comes in, which
    // is when the job card wizard asks for it.
    //
    // `allow_missing_vin` is for the bulk importer replaying a supplier
    // file that genuinely has no chassis numbers — it is not sent by any
    // screen.
    if (req.body.allow_missing_vin !== true && (!vin || !String(vin).trim())) {
      return res.status(400).json({
        success: false,
        code: 'VIN_REQUIRED',
        message: 'VIN / chassis number is required.',
      });
    }

    // A chassis number is unique to one car in the world, so the same VIN
    // on two rows means one of them is wrong — usually the same car added
    // twice under two customers, which then splits its service history in
    // half. Blocked outright rather than warned about, because unlike a
    // duplicate name there is no legitimate case for it.
    if (vin && String(vin).trim()) {
      const [dupVin] = await query(
        `SELECT v.id, v.plate_number, c.full_name
           FROM vehicles v JOIN customers c ON c.id = v.customer_id
          WHERE v.workshop_id = ? AND v.vin = ? AND v.is_active = 1 LIMIT 1`,
        [req.workshopId, String(vin).trim()]
      );
      if (dupVin) {
        return res.status(409).json({
          success: false,
          code: 'VIN_DUPLICATE',
          message: `This VIN is already on file for ${dupVin.plate_number || 'a vehicle'} (${dupVin.full_name}).`,
          data: { vehicle_id: dupVin.id },
        });
      }
    }

    // Validate customer belongs to the same workshop before inserting
    const [customer] = await query('SELECT id FROM customers WHERE id = ? AND workshop_id = ?',
      [customer_id, req.workshopId]);
    if (!customer) {
      return res.status(400).json({ success: false, message: 'Customer not found in this workshop' });
    }

    const result = await execute(
      `INSERT INTO vehicles (workshop_id, customer_id, make, model, year, plate_number,
        plate_code, plate_emirate, vin, engine_no, fleet_code,
        color, mileage, fuel_type, transmission, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, customer_id, make, model, year || null, plate_number || null,
       plate_code || null, plate_emirate || null, vin ? String(vin).trim() : null,
       engine_no || null, fleet_code || null,
       color || null, mileage || null, fuel_type, transmission, notes || null]
    );
    const [vehicle] = await query('SELECT * FROM vehicles WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: vehicle });
  } catch (err) {
    console.error('[Vehicles] Create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create vehicle' });
  }
});

// PUT /api/vehicles/:id
router.put('/:id', async (req, res) => {
  try {
    // Fetch existing record so partial updates don't null-out required fields
    const [existing] = await query('SELECT * FROM vehicles WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Vehicle not found' });

    const {
      customer_id = existing.customer_id,
      make = existing.make,
      model = existing.model,
      year = existing.year,
      plate_number = existing.plate_number,
      plate_code = existing.plate_code,
      plate_emirate = existing.plate_emirate,
      vin = existing.vin,
      engine_no = existing.engine_no,
      fleet_code = existing.fleet_code,
      color = existing.color,
      mileage = existing.mileage,
      fuel_type = existing.fuel_type,
      transmission = existing.transmission,
      notes = existing.notes,
      is_active = existing.is_active,
    } = _clean(req.body);

    // Filling in a missing VIN is the main reason this endpoint gets called
    // from the job card wizard, so the same uniqueness rule as create
    // applies — excluding this vehicle's own row, or saving a record
    // without touching its VIN would report the vehicle as a duplicate of
    // itself.
    if (req.body.vin !== undefined && vin && String(vin).trim() && String(vin).trim() !== (existing.vin || '')) {
      const [dupVin] = await query(
        `SELECT v.id, v.plate_number, c.full_name
           FROM vehicles v JOIN customers c ON c.id = v.customer_id
          WHERE v.workshop_id = ? AND v.vin = ? AND v.id <> ? AND v.is_active = 1 LIMIT 1`,
        [req.workshopId, String(vin).trim(), req.params.id]
      );
      if (dupVin) {
        return res.status(409).json({
          success: false,
          code: 'VIN_DUPLICATE',
          message: `This VIN is already on file for ${dupVin.plate_number || 'a vehicle'} (${dupVin.full_name}).`,
          data: { vehicle_id: dupVin.id },
        });
      }
    }

    // If customer_id is being changed, validate it belongs to this workshop
    if (req.body.customer_id) {
      const [customer] = await query('SELECT id FROM customers WHERE id = ? AND workshop_id = ?',
        [customer_id, req.workshopId]);
      if (!customer) {
        return res.status(400).json({ success: false, message: 'Customer not found in this workshop' });
      }
    }

    await execute(
      `UPDATE vehicles SET customer_id=?, make=?, model=?, year=?, plate_number=?,
       plate_code=?, plate_emirate=?, vin=?, engine_no=?, fleet_code=?,
       color=?, mileage=?, fuel_type=?, transmission=?, notes=?, is_active=?
       WHERE id = ? AND workshop_id = ?`,
      [customer_id, make, model, year || null, plate_number || null,
       plate_code || null, plate_emirate || null,
       vin ? String(vin).trim() : null, engine_no || null, fleet_code || null,
       color || null, mileage || null, fuel_type, transmission, notes || null,
       is_active !== undefined ? is_active : true, req.params.id, req.workshopId]
    );
    const [vehicle] = await query('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: vehicle });
  } catch (err) {
    console.error('[Vehicles] Update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update vehicle' });
  }
});

// DELETE /api/vehicles/:id — soft delete (consistent with customers.js convention)
router.delete('/:id', async (req, res) => {
  try {
    await execute('UPDATE vehicles SET is_active = FALSE WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Vehicle deactivated' });
  } catch (err) {
    console.error('[Vehicles] Delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to deactivate vehicle' });
  }
});

export default router;
