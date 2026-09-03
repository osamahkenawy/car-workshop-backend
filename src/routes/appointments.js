/**
 * ═══════════════════════════════════════════════════════════════
 *  Appointments — SOW Section B1
 *  Covers: req 60 (service reception queue + advisor assignment),
 *          req 61 (capacity-aware booking, no overbooking),
 *          req 63 (appointment-to-bay scheduling, capacity planning)
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

// ══════════════════════════════════════════════════════════════
// GET /api/appointments/available-slots
// Returns capacity-aware available slots for a given date range
// Params: date (YYYY-MM-DD), service_bay_id?, duration_min?
// (req 61 — prevents overbooking beyond defined capacity)
// ══════════════════════════════════════════════════════════════
router.get('/available-slots', async (req, res) => {
  try {
    const { date, service_bay_id, duration_min = 60 } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date required (YYYY-MM-DD)' });

    // Get workshop settings for operating hours
    const [settings] = await query(
      `SELECT settings FROM workshops WHERE id = ?`,
      [req.workshopId]
    );
    const ws = settings?.settings ? (typeof settings.settings === 'string' ? JSON.parse(settings.settings) : settings.settings) : {};
    const openHour  = ws.open_hour  || 8;
    const closeHour = ws.close_hour || 18;
    const slotDurationMin = parseInt(duration_min);

    // Get bays to check against
    let bayQuery = 'SELECT id, name, capacity FROM service_bays WHERE workshop_id = ? AND is_active = 1';
    const bayParams = [req.workshopId];
    if (service_bay_id) { bayQuery += ' AND id = ?'; bayParams.push(service_bay_id); }
    const bays = await query(bayQuery, bayParams);

    if (!bays.length) {
      return res.json({ success: true, slots: [], message: 'No active service bays found' });
    }

    // Get existing bookings for the date
    const bookedSlots = await query(
      `SELECT appointment_time, slot_duration_min, service_bay_id, status
       FROM appointments
       WHERE workshop_id = ? AND appointment_date = ? AND status NOT IN ('cancelled','no_show')`,
      [req.workshopId, date]
    );

    // Generate time slots
    const slots = [];
    for (let hour = openHour; hour < closeHour; hour++) {
      for (let min = 0; min < 60; min += slotDurationMin) {
        if (hour * 60 + min + slotDurationMin > closeHour * 60) break;
        const timeStr = `${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;

        // Count how many bookings overlap with this slot
        const overlapping = bookedSlots.filter(b => {
          const bStart = b.appointment_time;
          const bEnd = addMinutes(bStart, b.slot_duration_min);
          const sEnd = addMinutes(timeStr, slotDurationMin);
          return bStart < sEnd && bEnd > timeStr;
        });

        // Total capacity across all relevant bays
        const totalCapacity = bays.reduce((sum, bay) => sum + (bay.capacity || 1), 0);
        const baySlots = [];

        for (const bay of bays) {
          const bayBooked = overlapping.filter(b => b.service_bay_id === bay.id).length;
          const bayCapacity = bay.capacity || 1;
          baySlots.push({
            bay_id:    bay.id,
            bay_name:  bay.name,
            capacity:  bayCapacity,
            booked:    bayBooked,
            available: bayCapacity - bayBooked,
          });
        }

        const totalAvailable = baySlots.reduce((sum, b) => sum + b.available, 0);
        slots.push({
          time:           timeStr,
          duration_min:   slotDurationMin,
          total_capacity: totalCapacity,
          total_booked:   overlapping.length,
          total_available: totalAvailable,
          is_available:   totalAvailable > 0,
          bays:           baySlots,
        });
      }
    }

    res.json({ success: true, date, slots });
  } catch (err) {
    console.error('GET /appointments/available-slots error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch available slots' });
  }
});

function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}:00`;
}

// ══════════════════════════════════════════════════════════════
// GET /api/appointments — list appointments
// Supports: date, status, advisor_id, customer_id, search
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { date, from, to, status, advisor_id, customer_id, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = `
      SELECT a.*,
             c.full_name AS customer_full_name, c.phone AS customer_phone_db,
             v.plate_number AS vehicle_plate_db, v.make, v.model,
             sb.name AS bay_name,
             u.full_name AS advisor_full_name
      FROM appointments a
      LEFT JOIN customers c  ON a.customer_id   = c.id
      LEFT JOIN vehicles  v  ON a.vehicle_id     = v.id
      LEFT JOIN service_bays sb ON a.service_bay_id = sb.id
      LEFT JOIN users     u  ON a.booked_by_user_id = u.id
      WHERE a.workshop_id = ?
    `;
    const params = [req.workshopId];

    if (date)     { sql += ' AND a.appointment_date = ?'; params.push(date); }
    if (from)     { sql += ' AND a.appointment_date >= ?'; params.push(from); }
    if (to)       { sql += ' AND a.appointment_date <= ?'; params.push(to); }
    if (status)   { sql += ' AND a.status = ?'; params.push(status); }
    if (advisor_id) { sql += ' AND a.booked_by_user_id = ?'; params.push(advisor_id); }
    if (customer_id) { sql += ' AND a.customer_id = ?'; params.push(customer_id); }
    if (search) {
      sql += ' AND (a.customer_name LIKE ? OR a.customer_phone LIKE ? OR c.full_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const rows = await query(sql, params);
    res.json({ success: true, appointments: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /appointments error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch appointments' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/appointments/:id
// ══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const [appt] = await query(
      `SELECT a.*, c.full_name AS customer_full_name, v.plate_number, v.make, v.model
       FROM appointments a
       LEFT JOIN customers c ON a.customer_id = c.id
       LEFT JOIN vehicles  v ON a.vehicle_id  = v.id
       WHERE a.id = ? AND a.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found' });
    res.json({ success: true, appointment: appt });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch appointment' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/appointments — book an appointment (req 61)
// Body: { customer_id?, customer_name, customer_phone, vehicle_id?,
//         service_bay_id, appointment_date, appointment_time,
//         slot_duration_min, service_category, notes, source,
//         booked_by_user_id }
// ══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const {
      customer_id, customer_name, customer_phone, vehicle_id,
      service_bay_id, appointment_date, appointment_time,
      slot_duration_min = 60, service_category, notes,
      source = 'call_centre', booked_by_user_id
    } = req.body;

    if (!appointment_date || !appointment_time) {
      return res.status(400).json({ success: false, message: 'appointment_date and appointment_time required' });
    }

    // Capacity check — prevent overbooking (req 61)
    if (service_bay_id) {
      const [bay] = await query(
        'SELECT capacity FROM service_bays WHERE id = ? AND workshop_id = ?',
        [service_bay_id, req.workshopId]
      );
      if (bay) {
        const bayCapacity = bay.capacity || 1;
        const [{ booked }] = await query(
          `SELECT COUNT(*) AS booked FROM appointments
           WHERE workshop_id = ? AND service_bay_id = ? AND appointment_date = ?
             AND status NOT IN ('cancelled','no_show')
             AND appointment_time < ADDTIME(?, SEC_TO_TIME(? * 60))
             AND ADDTIME(appointment_time, SEC_TO_TIME(slot_duration_min * 60)) > ?`,
          [req.workshopId, service_bay_id, appointment_date,
           appointment_time, slot_duration_min, appointment_time]
        );
        if (parseInt(booked) >= bayCapacity) {
          return res.status(409).json({
            success: false,
            message: `Bay is fully booked for this slot (capacity: ${bayCapacity}). Please choose a different time.`
          });
        }
      }
    }

    const result = await execute(
      `INSERT INTO appointments
         (workshop_id, customer_id, vehicle_id, customer_name, customer_phone,
          service_bay_id, appointment_date, appointment_time, slot_duration_min,
          service_category, notes, source, booked_by_user_id, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [req.workshopId, customer_id || null, vehicle_id || null,
       customer_name || null, customer_phone || null, service_bay_id || null,
       appointment_date, appointment_time, parseInt(slot_duration_min),
       service_category || null, notes || null, source,
       booked_by_user_id || req.userId]
    );

    await logAudit(req.workshopId, req.userId, 'CREATE', 'appointments', result.insertId, null,
      { appointment_date, appointment_time, service_bay_id });

    res.status(201).json({ success: true, appointmentId: result.insertId });
  } catch (err) {
    console.error('POST /appointments error:', err);
    res.status(500).json({ success: false, message: 'Failed to create appointment' });
  }
});

// ══════════════════════════════════════════════════════════════
// PUT /api/appointments/:id — reschedule appointment
// ══════════════════════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const { appointment_date, appointment_time, service_bay_id, slot_duration_min, notes, service_category } = req.body;

    const [appt] = await query('SELECT * FROM appointments WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found' });
    if (['cancelled','completed'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot reschedule a ${appt.status} appointment` });
    }

    await execute(
      `UPDATE appointments SET
         appointment_date = COALESCE(?, appointment_date),
         appointment_time = COALESCE(?, appointment_time),
         service_bay_id   = COALESCE(?, service_bay_id),
         slot_duration_min = COALESCE(?, slot_duration_min),
         notes            = COALESCE(?, notes),
         service_category = COALESCE(?, service_category)
       WHERE id = ? AND workshop_id = ?`,
      [appointment_date || null, appointment_time || null, service_bay_id || null,
       slot_duration_min || null, notes || null, service_category || null,
       req.params.id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'UPDATE', 'appointments', req.params.id, null, { appointment_date, appointment_time });
    res.json({ success: true, message: 'Appointment updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update appointment' });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/appointments/:id/status
// ══════════════════════════════════════════════════════════════
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, cancelled_reason } = req.body;
    const VALID = ['pending','confirmed','arrived','in_progress','completed','cancelled','no_show'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    await execute(
      `UPDATE appointments SET status = ?,
       cancelled_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_reason END
       WHERE id = ? AND workshop_id = ?`,
      [status, status, cancelled_reason || null, req.params.id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'STATUS_CHANGE', 'appointments', req.params.id, null, { status });
    res.json({ success: true, message: `Appointment ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update appointment status' });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/appointments/:id/assign-advisor — assign advisor (req 60)
// ══════════════════════════════════════════════════════════════
router.patch('/:id/assign-advisor', async (req, res) => {
  try {
    const { advisor_id } = req.body;
    if (!advisor_id) return res.status(400).json({ success: false, message: 'advisor_id required' });

    await execute(
      `UPDATE appointments SET booked_by_user_id = ?, status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
       WHERE id = ? AND workshop_id = ?`,
      [advisor_id, req.params.id, req.workshopId]
    );

    res.json({ success: true, message: 'Advisor assigned and appointment confirmed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to assign advisor' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/appointments/queue/today — service reception queue (req 60)
// ══════════════════════════════════════════════════════════════
router.get('/queue/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rows = await query(
      `SELECT a.*,
              c.full_name AS customer_full_name, c.phone AS customer_phone_db,
              v.plate_number, v.make, v.model,
              sb.name AS bay_name,
              u.full_name AS advisor_name
       FROM appointments a
       LEFT JOIN customers c  ON a.customer_id   = c.id
       LEFT JOIN vehicles  v  ON a.vehicle_id     = v.id
       LEFT JOIN service_bays sb ON a.service_bay_id = sb.id
       LEFT JOIN users u      ON a.booked_by_user_id = u.id
       WHERE a.workshop_id = ? AND a.appointment_date = ?
         AND a.status NOT IN ('cancelled','no_show')
       ORDER BY a.appointment_time ASC, a.status ASC`,
      [req.workshopId, today]
    );
    res.json({ success: true, queue: rows, date: today, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch queue' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/appointments/capacity/week — bay capacity view (req 63)
// ══════════════════════════════════════════════════════════════
router.get('/capacity/week', async (req, res) => {
  try {
    const { from } = req.query;
    const startDate = from || new Date().toISOString().split('T')[0];

    const bays = await query(
      'SELECT id, name, capacity FROM service_bays WHERE workshop_id = ? AND is_active = 1',
      [req.workshopId]
    );

    // Build 7-day view
    const result = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];

      const dayBookings = await query(
        `SELECT service_bay_id, COUNT(*) AS booked
         FROM appointments
         WHERE workshop_id = ? AND appointment_date = ? AND status NOT IN ('cancelled','no_show')
         GROUP BY service_bay_id`,
        [req.workshopId, dateStr]
      );

      const bayUtil = bays.map(bay => {
        const booked = dayBookings.find(b => b.service_bay_id === bay.id)?.booked || 0;
        return {
          bay_id:    bay.id,
          bay_name:  bay.name,
          capacity:  bay.capacity || 1,
          booked,
          available: Math.max(0, (bay.capacity || 1) - booked),
          utilization_pct: bay.capacity ? Math.round((booked / bay.capacity) * 100) : 0,
        };
      });

      result.push({ date: dateStr, bays: bayUtil });
    }

    res.json({ success: true, capacity: result });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch capacity' });
  }
});

export default router;
