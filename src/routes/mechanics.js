import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { getIO } from '../lib/socket.js';
import { sendNotificationEmail } from '../lib/email.js';
import { getUsageStats } from '../middleware/plan-gate.js';
import { config } from '../config.js';
import { detectZone } from '../lib/zone-detect.js';
import { validatePhone, validateStatus, VALID_MECHANIC_STATUSES } from '../lib/mechanic-validation.js';

const router = express.Router();
router.use(authMiddleware);

// JUDGMENT CALL: dropped vehicle_type/vehicle_plate/vehicle_model/vehicle_color columns —
// those described the driver's OWN delivery vehicle, which doesn't apply to a mechanic.
// JUDGMENT CALL: total_deliveries -> total_jobs_completed.
// JUDGMENT CALL: kept zone_id -> service_bay_id as the mechanic's default/preferred service bay
// assignment (reinterpreted from "home delivery zone" to "usual bay they work in").
// Work order status values referenced here are reinterpreted for a workshop context:
// 'in_transit' -> 'in_progress' (job actively being worked), 'delivered' -> 'completed'.

// Allowed sort columns for the mechanic list (F3). Whitelisted to avoid SQL injection.
const MECHANIC_SORTS = {
  status:        "m.status = 'available' DESC, m.full_name ASC",
  name:          'm.full_name ASC',
  rating:        'm.rating DESC, m.full_name ASC',
  deliveries:    'total_work_orders DESC, m.full_name ASC',
  joined:        'm.joined_at DESC',
  last_ping:     'last_ping DESC',
  created:       'm.created_at DESC',
};

// S3 — strip script/style tags + on*= attributes from free-text fields stored on a mechanic.
// Notes are rendered as plain text in the CRM, but defence-in-depth keeps stored XSS out of the DB.
function sanitizeNotes(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return null;
  return s
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, 5000);
}

// GET /api/mechanics — list all mechanics for the workshop
// B1/P1 fix: replaced 5 correlated subqueries with a single LEFT JOIN to a per-mechanic aggregate.
// F2 fix: search now also matches m.email and u.username.
// F3 fix: optional ?sort= dropdown (whitelisted column map).
router.get('/', async (req, res) => {
  try {
    const { status, service_bay_id, search, page = 1, limit = 50, sort, is_active } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = Math.min(parseInt(limit, 10) || 50, 200); // hard cap 200
    const offset = (pg - 1) * lim;
    let where = 'WHERE m.workshop_id = ?';
    const params = [req.workshopId];

    if (status) { where += ' AND m.status = ?'; params.push(status); }
    if (service_bay_id) { where += ' AND m.service_bay_id = ?'; params.push(service_bay_id); }
    if (is_active === '0' || is_active === 'false') where += ' AND m.is_active = 0';
    else if (is_active === '1' || is_active === 'true') where += ' AND m.is_active = 1';
    if (search) {
      where += ' AND (m.full_name LIKE ? OR m.phone LIKE ? OR m.email LIKE ? OR u.username LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const orderBy = MECHANIC_SORTS[sort] || MECHANIC_SORTS.status;

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM mechanics m LEFT JOIN users u ON m.user_id = u.id ${where}`, params
    );

    const mechanics = await query(
      `SELECT m.*, b.name as service_bay_name, u.username as username,
              COALESCE(stats.active_work_orders, 0)    as active_work_orders,
              COALESCE(stats.total_work_orders, 0)     as total_work_orders,
              COALESCE(stats.completed_work_orders, 0) as completed_work_orders,
              COALESCE(stats.work_orders_today, 0)     as work_orders_today,
              COALESCE(stats.total_earned, 0)     as total_earned,
              mlp.last_ping
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       LEFT JOIN users u ON m.user_id = u.id
       LEFT JOIN (
         SELECT mechanic_id,
                SUM(status = 'in_progress')                                          AS active_work_orders,
                COUNT(*)                                                              AS total_work_orders,
                SUM(status = 'completed')                                            AS completed_work_orders,
                SUM(DATE(created_at) = CURDATE())                                    AS work_orders_today,
                SUM(CASE WHEN status = 'completed' THEN service_fee ELSE 0 END)     AS total_earned
         FROM work_orders
         WHERE workshop_id = ? AND mechanic_id IS NOT NULL
         GROUP BY mechanic_id
       ) stats ON stats.mechanic_id = m.id
       LEFT JOIN (
         SELECT mechanic_id, MAX(recorded_at) as last_ping
         FROM mechanic_locations
         GROUP BY mechanic_id
       ) mlp ON mlp.mechanic_id = m.id
       ${where} ORDER BY ${orderBy} LIMIT ${lim} OFFSET ${offset}`,
      [req.workshopId, ...params]
    );
    return res.json({ success: true, data: mechanics, pagination: { total: parseInt(total), page: pg, limit: lim } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to fetch mechanics' });
  }
});

// Helper: parse optional ?bbox=lat1,lng1,lat2,lng2 viewport filter (P2)
function bboxClause(bbox) {
  if (!bbox || typeof bbox !== 'string') return { sql: '', params: [] };
  const parts = bbox.split(',').map(parseFloat);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return { sql: '', params: [] };
  const [lat1, lng1, lat2, lng2] = parts;
  const minLat = Math.min(lat1, lat2), maxLat = Math.max(lat1, lat2);
  const minLng = Math.min(lng1, lng2), maxLng = Math.max(lng1, lng2);
  return {
    sql: ' AND ml.lat BETWEEN ? AND ? AND ml.lng BETWEEN ? AND ?',
    params: [minLat, maxLat, minLng, maxLng],
  };
}

// GET /api/mechanics/live-locations — all active mechanics with latest GPS (for live map)
// P2 fix: optional ?bbox= viewport filter to avoid shipping all 500+ mechanics each poll.
router.get('/live-locations', async (req, res) => {
  try {
    const bb = bboxClause(req.query.bbox);
    const mechanics = await query(
      `SELECT m.id, m.full_name, m.phone, m.status, m.service_bay_id,
              b.name as service_bay_name,
              ml.lat as last_lat, ml.lng as last_lng, ml.speed, ml.heading, ml.recorded_at as last_ping,
              awo.work_order_number as current_work_order,
              awo.customer_name, awo.customer_phone as customer_phone_num, awo.customer_address,
              awo.status as work_order_status
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       LEFT JOIN (
         SELECT mechanic_id, lat, lng, speed, heading, recorded_at
         FROM mechanic_locations
         WHERE id IN (SELECT MAX(id) FROM mechanic_locations GROUP BY mechanic_id)
       ) ml ON ml.mechanic_id = m.id
       LEFT JOIN (
         SELECT o.mechanic_id, o.id as work_order_id, o.work_order_number,
                o.customer_name, o.customer_phone, o.customer_address, o.status
         FROM work_orders o
         WHERE o.status IN ('assigned','accepted','in_progress')
           AND o.id = (SELECT MAX(o2.id) FROM work_orders o2 WHERE o2.mechanic_id = o.mechanic_id AND o2.status IN ('assigned','accepted','in_progress'))
       ) awo ON awo.mechanic_id = m.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE AND m.status != 'offline'${bb.sql}`,
      [req.workshopId, ...bb.params]
    );
    const [offlineRow] = await query(
      'SELECT COUNT(*) as cnt FROM mechanics WHERE workshop_id = ? AND is_active = TRUE AND status = ?',
      [req.workshopId, 'offline']
    );
    return res.json({ success: true, data: mechanics, offline_count: offlineRow?.cnt || 0 });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch live locations' });
  }
});

// GET /api/mechanics/locations/live — alias for /live-locations
router.get('/locations/live', async (req, res) => {
  try {
    const mechanics = await query(
      `SELECT m.id, m.full_name, m.phone, m.status, m.service_bay_id,
              b.name as service_bay_name,
              ml.lat as last_lat, ml.lng as last_lng, ml.speed, ml.heading, ml.recorded_at as last_ping,
              (SELECT work_order_number FROM work_orders o WHERE o.mechanic_id = m.id AND o.status IN ('assigned','accepted','in_progress') ORDER BY o.created_at DESC LIMIT 1) as current_work_order
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       LEFT JOIN (
         SELECT mechanic_id, lat, lng, speed, heading, recorded_at
         FROM mechanic_locations
         WHERE id IN (SELECT MAX(id) FROM mechanic_locations GROUP BY mechanic_id)
       ) ml ON ml.mechanic_id = m.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE AND m.status != 'offline'`,
      [req.workshopId]
    );
    const [offlineRow2] = await query(
      'SELECT COUNT(*) as cnt FROM mechanics WHERE workshop_id = ? AND is_active = TRUE AND status = ?',
      [req.workshopId, 'offline']
    );
    return res.json({ success: true, data: mechanics, offline_count: offlineRow2?.cnt || 0 });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch live locations' });
  }
});

// GET /api/mechanics/me — Current mechanic's own profile (for mobile app)
router.get('/me', async (req, res) => {
  try {
    // Find mechanic record linked to the authenticated user
    const [mechanic] = await query(
      `SELECT m.*, b.name as service_bay_name,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'in_progress') as active_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id) as total_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as completed_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND DATE(o.created_at) = CURDATE()) as work_orders_today,
              (SELECT COALESCE(SUM(o.service_fee),0) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as total_earned,
              (SELECT recorded_at FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_ping,
              (SELECT lat FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_lat,
              (SELECT lng FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_lng
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       WHERE m.user_id = ? AND m.workshop_id = ?`,
      [req.user.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const recentWorkOrders = await query(
      `SELECT id, work_order_number, status, customer_name, service_fee, created_at, completed_at
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 50`,
      [mechanic.id, req.workshopId]
    );
    return res.json({ success: true, data: { ...mechanic, recent_work_orders: recentWorkOrders } });
  } catch (err) {
    console.error('Mechanic /me error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch mechanic profile' });
  }
});

// GET /api/mechanics/:id
router.get('/:id', async (req, res) => {
  try {
    // P5 — hint to browsers/proxies that this is short-lived per-workshop data
    res.set('Cache-Control', 'private, max-age=30');
    const [mechanic] = await query(
      `SELECT m.*, b.name as service_bay_name,
              u.username as username,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'in_progress') as active_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id) as total_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as completed_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND DATE(o.created_at) = CURDATE()) as work_orders_today,
              (SELECT COALESCE(SUM(o.service_fee),0) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as total_earned,
              (SELECT recorded_at FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_ping,
              (SELECT lat FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_lat,
              (SELECT lng FROM mechanic_locations ml WHERE ml.mechanic_id = m.id ORDER BY ml.recorded_at DESC LIMIT 1) as last_lng
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       LEFT JOIN users u ON m.user_id = u.id
       WHERE m.id = ? AND m.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    const recentWorkOrders = await query(
      `SELECT id, work_order_number, status, customer_name, service_fee, created_at, completed_at
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 50`,
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, data: { ...mechanic, recent_work_orders: recentWorkOrders } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch mechanic' });
  }
});

/* ── Helper: create a user account for a mechanic ── */
async function createMechanicAccount(workshopId, { full_name, phone, email, password }) {
  // Generate username from name: lowercase, no spaces, + random suffix
  const base = full_name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 15);
  const suffix = Math.floor(1000 + Math.random() * 9000);
  const username = `${base}${suffix}`;
  // Store the mechanic's real email so they can log in with it.
  // Fall back to an internal-only address only if a UNIQUE constraint error occurs
  // (e.g. same email used across workshops on a shared users table).
  const preferredEmail = email || `${username}@mechanic.local`;
  // Use the password set by admin; fall back to auto-generated default only if empty
  const rawPassword = password && password.trim() ? password.trim() : `Mechanic@${suffix}`;
  const isDefault = !(password && password.trim());
  const hashed = await bcrypt.hash(rawPassword, 12);

  let storedEmail = preferredEmail;
  let result;
  try {
    result = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role)
       VALUES (?, ?, ?, ?, ?, ?, 'mechanic')`,
      [workshopId, full_name, username, preferredEmail, phone || null, hashed]
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    // UNIQUE constraint on email — fall back to internal-only address
    storedEmail = `${username}@mechanic.local`;
    result = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role)
       VALUES (?, ?, ?, ?, ?, ?, 'mechanic')`,
      [workshopId, full_name, username, storedEmail, phone || null, hashed]
    );
  }
  return { userId: result.insertId, username, password: rawPassword, email: storedEmail, isDefault };
}

// POST /api/mechanics
router.post('/', async (req, res) => {
  try {
    // Validate body shape FIRST so a 400 (bad request) takes precedence over a
    // 403 (plan limit) — clients shouldn't be told to "upgrade" when their
    // payload is malformed.
    const {
      full_name, phone, email, service_bay_id, national_id, license_number, notes, joined_at, status
    } = req.body;
    if (!full_name || !phone) {
      return res.status(400).json({ success: false, message: 'Name and phone required' });
    }
    // B3 — strict E.164 phone validation
    const ph = validatePhone(phone);
    if (!ph.ok) return res.status(400).json({ success: false, message: ph.message });
    const normalizedPhone = ph.value;
    // Email format (if provided)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // D.2 — Check user limit before creating (mechanics count as users)
    if (req.subscription && !req.subscription.bypass) {
      const workshopId = req.workshopId || req.user?.workshop_id;
      const usage = await getUsageStats(workshopId);
      const maxUsers = req.subscription.limits?.max_users || 5;
      if (usage.active_users >= maxUsers) {
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          limit_type: 'max_users',
          current_usage: usage.active_users,
          limit: maxUsers,
          current_plan: req.subscription.plan,
          message: `User limit reached (${usage.active_users}/${maxUsers}). Mechanics count as users. Upgrade your plan to add more.`,
        });
      }
    }

    const safeStatus = VALID_MECHANIC_STATUSES.includes(status) ? status : 'offline';
    // B9 — duplicate phone check across ALL rows (not only active),
    // so soft-deleted mechanics don't allow phone reuse without an explicit restore.
    const [dupCheck] = await query(
      'SELECT id, is_active FROM mechanics WHERE workshop_id = ? AND phone = ? LIMIT 1', [req.workshopId, normalizedPhone]
    );
    if (dupCheck) {
      const msg = dupCheck.is_active
        ? 'A mechanic with this phone number already exists'
        : 'A previously deactivated mechanic has this phone number. Restore that record from the inactive list instead of creating a duplicate.';
      return res.status(409).json({ success: false, message: msg, existing_mechanic_id: dupCheck.id, is_active: !!dupCheck.is_active });
    }

    // 1. Auto-create a user account for the mechanic
    const { password } = req.body;
    let account = null;
    try {
      account = await createMechanicAccount(req.workshopId, { full_name, phone, email, password });
    } catch (accErr) {
      console.error('[Mechanic] Failed to create user account:', accErr.message);
    }

    // 2. Create the mechanic record with user_id link
    const result = await execute(
      `INSERT INTO mechanics (workshop_id, full_name, phone, email,
        service_bay_id, national_id, license_number, notes, joined_at, status, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, full_name, normalizedPhone, email || null,
       service_bay_id || null, national_id || null, license_number || null, notes || null, joined_at || null,
       safeStatus, account?.userId || null]
    );
    const [mechanic] = await query('SELECT * FROM mechanics WHERE id = ?', [result.insertId]);

    // Send welcome email with credentials
    if (account && email) {
      const loginUrl = `${config.frontendUrl}/login`;
      sendNotificationEmail({
        to: email,
        workshopId: req.workshopId,
        subject: 'Your Mechanic Account is Ready',
        title: 'Welcome to the Team! 🔧',
        body: `
          <p>Hi <strong>${full_name}</strong>,</p>
          <p>Your mechanic account has been created. Use the credentials below to access the Mechanic Portal:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr>
              <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px 0 0 0;font-weight:600;color:#374151;width:120px;">Username</td>
              <td style="padding:10px 14px;background:#fff;border:1px solid #e2e8f0;font-family:monospace;color:#1e293b;">${account.username}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 0 8px;font-weight:600;color:#374151;">Password</td>
              <td style="padding:10px 14px;background:#fff;border:1px solid #e2e8f0;font-family:monospace;color:#1e293b;">${account.password}</td>
            </tr>
          </table>
          <p style="color:#f97316;font-weight:600;">&#9888; Please change your password after your first login.</p>
        `,
        ctaText: 'Login to Mechanic Portal',
        ctaUrl: loginUrl,
      }).catch(err => console.error('[Mechanic] Welcome email error:', err.message));
    }

    return res.status(201).json({
      success: true, data: mechanic,
      account: account ? { username: account.username, password: account.password, email: account.email, isDefault: account.isDefault } : null,
      message: account
        ? `Mechanic created! Credentials are in the account field (also emailed if address provided).`
        : 'Mechanic created (no account — create manually in Settings)',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to create mechanic' });
  }
});

// PUT /api/mechanics/:id
router.put('/:id', async (req, res) => {
  try {
    const {
      full_name, phone, email, service_bay_id, status, national_id, license_number, notes, is_active
    } = req.body;
    // B3 — validate phone if provided
    let normalizedPhone = phone;
    if (phone) {
      const ph = validatePhone(phone);
      if (!ph.ok) return res.status(400).json({ success: false, message: ph.message });
      normalizedPhone = ph.value;
    }
    // B4 — whitelist status
    const safeStatus = VALID_MECHANIC_STATUSES.includes(status) ? status : 'offline';
    // S3 — strip raw HTML tags from free-text notes before persisting
    const safeNotes = sanitizeNotes(notes);
    await execute(
      `UPDATE mechanics SET full_name=?, phone=?, email=?,
       service_bay_id=?, status=?, national_id=?, license_number=?,
       notes=?, is_active=? WHERE id = ? AND workshop_id = ?`,
      [full_name, normalizedPhone, email || null, service_bay_id || null, safeStatus,
       national_id || null, license_number || null, safeNotes,
       is_active !== undefined ? is_active : true, req.params.id, req.workshopId]
    );
    const [mechanic] = await query('SELECT * FROM mechanics WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, data: mechanic });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update mechanic' });
  }
});

// PATCH /api/mechanics/bulk-status — set status on multiple mechanics in one call (F5)
// Body: { ids: [1,2,3], status: 'on_break', force: false }
router.patch('/bulk-status', async (req, res) => {
  try {
    const { ids, status, force } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, message: 'ids[] required' });
    if (ids.length > 200) {
      return res.status(400).json({ success: false, message: 'Max 200 ids per bulk-status request' });
    }
    const v = validateStatus(status);
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    const safeIds = ids.map(n => parseInt(n, 10)).filter(Boolean);
    if (!safeIds.length) return res.status(400).json({ success: false, message: 'ids[] required' });

    // Confirm workshop ownership
    const placeholders = safeIds.map(() => '?').join(',');
    const owned = await query(
      `SELECT id FROM mechanics WHERE id IN (${placeholders}) AND workshop_id = ?`,
      [...safeIds, req.workshopId]
    );
    const ownedIds = owned.map(r => r.id);
    if (!ownedIds.length) return res.status(404).json({ success: false, message: 'No matching mechanics' });

    // Optional safety: skip mechanics with active work orders unless force=true
    let blocked = [];
    if (status === 'offline' && !force) {
      const active = await query(
        `SELECT mechanic_id, COUNT(*) as cnt FROM work_orders
         WHERE mechanic_id IN (${ownedIds.map(() => '?').join(',')}) AND workshop_id = ?
           AND status IN ('assigned','accepted','in_progress')
         GROUP BY mechanic_id`,
        [...ownedIds, req.workshopId]
      );
      blocked = active.map(r => r.mechanic_id);
    }
    const toUpdate = ownedIds.filter(id => !blocked.includes(id));
    if (toUpdate.length) {
      const ph2 = toUpdate.map(() => '?').join(',');
      await execute(
        `UPDATE mechanics SET status = ? WHERE id IN (${ph2}) AND workshop_id = ?`,
        [status, ...toUpdate, req.workshopId]
      );
    }
    return res.json({
      success: true,
      updated: toUpdate.length,
      blocked,
      message: `${toUpdate.length} mechanic(s) updated${blocked.length ? `, ${blocked.length} skipped (active work orders)` : ''}`,
    });
  } catch (err) {
    console.error('[mechanics] bulk-status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to bulk update' });
  }
});

// PATCH /api/mechanics/:id/status
// B4 fix: whitelist status, prevent setting 'offline' while active work orders exist
// (unless ?force=1 is passed by an explicit admin override).
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, force } = req.body || {};
    const v = validateStatus(status);
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });

    // Verify mechanic belongs to this workshop
    const [mechanic] = await query(
      'SELECT id, status FROM mechanics WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    if (status === 'offline' && !force) {
      const [active] = await query(
        "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND status IN ('assigned','accepted','in_progress')",
        [mechanic.id, req.workshopId]
      );
      if (active && active.cnt > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot set offline — mechanic has ${active.cnt} active work order(s). Reassign first or pass { force: true } to override.`,
          active_work_orders: active.cnt,
        });
      }
    }

    await execute(
      'UPDATE mechanics SET status = ? WHERE id = ? AND workshop_id = ?',
      [status, mechanic.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Status updated', status });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// S2 fix: assert the :id in the URL belongs to the authenticated user + workshop
// to prevent forged-JWT GPS spoofing of other mechanics.
async function assertOwnMechanic(req, res, next) {
  try {
    const mechId = parseInt(req.params.id, 10);
    if (!mechId) return res.status(400).json({ success: false, message: 'Invalid mechanic id' });
    // Admin/manager roles may update any mechanic in their workshop; mechanics may only update their own row.
    const role = req.user?.role;
    const isAdminish = ['admin', 'super_admin', 'manager', 'dispatcher'].includes(role);
    let row;
    if (isAdminish) {
      [row] = await query('SELECT id FROM mechanics WHERE id = ? AND workshop_id = ?', [mechId, req.workshopId]);
    } else {
      [row] = await query('SELECT id FROM mechanics WHERE id = ? AND user_id = ? AND workshop_id = ?', [mechId, req.user.id, req.workshopId]);
    }
    if (!row) return res.status(403).json({ success: false, message: 'Forbidden — you cannot update this mechanic' });
    next();
  } catch (e) {
    console.error('[mechanics] assertOwnMechanic error:', e.message);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

// PATCH /api/mechanics/:id/location — mechanic GPS ping (e.g. mobile service van / on-site visit)
router.patch('/:id/location', assertOwnMechanic, async (req, res) => {
  try {
    const { lat, lng, speed, heading, work_order_id } = req.body;
    if (lat == null || lng == null) return res.status(400).json({ success: false, message: 'lat and lng required' });

    await execute(
      'INSERT INTO mechanic_locations (mechanic_id, work_order_id, lat, lng, speed, heading) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, work_order_id || null, lat, lng, speed ?? null, heading ?? null]
    );

    // Auto-detect service bay from GPS if mechanic has none assigned
    try {
      const [mech] = await query('SELECT service_bay_id FROM mechanics WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
      if (mech && !mech.service_bay_id) {
        const bayId = await detectZone(req.workshopId, parseFloat(lat), parseFloat(lng));
        if (bayId) {
          await execute('UPDATE mechanics SET service_bay_id = ? WHERE id = ?', [bayId, req.params.id]);
        }
      }
    } catch (_) { /* service bay detection not critical */ }

    // Emit real-time location update
    try {
      const io = getIO();
      const locationData = {
        mechanic_id: parseInt(req.params.id),
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        speed: speed ?? null,
        heading: heading ?? null,
        work_order_id: work_order_id || null,
        timestamp: new Date().toISOString(),
      };
      // Emit to workshop-specific room so only relevant admins see it
      io.to(`workshop:${req.workshopId}`).emit('mechanic:location', locationData);

      // Also emit to public service-status rooms for customers watching their work order
      const activeWorkOrders = await query(
        "SELECT service_status_token FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND status IN ('in_progress')",
        [req.params.id, req.workshopId]
      );
      for (const o of activeWorkOrders) {
        io.to(`track:${o.service_status_token}`).emit('mechanic:location', locationData);
      }
    } catch (_) { /* socket not critical */ }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update location' });
  }
});

// POST /api/mechanics/:id/location — alias so mobile apps can use POST
router.post('/:id/location', assertOwnMechanic, async (req, res) => {
  try {
    const { latitude, longitude, lat, lng, accuracy, speed, heading, work_order_id } = req.body;
    const dLat = lat ?? latitude;
    const dLng = lng ?? longitude;
    if (dLat == null || dLng == null) return res.status(400).json({ success: false, message: 'lat/latitude and lng/longitude required' });

    await execute(
      'INSERT INTO mechanic_locations (mechanic_id, work_order_id, lat, lng, speed, heading) VALUES (?, ?, ?, ?, ?, ?)',
      [req.params.id, work_order_id || null, dLat, dLng, speed ?? null, heading ?? null]
    );

    try {
      const io = getIO();
      const locationData = {
        mechanic_id: parseInt(req.params.id),
        lat: parseFloat(dLat), lng: parseFloat(dLng),
        speed: speed ?? null, heading: heading ?? null,
        work_order_id: work_order_id || null, timestamp: new Date().toISOString(),
      };
      // Emit to admin dashboard
      io.to(`workshop:${req.workshopId}`).emit('mechanic:location', locationData);

      // Also emit to public service-status rooms for customers watching their work order
      const activeWorkOrders = await query(
        "SELECT service_status_token FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND status IN ('in_progress')",
        [req.params.id, req.workshopId]
      );
      for (const o of activeWorkOrders) {
        io.to(`track:${o.service_status_token}`).emit('mechanic:location', locationData);
      }
    } catch (_) { /* socket not critical */ }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update location' });
  }
});

// GET /api/mechanics/:id/location — latest location
router.get('/:id/location', async (req, res) => {
  try {
    const [loc] = await query(
      'SELECT * FROM mechanic_locations WHERE mechanic_id = ? ORDER BY recorded_at DESC LIMIT 1',
      [req.params.id]
    );
    return res.json({ success: true, data: loc || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to get location' });
  }
});

// GET /api/mechanics/:id/location-history — GPS trail for a time range (for path replay)
// B7 fix: enforce workshop scoping so cross-workshop guess of mechanic_id can't leak GPS history.
// B11 fix: cap limit at 500 (was 2000) and support cursor-based pagination via ?cursor= (id).
router.get('/:id/location-history', async (req, res) => {
  try {
    // Workshop scope check: mechanic must belong to req.workshopId
    const [workshopMechanic] = await query(
      'SELECT id FROM mechanics WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!workshopMechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    const { from, to, cursor } = req.query;
    const lim = Math.min(Math.max(parseInt(req.query.limit) || 500, 1), 500);

    let where = 'WHERE mechanic_id = ?';
    const params = [req.params.id];

    if (from)   { where += ' AND recorded_at >= ?'; params.push(from); }
    if (to)     { where += ' AND recorded_at <= ?'; params.push(to); }
    if (cursor) { where += ' AND id > ?';           params.push(parseInt(cursor) || 0); }

    const trail = await query(
      `SELECT id, mechanic_id, work_order_id, lat, lng, speed, heading, recorded_at
       FROM mechanic_locations ${where}
       ORDER BY recorded_at ASC
       LIMIT ${lim}`,
      params
    );
    const nextCursor = trail.length === lim ? trail[trail.length - 1].id : null;
    return res.json({ success: true, data: trail, count: trail.length, next_cursor: nextCursor });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch location history' });
  }
});

// PATCH /api/mechanics/:id/toggle-active — flip is_active boolean
router.patch('/:id/toggle-active', async (req, res) => {
  try {
    const [mechanic] = await query(
      'SELECT id, is_active, full_name FROM mechanics WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    const newState = mechanic.is_active ? 0 : 1;
    await execute(
      'UPDATE mechanics SET is_active = ? WHERE id = ? AND workshop_id = ?',
      [newState, req.params.id, req.workshopId]
    );
    return res.json({
      success: true,
      message: `Mechanic ${mechanic.full_name} ${newState ? 'activated' : 'deactivated'}`,
      is_active: Boolean(newState),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to toggle mechanic status' });
  }
});

// POST /api/mechanics/sync-accounts — create user accounts for all mechanics that don't have one
router.post('/sync-accounts', async (req, res) => {
  try {
    const mechanicsWithoutAccount = await query(
      'SELECT id, full_name, phone, email FROM mechanics WHERE workshop_id = ? AND user_id IS NULL AND is_active = TRUE',
      [req.workshopId]
    );
    if (!mechanicsWithoutAccount.length) {
      return res.json({ success: true, message: 'All mechanics already have accounts', created: 0, accounts: [] });
    }

    const created = [];
    for (const m of mechanicsWithoutAccount) {
      try {
        const account = await createMechanicAccount(req.workshopId, m);
        await execute('UPDATE mechanics SET user_id = ? WHERE id = ?', [account.userId, m.id]);
        created.push({ mechanic_id: m.id, mechanic_name: m.full_name, username: account.username, password: account.password, email: account.email });
      } catch (e) {
        console.error(`Failed to create account for mechanic ${m.id}:`, e.message);
      }
    }

    return res.json({
      success: true,
      message: `Created ${created.length} account(s)`,
      created: created.length,
      accounts: created,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to sync accounts' });
  }
});

// DELETE /api/mechanics/:id
router.delete('/:id', async (req, res) => {
  try {
    // Also deactivate the linked user account
    const [mechanic] = await query('SELECT user_id FROM mechanics WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (mechanic?.user_id) {
      await execute('UPDATE users SET is_active = FALSE WHERE id = ?', [mechanic.user_id]);
    }
    await execute(
      'UPDATE mechanics SET is_active = FALSE WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Mechanic deactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to deactivate mechanic' });
  }
});

// GET /api/mechanics/:id/ratings — get all ratings for a mechanic with work order details
router.get('/:id/ratings', async (req, res) => {
  try {
    const [mechanic] = await query(
      'SELECT id, full_name, rating FROM mechanics WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    const ratings = await query(
      `SELECT o.id as work_order_id, o.work_order_number, o.mechanic_rating as rating,
              o.review_comment as comment, o.mechanic_rated_at as rated_at,
              o.customer_name, o.completed_at
       FROM work_orders o
       WHERE o.mechanic_id = ? AND o.mechanic_rating IS NOT NULL AND o.workshop_id = ?
       ORDER BY o.mechanic_rated_at DESC`,
      [req.params.id, req.workshopId]
    );

    // Star distribution
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const r of ratings) {
      distribution[r.rating] = (distribution[r.rating] || 0) + 1;
    }

    return res.json({
      success: true,
      mechanic: { id: mechanic.id, full_name: mechanic.full_name, rating: parseFloat(mechanic.rating) || 0 },
      total_ratings: ratings.length,
      distribution,
      ratings,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch ratings' });
  }
});

export default router;
