/**
 * ═══════════════════════════════════════════════════════════════════
 *  Job Assignment Routes — assigning work orders to mechanics/service bays
 * ═══════════════════════════════════════════════════════════════════
 *
 * Ported/rebranded from the delivery-service `dispatch.js`. Renames applied:
 *   orders -> work_orders, order_assignments -> work_order_assignments,
 *   order_status_logs -> work_order_status_logs, drivers -> mechanics,
 *   driver_locations -> mechanic_locations, zones -> service_bays,
 *   clients -> customers, packages -> parts.
 *
 * JUDGMENT CALLS:
 *  - `getDistanceMatrix`/`getRoute` (OSRM multi-waypoint route/matrix helpers)
 *    were intentionally DROPPED along with the rest of the delivery
 *    multi-stop routing machinery — see
 *    routes/_DROPPED_multi-stop_and_routing.md. The only routing helper kept
 *    is `getRoadDistance(fromLat, fromLng, toLat, toLng)`, a single-pair
 *    distance/ETA lookup. The batch auto-assign endpoint below therefore
 *    falls back to haversine-distance scoring for every mechanic/work-order
 *    pair instead of a precomputed OSRM distance matrix (that matrix call is
 *    dropped; a comment marks where it used to be). The single auto-assign
 *    endpoint still calls `getRoadDistance` per-candidate since that helper
 *    is preserved.
 *  - Package cascade-status-update logic (marking packages 'assigned' when
 *    an order is assigned) is replaced by nothing — parts.js has no
 *    "assigned" status in its lifecycle (ordered/in_stock/installed/
 *    returned), so there is no equivalent cascade to perform here.
 *  - Vehicle-capacity-based mechanic filtering (allowedVehicleTypes, based
 *    on parcel weight_kg) doesn't map onto a workshop domain (mechanics
 *    don't have delivery-vehicle capacity limits), so it is dropped. In its
 *    place, mechanics can optionally be filtered by `specialty` matching the
 *    work order's `service_category`, which is the closest workshop analog
 *    of "vehicle capacity" gating (best-effort — not enforced as a hard
 *    block unless configured, mirroring the source's default-permissive
 *    behavior).
 *  - Route storage (route_distance_km/route_duration_min/route_polyline on
 *    the order) is dropped — no in-schema equivalent on work_orders, and it
 *    depended on the dropped `getRoute` (multi-waypoint polyline) helper.
 *    `calculated_distance_km` on work_orders is populated instead where a
 *    same single-pair getRoadDistance() call is available (dropoff distance
 *    for mobile-mechanic / vehicle-pickup jobs).
 * ═══════════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyMechanicAssigned } from '../lib/notify.js';
import { createInvoiceFromWorkOrder } from './invoices.js';
import { getRoadDistance } from '../lib/routing.js';

const router = express.Router();
router.use(authMiddleware);

// GET /api/job-assignment — unassigned work orders + available mechanics
router.get('/', async (req, res) => {
  try {
    const unassigned = await query(
      `SELECT wo.*, wo.dropoff_lat, wo.dropoff_lng,
              c.full_name as customer_name_ref, b.name as service_bay_name
       FROM work_orders wo
       LEFT JOIN customers c ON wo.customer_id = c.id
       LEFT JOIN service_bays b ON wo.service_bay_id = b.id
       WHERE wo.workshop_id = ? AND wo.status IN ('pending','confirmed') AND wo.mechanic_id IS NULL
       ORDER BY wo.scheduled_at ASC, wo.created_at ASC
       LIMIT 500`,
      [req.workshopId]
    );
    const mechanics = await query(
      `SELECT m.*, b.name as service_bay_name,
              ml.lat as last_lat, ml.lng as last_lng,
              (SELECT COUNT(*) FROM work_orders WHERE mechanic_id = m.id AND status IN ('assigned','accepted','in_progress')) as active_work_orders
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       LEFT JOIN (
         SELECT mechanic_id, lat, lng FROM mechanic_locations
         WHERE id IN (SELECT MAX(id) FROM mechanic_locations GROUP BY mechanic_id)
       ) ml ON ml.mechanic_id = m.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE AND m.status = 'available'
       ORDER BY m.full_name`,
      [req.workshopId]
    );
    // All active mechanics (any status) — used for the assignment dropdown
    const allMechanics = await query(
      `SELECT m.id, m.full_name, m.phone, m.specialty, m.status,
              b.name as service_bay_name,
              (SELECT COUNT(*) FROM work_orders WHERE mechanic_id = m.id AND status IN ('assigned','accepted','in_progress')) as active_work_orders
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE
       ORDER BY FIELD(m.status, 'available', 'busy', 'on_break', 'offline'), m.full_name`,
      [req.workshopId]
    );
    const active = await query(
      `SELECT wo.*, wo.dropoff_lat, wo.dropoff_lng,
              m.full_name as mechanic_name, m.phone as mechanic_phone,
              b.name as service_bay_name, c.full_name as customer_name_ref
       FROM work_orders wo
       JOIN mechanics m ON wo.mechanic_id = m.id
       LEFT JOIN service_bays b ON wo.service_bay_id = b.id
       LEFT JOIN customers c ON wo.customer_id = c.id
       WHERE wo.workshop_id = ? AND wo.status IN ('assigned','accepted','in_progress')
       ORDER BY wo.updated_at DESC
       LIMIT 500`,
      [req.workshopId]
    );
    // ── Completed / failed work orders updated today ──
    const completed = await query(
      `SELECT wo.id, wo.work_order_number, wo.status, wo.customer_name, wo.dropoff_address,
              wo.payment_method, wo.cash_amount,
              wo.updated_at, wo.created_at,
              m.full_name as mechanic_name,
              b.name as service_bay_name, c.full_name as customer_name_ref
       FROM work_orders wo
       LEFT JOIN mechanics m ON wo.mechanic_id = m.id
       LEFT JOIN service_bays b ON wo.service_bay_id = b.id
       LEFT JOIN customers c ON wo.customer_id = c.id
       WHERE wo.workshop_id = ? AND wo.status IN ('completed','failed','cancelled')
         AND DATE(wo.updated_at) = CURDATE()
       ORDER BY wo.updated_at DESC
       LIMIT 100`,
      [req.workshopId]
    );
    // ── Fetch parts for all work orders (unassigned + active) ──
    const allWorkOrderIds = [...unassigned, ...active].map(o => o.id);
    let partsByWorkOrder = {};
    if (allWorkOrderIds.length > 0) {
      const parts = await query(
        `SELECT id, work_order_id, part_number, name, status, quantity, unit_cost, total_cost
         FROM parts
         WHERE work_order_id IN (?) AND workshop_id = ?
         ORDER BY work_order_id, created_at ASC`,
        [allWorkOrderIds, req.workshopId]
      );
      parts.forEach(p => {
        if (!partsByWorkOrder[p.work_order_id]) partsByWorkOrder[p.work_order_id] = [];
        partsByWorkOrder[p.work_order_id].push(p);
      });
    }
    // Attach parts to each work order
    const attachData = (workOrders) => workOrders.map(o => ({
      ...o,
      parts: partsByWorkOrder[o.id] || [],
    }));

    return res.json({ success: true, data: {
      unassigned: attachData(unassigned),
      available_mechanics: mechanics,
      all_mechanics: allMechanics,
      active_work_orders: attachData(active),
      completed_today: completed,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to load job assignment board' });
  }
});

// POST /api/job-assignment/assign — assign mechanic to a work order
router.post('/assign', async (req, res) => {
  try {
    const { work_order_id, mechanic_id } = req.body;
    if (!work_order_id || !mechanic_id) {
      return res.status(400).json({ success: false, message: 'work_order_id and mechanic_id required' });
    }

    const [workOrder] = await query('SELECT * FROM work_orders WHERE id = ? AND workshop_id = ?', [work_order_id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    const [mechanic] = await query('SELECT * FROM mechanics WHERE id = ? AND workshop_id = ?', [mechanic_id, req.workshopId]);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });

    // Deactivate previous assignments
    await execute('UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ?', [work_order_id]);

    // New assignment
    await execute(
      'INSERT INTO work_order_assignments (work_order_id, mechanic_id, assigned_by, assigned_at, is_current) VALUES (?, ?, ?, NOW(), TRUE)',
      [work_order_id, mechanic_id, req.user.id]
    );

    // Update work order
    await execute(
      "UPDATE work_orders SET mechanic_id = ?, status = 'assigned' WHERE id = ? AND workshop_id = ?",
      [mechanic_id, work_order_id, req.workshopId]
    );

    // Log status change
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [work_order_id, 'assigned', req.user.id, `Assigned to mechanic: ${mechanic.full_name}`]
    );

    // Update mechanic status
    await execute("UPDATE mechanics SET status = 'busy' WHERE id = ?", [mechanic_id]);

    // AUTO-GENERATE INVOICE if work order was pending/confirmed and doesn't have one yet
    if (['pending', 'confirmed'].includes(workOrder.status)) {
      try {
        const invoice = await createInvoiceFromWorkOrder(work_order_id, req.workshopId, req.user?.id);
        if (invoice) {
          console.log(`Invoice ${invoice.invoice_number} auto-created via job-assignment for work order ${workOrder.work_order_number}`);
        }
      } catch (invoiceErr) {
        console.error('Failed to auto-create invoice on job-assignment:', invoiceErr.message);
      }
    }

    // ── Notify: mechanic assigned (SMS + Email + Push to mechanic & customer) ──
    notifyMechanicAssigned({
      order: workOrder, driver: mechanic, tenantId: req.workshopId,
    }).catch(e => console.error('[Notify] Assign error:', e.message));

    return res.json({ success: true, message: `Work order assigned to ${mechanic.full_name}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to assign work order' });
  }
});

// POST /api/job-assignment/unassign
router.post('/unassign', async (req, res) => {
  try {
    const { work_order_id, reason } = req.body;
    const [workOrder] = await query('SELECT * FROM work_orders WHERE id = ? AND workshop_id = ?', [work_order_id, req.workshopId]);
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    await execute('UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ?', [work_order_id]);
    await execute(
      "UPDATE work_orders SET mechanic_id = NULL, status = 'confirmed' WHERE id = ? AND workshop_id = ?",
      [work_order_id, req.workshopId]
    );
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [work_order_id, 'confirmed', req.user.id, reason || 'Mechanic unassigned']
    );

    if (workOrder.mechanic_id) {
      const stillHasWorkOrders = await query(
        "SELECT id FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_progress') LIMIT 1",
        [workOrder.mechanic_id]
      );
      if (!stillHasWorkOrders.length) {
        await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [workOrder.mechanic_id]);
      }
    }
    return res.json({ success: true, message: 'Work order unassigned' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to unassign work order' });
  }
});

/* ─────────────────────────────────────────────────────────────────
   Haversine distance (km) between two lat/lng points
───────────────────────────────────────────────────────────────── */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ─────────────────────────────────────────────────────────────────
   Per-workshop auto-assign configuration
   Reads from `settings` (key-value); all values optional.
     max_work_orders_per_mechanic  INT   default 5
     min_mechanic_rating           FLOAT default 0   (0 = disabled)
     max_assign_distance_km        FLOAT default 0   (0 = unlimited)
     enforce_specialty_match       BOOL  default false
───────────────────────────────────────────────────────────────── */
async function loadAssignmentConfig(workshopId) {
  const rows = await query(
    "SELECT `key`, `value` FROM settings WHERE workshop_id = ? AND `key` IN " +
      "('max_work_orders_per_mechanic','min_mechanic_rating','max_assign_distance_km','enforce_specialty_match')",
    [workshopId]
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const num = (v, def) => {
    const n = parseFloat(v);
    return isNaN(n) ? def : n;
  };
  const bool = (v, def) => {
    if (v == null) return def;
    const s = String(v).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  };
  return {
    maxWorkOrdersPerMechanic: Math.max(1, parseInt(num(map.max_work_orders_per_mechanic, 5), 10)),
    minRating: Math.max(0, num(map.min_mechanic_rating, 0)),
    maxDistanceKm: Math.max(0, num(map.max_assign_distance_km, 0)),
    enforceSpecialtyMatch: bool(map.enforce_specialty_match, false),
  };
}

/* Map a work order's service_category to the mechanic specialty best suited
   for it. JUDGMENT CALL — replaces the source's weight-based
   allowedVehicleTypes() gate (which doesn't apply here) with a
   specialty-match gate that's the closest workshop analog. Only enforced
   when enforce_specialty_match setting is on (default: off, permissive —
   mirrors the source's default-permissive vehicle capacity behavior being
   optional too). */
const SERVICE_CATEGORY_TO_SPECIALTY = {
  oil_change: 'general',
  brake_repair: 'general',
  diagnostic: 'diagnostics',
  bodywork: 'bodywork',
  tire_service: 'tires',
  engine_repair: 'engine',
  transmission: 'transmission',
  electrical: 'electrical',
  general_maintenance: 'general',
  other: 'general',
};
function allowedSpecialties(workOrder) {
  const specialty = SERVICE_CATEGORY_TO_SPECIALTY[workOrder.service_category] || 'general';
  return specialty === 'general' ? null : [specialty, 'general'];
}

// POST /api/job-assignment/auto-assign
// Assigns the nearest available mechanic to a single work order
router.post('/auto-assign', async (req, res) => {
  try {
    const { work_order_id } = req.body;
    if (!work_order_id) return res.status(400).json({ success: false, message: 'work_order_id required' });

    const [workOrder] = await query(
      "SELECT * FROM work_orders WHERE id = ? AND workshop_id = ? AND status IN ('pending','confirmed') AND mechanic_id IS NULL",
      [work_order_id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found or already assigned' });

    const cfg = await loadAssignmentConfig(req.workshopId);
    const requiredSpecialties = cfg.enforceSpecialtyMatch ? allowedSpecialties(workOrder) : null;

    // Get available mechanics with their last known GPS location (relevant
    // for mobile-mechanic / vehicle-pickup jobs; in-shop jobs ignore distance)
    const mechanics = await query(
      `SELECT m.id, m.full_name, m.service_bay_id, m.rating, m.specialty,
              ml.lat as last_lat, ml.lng as last_lng,
              (SELECT COUNT(*) FROM work_orders WHERE mechanic_id = m.id AND status IN ('assigned','accepted','in_progress')) as active_work_orders
       FROM mechanics m
       LEFT JOIN (
         SELECT mechanic_id, lat, lng FROM mechanic_locations
         WHERE id IN (SELECT MAX(id) FROM mechanic_locations GROUP BY mechanic_id)
       ) ml ON ml.mechanic_id = m.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE AND m.status = 'available'`,
      [req.workshopId]
    );

    if (!mechanics.length) {
      return res.status(409).json({ success: false, message: 'No available mechanics at this time' });
    }

    // Apply hard filters: specialty match, min rating, max active-work-orders cap
    const rejected = { specialty: 0, rating: 0, capped: 0 };
    const eligibleMechanics = mechanics.filter(m => {
      if (requiredSpecialties && !requiredSpecialties.includes(m.specialty)) { rejected.specialty++; return false; }
      if (cfg.minRating > 0 && parseFloat(m.rating || 0) < cfg.minRating) { rejected.rating++; return false; }
      if (m.active_work_orders >= cfg.maxWorkOrdersPerMechanic) { rejected.capped++; return false; }
      return true;
    });
    if (!eligibleMechanics.length) {
      return res.status(409).json({
        success: false,
        message: 'No eligible mechanics (filtered by specialty / rating / load cap)',
        data: { rejected, total_available: mechanics.length },
      });
    }

    // Use dropoff coords for distance (mobile mechanic / vehicle-pickup jobs only)
    const dropoffLat = parseFloat(workOrder.dropoff_lat);
    const dropoffLng = parseFloat(workOrder.dropoff_lng);
    const hasCoords = !isNaN(dropoffLat) && !isNaN(dropoffLng);

    // Score each mechanic using road distance from getRoadDistance (single-pair
    // helper — the OSRM distance-matrix batch call from the source is dropped,
    // see file header comment) when we have both mechanic GPS and dropoff coords.
    let scored;
    if (hasCoords) {
      scored = await Promise.all(eligibleMechanics.map(async (m) => {
        let distKm = 999, etaMin = null;
        if (m.last_lat && m.last_lng) {
          try {
            const rd = await getRoadDistance(parseFloat(m.last_lat), parseFloat(m.last_lng), dropoffLat, dropoffLng);
            distKm = rd.distance_km;
            etaMin = rd.duration_min;
          } catch {
            distKm = haversineKm(parseFloat(m.last_lat), parseFloat(m.last_lng), dropoffLat, dropoffLng);
          }
        } else if (workOrder.service_bay_id && m.service_bay_id === workOrder.service_bay_id) {
          distKm = 0;
        }
        return { ...m, distKm, etaMin, score: m.active_work_orders * 10 + distKm };
      }));
    } else {
      // No dropoff coords — in-shop job, score by service bay match + load only
      scored = eligibleMechanics.map(m => {
        const distKm = (workOrder.service_bay_id && m.service_bay_id === workOrder.service_bay_id) ? 0 : 999;
        return { ...m, distKm, etaMin: null, score: m.active_work_orders * 10 + distKm };
      });
    }

    // Apply max-distance filter (only when we actually have a real distance)
    if (cfg.maxDistanceKm > 0) {
      const within = scored.filter(s => s.distKm <= cfg.maxDistanceKm);
      if (!within.length) {
        return res.status(409).json({
          success: false,
          message: `No mechanics within ${cfg.maxDistanceKm} km of drop-off`,
          data: { closest_km: scored.length ? Math.min(...scored.map(s => s.distKm)).toFixed(2) : null },
        });
      }
      scored = within;
    }

    scored.sort((a, b) => a.score - b.score);
    const best = scored[0];

    // Assign
    await execute('UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ?', [work_order_id]);
    await execute(
      'INSERT INTO work_order_assignments (work_order_id, mechanic_id, assigned_by, assigned_at, is_current) VALUES (?, ?, ?, NOW(), TRUE)',
      [work_order_id, best.id, req.user.id]
    );
    await execute(
      "UPDATE work_orders SET mechanic_id = ?, status = 'assigned' WHERE id = ? AND workshop_id = ?",
      [best.id, work_order_id, req.workshopId]
    );

    // Store calculated distance for mobile-mechanic / vehicle-pickup travel-fee calc
    if (best.distKm != null && best.distKm < 999) {
      await execute('UPDATE work_orders SET calculated_distance_km = ? WHERE id = ?', [best.distKm, work_order_id]).catch(() => {});
    }
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [work_order_id, 'assigned', req.user.id, `Auto-assigned to ${best.full_name} (${best.distKm < 999 ? best.distKm.toFixed(1) + ' km' + (best.etaMin ? ' / ' + best.etaMin.toFixed(0) + ' min' : '') + ' away' : 'same service bay'})`]
    );
    await execute("UPDATE mechanics SET status = 'busy' WHERE id = ?", [best.id]);

    // Notify mechanic (email + push + in-app + SMS to customer)
    notifyMechanicAssigned({
      order: workOrder, driver: best, tenantId: req.workshopId,
    }).catch(e => console.error('[Notify] Auto-assign error:', e.message));

    return res.json({
      success: true,
      message: `Auto-assigned to ${best.full_name}`,
      data: { mechanic_id: best.id, mechanic_name: best.full_name, distance_km: best.distKm < 999 ? best.distKm.toFixed(2) : null, eta_min: best.etaMin || null }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Auto-assign failed' });
  }
});

// POST /api/job-assignment/auto-assign-all
// Auto-assigns all unassigned pending/confirmed work orders to nearest available mechanics
router.post('/auto-assign-all', async (req, res) => {
  try {
    const cfg = await loadAssignmentConfig(req.workshopId);
    const maxWorkOrdersPerMechanic = cfg.maxWorkOrdersPerMechanic;

    const unassigned = await query(
      "SELECT * FROM work_orders WHERE workshop_id = ? AND status IN ('pending','confirmed') AND mechanic_id IS NULL ORDER BY created_at ASC",
      [req.workshopId]
    );
    if (!unassigned.length) return res.json({ success: true, message: 'No unassigned work orders', assigned: 0 });

    const mechanics = await query(
      `SELECT m.id, m.full_name, m.service_bay_id, m.rating, m.specialty,
              ml.lat as last_lat, ml.lng as last_lng,
              (SELECT COUNT(*) FROM work_orders WHERE mechanic_id = m.id AND status IN ('assigned','accepted','in_progress')) as active_work_orders
       FROM mechanics m
       LEFT JOIN (
         SELECT mechanic_id, lat, lng FROM mechanic_locations
         WHERE id IN (SELECT MAX(id) FROM mechanic_locations GROUP BY mechanic_id)
       ) ml ON ml.mechanic_id = m.id
       WHERE m.workshop_id = ? AND m.is_active = TRUE AND m.status = 'available'`,
      [req.workshopId]
    );
    if (!mechanics.length) return res.status(409).json({ success: false, message: 'No available mechanics' });

    // Pre-filter by min rating (specialty match is per-work-order, applied below)
    const ratingOk = cfg.minRating > 0
      ? mechanics.filter(m => parseFloat(m.rating || 0) >= cfg.minRating)
      : mechanics;
    if (!ratingOk.length) {
      return res.status(409).json({ success: false, message: `No mechanics meet min rating ${cfg.minRating}` });
    }

    // NOTE: the source used a precomputed OSRM distance-matrix (all drivers x
    // all order coords) here for batch scoring efficiency. That helper
    // (getDistanceMatrix) was dropped along with the multi-stop routing
    // module (see file header + routes/_DROPPED_multi-stop_and_routing.md).
    // We fall back to per-pair haversine distance for batch scoring, which is
    // less accurate for road distance but requires no extra API/service.
    const driverLoad = {};
    ratingOk.forEach(m => { driverLoad[m.id] = parseInt(m.active_work_orders, 10) || 0; });

    let assigned = 0;
    const skipped = [];
    const results = [];

    for (const workOrder of unassigned) {
      const requiredSpecialties = cfg.enforceSpecialtyMatch ? allowedSpecialties(workOrder) : null;

      const available = ratingOk.filter(m => {
        if (driverLoad[m.id] >= maxWorkOrdersPerMechanic) return false;
        if (requiredSpecialties && !requiredSpecialties.includes(m.specialty)) return false;
        return true;
      });
      if (!available.length) {
        skipped.push({ work_order_id: workOrder.id, work_order_number: workOrder.work_order_number, reason: 'no_eligible_mechanic' });
        continue;
      }

      const dropoffLat = parseFloat(workOrder.dropoff_lat);
      const dropoffLng = parseFloat(workOrder.dropoff_lng);
      const hasCoords = !isNaN(dropoffLat) && !isNaN(dropoffLng);

      let scored = available.map(m => {
        let distKm = 999;
        if (hasCoords && m.last_lat && m.last_lng) {
          distKm = haversineKm(parseFloat(m.last_lat), parseFloat(m.last_lng), dropoffLat, dropoffLng);
        } else if (workOrder.service_bay_id && m.service_bay_id === workOrder.service_bay_id) {
          distKm = 0;
        }
        return { ...m, distKm, score: driverLoad[m.id] * 10 + distKm };
      });

      // Apply max-distance filter
      if (cfg.maxDistanceKm > 0) {
        const within = scored.filter(s => s.distKm <= cfg.maxDistanceKm);
        if (!within.length) {
          skipped.push({ work_order_id: workOrder.id, work_order_number: workOrder.work_order_number, reason: 'out_of_range' });
          continue;
        }
        scored = within;
      }

      scored.sort((a, b) => a.score - b.score);
      const best = scored[0];

      await execute('UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ?', [workOrder.id]);
      await execute(
        'INSERT INTO work_order_assignments (work_order_id, mechanic_id, assigned_by, assigned_at, is_current) VALUES (?, ?, ?, NOW(), TRUE)',
        [workOrder.id, best.id, req.user.id]
      );
      await execute(
        "UPDATE work_orders SET mechanic_id = ?, status = 'assigned' WHERE id = ?",
        [best.id, workOrder.id]
      );

      if (best.distKm != null && best.distKm < 999) {
        await execute('UPDATE work_orders SET calculated_distance_km = ? WHERE id = ?', [best.distKm, workOrder.id]).catch(() => {});
      }
      await execute(
        'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
        [workOrder.id, 'assigned', req.user.id, `Batch auto-assigned to ${best.full_name}`]
      );

      driverLoad[best.id]++;
      assigned++;
      results.push({
        work_order_id: workOrder.id,
        work_order_number: workOrder.work_order_number,
        mechanic: best.full_name,
        distance_km: best.distKm < 999 ? Number(best.distKm.toFixed(2)) : null,
      });

      // Notify each mechanic per assignment
      notifyMechanicAssigned({
        order: workOrder, driver: best, tenantId: req.workshopId,
      }).catch(() => {});
    }

    // Mark mechanics busy if they ended the batch carrying any active work
    for (const [mechanicId, load] of Object.entries(driverLoad)) {
      if (load > 0) await execute("UPDATE mechanics SET status = 'busy' WHERE id = ?", [mechanicId]);
    }

    return res.json({
      success: true,
      message: `Auto-assigned ${assigned} work orders` + (skipped.length ? `, ${skipped.length} skipped` : ''),
      assigned,
      skipped_count: skipped.length,
      results,
      skipped,
      config: cfg,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Batch auto-assign failed' });
  }
});

export default router;
