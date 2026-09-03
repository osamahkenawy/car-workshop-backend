import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { stripMarkupFields, clampTextFields } from '../lib/sanitize.js';

// SR-01/SR-16 — sanitise at the write boundary. Identity fields can never
// legitimately contain markup, so it is stripped; free text is stored verbatim
// because HTML-stripping a note destroys legitimate content such as
// "worn < 2mm". Only keys actually present in the body are touched, so the
// update routes' "default to the existing row" destructuring still works.
const CUSTOMERS_IDENTITY = ['full_name', 'company_name', 'email', 'phone', 'phone_alt', 'address_line1', 'address_line2', 'area', 'city', 'emirate', 'trn', 'contact_person'];
const CUSTOMERS_FREE_TEXT = ['notes'];
function _clean(body) {
  return clampTextFields(stripMarkupFields(body || {}, CUSTOMERS_IDENTITY), CUSTOMERS_FREE_TEXT);
}


const router = express.Router();
router.use(authMiddleware);

// JUDGMENT CALL: dropped zone_id (geographic delivery-zone assignment) — a customer's
// service bay is decided per work order (which bay services their vehicle), not stored
// on the customer record. Kept city/emirate as plain address fields (still relevant —
// customers still have a home/business address in the UAE).
// JUDGMENT CALL: dropped custom_delivery_fee — not clearly reusable in a workshop context
// (no per-order delivery fee concept); tax_exempt / credit_limit / credit_used kept as-is
// since workshop credit accounts (e.g. fleet/corporate customers) are plausible.

// GET /api/customers
router.get('/', async (req, res) => {
  try {
    const { search, type, emirate, page = 1, limit = 50, sort } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 50;
    const offset = (pg - 1) * lim;
    let where = 'WHERE c.workshop_id = ?';
    const params = [req.workshopId];

    if (type) { where += ' AND c.client_category = ?'; params.push(type); }
    if (emirate) { where += ' AND c.emirate = ?'; params.push(emirate); }
    if (search) {
      where += ' AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.company_name LIKE ? OR c.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Sort is interpolated into the SQL, so it is resolved through this map and
    // never from the raw query string.
    const ORDER_BY = {
      name:   'c.full_name ASC',
      // "Recent" means last touched in any way, so a job still in progress
      // counts. That is deliberately not the same as last_visit_at, which is
      // the last *completed* visit and must match the Customer 360 card.
      recent: 'last_activity_at IS NULL, last_activity_at DESC, c.created_at DESC',
      value:  'lifetime_value DESC, c.full_name ASC',
    };
    const orderBy = ORDER_BY[sort] || ORDER_BY.name;

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM customers c ${where}`, params);
    const customers = await query(
      `SELECT c.*,
              COUNT(o.id) as total_work_orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed_work_orders,
              MAX(o.completed_at) AS last_visit_at,
              MAX(o.created_at) AS last_activity_at,
              COALESCE(SUM(CASE WHEN o.status = 'completed'
                    THEN COALESCE(NULLIF(o.total_amount, 0), o.service_fee, 0)
                    ELSE 0 END), 0) AS lifetime_value
       FROM customers c
       LEFT JOIN work_orders o ON o.customer_id = c.id
       ${where} GROUP BY c.id ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${offset}`,
      params
    );
    return res.json({ success: true, data: customers, pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch customers' });
  }
});

// GET /api/customers/stats  — aggregate KPIs for the workshop
router.get('/stats', async (req, res) => {
  try {
    const [counts] = await query(
      `SELECT
         COUNT(*) as total,
         SUM(is_active = 1) as active,
         SUM(is_active = 0) as inactive,
         SUM(type = 'individual') as individual,
         SUM(type = 'business')   as business,
         SUM(type = 'fleet')      as fleet,
         SUM(type = 'other')      as other
       FROM customers WHERE workshop_id = ?`,
      [req.workshopId]
    );
    const [workOrderStats] = await query(
      `SELECT COUNT(o.id) as total_work_orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as failed
       FROM work_orders o
       INNER JOIN customers c ON o.customer_id = c.id
       WHERE c.workshop_id = ?`,
      [req.workshopId]
    );
    const topCustomers = await query(
      `SELECT c.id, c.full_name, c.company_name, c.type,
              COUNT(o.id) as total_work_orders,
              SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END) as completed_work_orders
       FROM customers c
       LEFT JOIN work_orders o ON o.customer_id = c.id
       WHERE c.workshop_id = ? AND c.is_active = 1
       GROUP BY c.id ORDER BY total_work_orders DESC LIMIT 5`,
      [req.workshopId]
    );
    return res.json({ success: true, data: { ...counts, ...workOrderStats, top_customers: topCustomers } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// PATCH /api/customers/:id/toggle — activate / deactivate
router.patch('/:id/toggle', async (req, res) => {
  try {
    const [customer] = await query('SELECT id, is_active FROM customers WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]);
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
    await execute('UPDATE customers SET is_active = ? WHERE id = ? AND workshop_id = ?',
      [!customer.is_active, req.params.id, req.workshopId]);
    return res.json({ success: true, data: { is_active: !customer.is_active } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to toggle customer status' });
  }
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
  try {
    const [customer] = await query(
      `SELECT c.* FROM customers c
       WHERE c.id = ? AND c.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const [workOrderStats] = await query(
      `SELECT COUNT(*) as total_work_orders,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed_work_orders,
              SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as failed_work_orders,
              SUM(CASE WHEN payment_method='cash' AND status='completed' THEN COALESCE(cash_amount,0) ELSE 0 END) as credit_used
       FROM work_orders WHERE customer_id = ?`,
      [req.params.id]
    );
    const workOrders = await query(
      `SELECT id, work_order_number, status, service_fee, total_amount, cash_amount, payment_method, created_at
       FROM work_orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`,
      [req.params.id]
    );
    return res.json({ success: true, data: { ...customer, ...workOrderStats, work_orders: workOrders } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch customer' });
  }
});

// POST /api/customers
router.post('/', async (req, res) => {
  try {
    const {
      full_name, company_name, email, phone, phone_alt, type = 'individual',
      client_category = 'other', address_line1, address_line2, area, city,
      emirate: rawEmirate, latitude, longitude, credit_limit, notes
    } = _clean(req.body);
    const emirate = rawEmirate ? String(rawEmirate).slice(0, 100) : null;
    if (!full_name || !phone) {
      return res.status(400).json({ success: false, message: 'Name and phone required' });
    }
    // Phone format validation
    const phoneClean = phone.replace(/[\s\-()]/g, '');
    if (!/^\+?\d{7,20}$/.test(phoneClean)) {
      return res.status(400).json({ success: false, message: 'Invalid phone number format' });
    }
    // Email format (if provided)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    // Credit limit bounds
    if (credit_limit !== undefined && credit_limit !== null && Number(credit_limit) < 0) {
      return res.status(400).json({ success: false, message: 'Credit limit cannot be negative' });
    }
    // Coordinate bounds
    if (latitude !== undefined && latitude !== null && latitude !== '') {
      const lat = parseFloat(latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ success: false, message: 'Latitude must be between -90 and 90' });
      }
    }
    if (longitude !== undefined && longitude !== null && longitude !== '') {
      const lng = parseFloat(longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, message: 'Longitude must be between -180 and 180' });
      }
    }
    // Duplicate check
    const [existing] = await query(
      'SELECT id FROM customers WHERE workshop_id = ? AND phone = ?', [req.workshopId, phone]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'A customer with this phone number already exists' });
    }
    const result = await execute(
      `INSERT INTO customers (workshop_id, full_name, company_name, email, phone, phone_alt, type,
        client_category, address_line1, address_line2, area, city, emirate,
        latitude, longitude, credit_limit, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, full_name, company_name || null, email || null, phone, phone_alt || null,
       type, client_category, address_line1 || null, address_line2 || null, area || null,
       city || null, emirate, latitude || null, longitude || null,
       credit_limit || 0, notes || null]
    );
    const [customer] = await query('SELECT * FROM customers WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: customer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to create customer' });
  }
});

// PUT /api/customers/:id
router.put('/:id', async (req, res) => {
  try {
    // Fetch existing record so partial updates don't null-out required fields
    const [existing] = await query('SELECT * FROM customers WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Customer not found' });

    const {
      full_name = existing.full_name,
      company_name = existing.company_name,
      email = existing.email,
      phone = existing.phone,
      phone_alt = existing.phone_alt,
      type = existing.type,
      client_category = existing.client_category,
      address_line1 = existing.address_line1,
      address_line2 = existing.address_line2,
      area = existing.area,
      city = existing.city,
      emirate = existing.emirate,
      latitude = existing.latitude,
      longitude = existing.longitude,
      credit_limit = existing.credit_limit,
      notes = existing.notes,
      is_active = existing.is_active,
    } = _clean(req.body);

    // Validate phone format if changed
    if (req.body.phone) {
      const pClean = phone.replace(/[\s\-()]/g, '');
      if (!/^\+?\d{7,20}$/.test(pClean)) {
        return res.status(400).json({ success: false, message: 'Invalid phone number format' });
      }
    }
    // Validate email format if changed
    if (req.body.email && email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    // Credit limit bounds
    if (req.body.credit_limit !== undefined && Number(credit_limit) < 0) {
      return res.status(400).json({ success: false, message: 'Credit limit cannot be negative' });
    }
    // Coordinate bounds
    if (req.body.latitude !== undefined && latitude !== null && latitude !== '') {
      const lat = parseFloat(latitude);
      if (isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ success: false, message: 'Latitude must be between -90 and 90' });
      }
    }
    if (req.body.longitude !== undefined && longitude !== null && longitude !== '') {
      const lng = parseFloat(longitude);
      if (isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, message: 'Longitude must be between -180 and 180' });
      }
    }

    await execute(
      `UPDATE customers SET full_name=?, company_name=?, email=?, phone=?, phone_alt=?, type=?,
       client_category=?, address_line1=?, address_line2=?, area=?, city=?, emirate=?,
       latitude=?, longitude=?, credit_limit=?, notes=?, is_active=?
       WHERE id = ? AND workshop_id = ?`,
      [full_name, company_name || null, email || null, phone, phone_alt || null,
       type || 'individual', client_category || 'other', address_line1 || null,
       address_line2 || null, area || null, city || null,
       emirate ? String(emirate).slice(0, 100) : (existing.emirate || null),
       latitude || null, longitude || null, credit_limit || 0,
       notes || null, is_active !== undefined ? is_active : true, req.params.id, req.workshopId]
    );
    const [customer] = await query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: customer });
  } catch (err) {
    console.error('[Customers] Update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  try {
    await execute('UPDATE customers SET is_active = FALSE WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Customer deactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to deactivate customer' });
  }
});

export default router;
