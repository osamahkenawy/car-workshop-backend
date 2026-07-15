/**
 * ═══════════════════════════════════════════════════════════════════
 *  Service Pricing Routes — service_pricing_rules CRUD
 * ═══════════════════════════════════════════════════════════════════
 *
 * Ported/rebranded from the delivery-service `pricing.js`. Renames applied:
 *   pricing_rules -> service_pricing_rules, zones -> service_bays,
 *   zone_id -> service_bay_id, client_type -> customer_type,
 *   cod_fee_pct -> cash_fee_pct, orders -> work_orders,
 *   delivery_fee -> service_fee.
 *
 * JUDGMENT CALLS:
 *  - price_per_km/price_per_kg (delivery distance/weight pricing) DROPPED
 *    per car_workshop.sql — replaced with travel_fee_per_km, kept only for
 *    mobile-mechanic / vehicle-pickup callouts (a real workshop concept),
 *    computed via getRoadDistance() instead of price-per-kg weight pricing
 *    (weight doesn't apply to a car repair service).
 *  - The distance calculator endpoint keeps using getRoadDistance (the only
 *    routing helper retained — see routes/_DROPPED_multi-stop_and_routing.md).
 *  - surge_rules CRUD kept as-is per car_workshop.sql (day_of_week/
 *    start_hour/end_hour/multiplier/service_bay_id), same structure as the
 *    source's zone_id-scoped surge rules, just renamed to service_bay_id.
 * ═══════════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { getRoadDistance } from '../lib/routing.js';

const router = express.Router();
router.use(authMiddleware);

// Valid customer types (expanded to match all B2B/B2C use cases)
const VALID_CUSTOMER_TYPES = ['all', 'individual', 'business', 'vip', 'fleet', 'corporate'];

// ═══════════════════════════════════════════════════════════════
// SURGE PRICING CRUD  (MUST be before /:id to avoid param capture)
// ═══════════════════════════════════════════════════════════════

// GET /api/service-pricing/surge — list surge rules
router.get('/surge', async (req, res) => {
  try {
    const rules = await query(
      `SELECT s.*, b.name as service_bay_name FROM surge_rules s
       LEFT JOIN service_bays b ON s.service_bay_id = b.id
       WHERE s.workshop_id = ? ORDER BY s.day_of_week, s.start_hour`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rules });
  } catch (err) {
    console.error('Surge GET error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch surge rules' });
  }
});

// POST /api/service-pricing/surge — create surge rule
router.post('/surge', async (req, res) => {
  try {
    const { name, day_of_week, start_hour = 0, end_hour = 23, multiplier = 1.5, service_bay_id } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    const mult = parseFloat(multiplier) || 1.5;
    if (mult < 1 || mult > 5) return res.status(400).json({ success: false, message: 'Multiplier must be between 1.0 and 5.0' });
    const sHour = Math.max(0, Math.min(23, parseInt(start_hour) || 0));
    const eHour = Math.max(0, Math.min(23, parseInt(end_hour) || 23));
    if (sHour > eHour) return res.status(400).json({ success: false, message: 'Start hour must be ≤ end hour' });

    const result = await execute(
      `INSERT INTO surge_rules (workshop_id, name, day_of_week, start_hour, end_hour, multiplier, service_bay_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, name, day_of_week ?? null, sHour, eHour, mult, service_bay_id || null]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'surge_rule.create', entityType: 'surge_rule', entityId: result.insertId, newValue: req.body });
    const [rule] = await query('SELECT * FROM surge_rules WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rule });
  } catch (err) {
    console.error('Surge POST error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create surge rule' });
  }
});

// PUT /api/service-pricing/surge/:id — update surge rule
router.put('/surge/:id', async (req, res) => {
  try {
    const { name, day_of_week, start_hour, end_hour, multiplier, service_bay_id, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    const mult = parseFloat(multiplier) || 1.5;
    if (mult < 1 || mult > 5) return res.status(400).json({ success: false, message: 'Multiplier must be between 1.0 and 5.0' });
    const sHour = Math.max(0, Math.min(23, parseInt(start_hour) || 0));
    const eHour = Math.max(0, Math.min(23, parseInt(end_hour) || 23));

    const [existing] = await query('SELECT * FROM surge_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Surge rule not found' });

    await execute(
      `UPDATE surge_rules SET name=?, day_of_week=?, start_hour=?, end_hour=?, multiplier=?, service_bay_id=?, is_active=?
       WHERE id = ? AND workshop_id = ?`,
      [name, day_of_week ?? null, sHour, eHour, mult,
       service_bay_id || null, is_active !== undefined ? is_active : 1, req.params.id, req.workshopId]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'surge_rule.update', entityType: 'surge_rule', entityId: parseInt(req.params.id), oldValue: existing, newValue: req.body });
    const [rule] = await query('SELECT * FROM surge_rules WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: rule });
  } catch (err) {
    console.error('Surge PUT error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update surge rule' });
  }
});

// DELETE /api/service-pricing/surge/:id
router.delete('/surge/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM surge_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Surge rule not found' });
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'surge_rule.delete', entityType: 'surge_rule', entityId: parseInt(req.params.id), oldValue: existing });
    await execute('DELETE FROM surge_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Surge rule deleted' });
  } catch (err) {
    console.error('Surge DELETE error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete surge rule' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PRICE CALCULATOR  (before /:id to avoid param capture)
// ═══════════════════════════════════════════════════════════════

// POST /api/service-pricing/calculate — estimate service price
router.post('/calculate', async (req, res) => {
  try {
    const { service_bay_id, work_order_type, cash_amount, customer_type, distance_km,
            work_order_subtotal, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = req.body;
    const rules = await query(
      `SELECT * FROM service_pricing_rules WHERE workshop_id = ? AND is_active = TRUE
       AND (service_bay_id = ? OR service_bay_id IS NULL)
       AND (customer_type = ? OR customer_type = 'all')
       ORDER BY service_bay_id DESC, customer_type DESC LIMIT 1`,
      [req.workshopId, service_bay_id || null, customer_type || 'all']
    );
    if (!rules.length) {
      return res.json({ success: true, data: { estimated_fee: 50, breakdown: { base: 50 }, rule_name: 'Default', free_service: false } });
    }
    const rule = rules[0];
    let fee = parseFloat(rule.base_price) || 0;
    const breakdown = { base: fee };

    // Distance-based pricing (mobile mechanic / vehicle-pickup travel fee):
    // use provided distance_km, or compute via getRoadDistance
    let dist = parseFloat(distance_km) || 0;
    let etaMin = null;
    if (dist === 0 && pickup_lat && pickup_lng && dropoff_lat && dropoff_lng) {
      try {
        const rd = await getRoadDistance(
          parseFloat(pickup_lat), parseFloat(pickup_lng),
          parseFloat(dropoff_lat), parseFloat(dropoff_lng)
        );
        dist = rd.distance_km;
        etaMin = rd.duration_min;
      } catch { /* fallback: dist stays 0 */ }
    }
    const travelFeePerKm = parseFloat(rule.travel_fee_per_km) || 0;
    if (dist > 0 && travelFeePerKm > 0) {
      const distFee = Math.round(dist * travelFeePerKm * 100) / 100;
      fee += distFee;
      breakdown.travel_fee = distFee;
      breakdown.distance_km = dist;
    }

    // Express surcharge
    if (work_order_type === 'express' || work_order_type === 'same_day') {
      const surcharge = parseFloat(rule.express_surcharge) || 0;
      if (surcharge > 0) {
        fee += surcharge;
        breakdown.express_surcharge = surcharge;
      }
    }

    // Cash-payment handling fee
    const cash = parseFloat(cash_amount) || 0;
    const cashPct = parseFloat(rule.cash_fee_pct) || 0;
    if (cash > 0 && cashPct > 0) {
      const cashFee = Math.round(cash * cashPct / 100 * 100) / 100;
      fee += cashFee;
      breakdown.cash_fee = cashFee;
    }

    // Surge pricing multiplier
    let surgeMultiplier = 1;
    try {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const hour = now.getHours();
      const surgeRules = await query(
        `SELECT multiplier FROM surge_rules
         WHERE workshop_id = ? AND is_active = TRUE
           AND (day_of_week IS NULL OR day_of_week = ?)
           AND start_hour <= ? AND end_hour >= ?
           AND (service_bay_id IS NULL OR service_bay_id = ?)
         ORDER BY multiplier DESC LIMIT 1`,
        [req.workshopId, dayOfWeek, hour, hour, service_bay_id || 0]
      );
      if (surgeRules.length) {
        surgeMultiplier = parseFloat(surgeRules[0].multiplier) || 1;
        if (surgeMultiplier > 1) {
          breakdown.surge_multiplier = surgeMultiplier;
          const preSurge = fee;
          fee *= surgeMultiplier;
          breakdown.surge_addition = Math.round((fee - preSurge) * 100) / 100;
        }
      }
    } catch (e) { /* surge table may not exist yet */ }

    // Apply min/max bounds
    const minP = parseFloat(rule.min_price) || 0;
    const maxP = parseFloat(rule.max_price) || 999999;
    fee = Math.max(minP, Math.min(fee, maxP));
    if (fee === minP && fee !== parseFloat(rule.base_price)) breakdown.min_applied = true;
    if (fee === maxP) breakdown.max_applied = true;

    // Free service rules (if work order subtotal >= threshold)
    let freeService = false;
    try {
      const [setting] = await query(
        "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'free_service_min_order'",
        [req.workshopId]
      );
      if (setting && work_order_subtotal) {
        const threshold = parseFloat(setting.value) || 0;
        if (threshold > 0 && parseFloat(work_order_subtotal) >= threshold) {
          freeService = true;
          breakdown.free_service = true;
          breakdown.free_service_threshold = threshold;
          breakdown.original_fee = fee;
          fee = 0;
        }
      }
    } catch (e) { /* ignore */ }

    return res.json({
      success: true,
      data: {
        estimated_fee: Math.round(fee * 100) / 100,
        breakdown,
        free_service: freeService,
        rule_name: rule.name,
        rule_id: rule.id,
        eta_min: etaMin,
      }
    });
  } catch (err) {
    console.error('Calculate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to calculate price' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DISTANCE CALCULATION HELPER  (before /:id)
// ═══════════════════════════════════════════════════════════════

// POST /api/service-pricing/distance — calculate road distance between two points
// (used for mobile-mechanic / vehicle-pickup travel fee estimation)
router.post('/distance', async (req, res) => {
  try {
    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng } = req.body;
    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      return res.status(400).json({ success: false, message: 'pickup and dropoff lat/lng required' });
    }
    // Haversine straight-line (always available)
    const R = 6371;
    const dLat = (dropoff_lat - pickup_lat) * Math.PI / 180;
    const dLng = (dropoff_lng - pickup_lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(pickup_lat * Math.PI / 180) * Math.cos(dropoff_lat * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const straight_line_km = Math.round(R * c * 100) / 100;

    // Try getRoadDistance for real road distance & ETA
    let road_distance_km = Math.round(straight_line_km * 1.3 * 100) / 100;
    let eta_min = null;
    try {
      const rd = await getRoadDistance(
        parseFloat(pickup_lat), parseFloat(pickup_lng),
        parseFloat(dropoff_lat), parseFloat(dropoff_lng)
      );
      road_distance_km = rd.distance_km;
      eta_min = rd.duration_min;
    } catch {
      // Road distance service unavailable — keep the 1.3x haversine estimate
    }
    return res.json({ success: true, data: { straight_line_km, road_distance_km: road_distance_km, eta_min } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to calculate distance' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BULK OPERATIONS  (before /:id)
// ═══════════════════════════════════════════════════════════════

// POST /api/service-pricing/bulk-toggle — activate/deactivate multiple rules
router.post('/bulk-toggle', async (req, res) => {
  try {
    const { ids, is_active } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, message: 'ids array required' });
    const placeholders = ids.map(() => '?').join(',');
    await execute(
      `UPDATE service_pricing_rules SET is_active = ? WHERE id IN (${placeholders}) AND workshop_id = ?`,
      [is_active ? 1 : 0, ...ids, req.workshopId]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'service_pricing_rule.bulk_toggle', entityType: 'service_pricing_rule', newValue: { ids, is_active } });
    return res.json({ success: true, message: `${ids.length} rules updated`, count: ids.length });
  } catch (err) {
    console.error('Bulk toggle error:', err);
    return res.status(500).json({ success: false, message: 'Failed to bulk update rules' });
  }
});

// POST /api/service-pricing/duplicate/:id — duplicate a service pricing rule
router.post('/duplicate/:id', async (req, res) => {
  try {
    const [original] = await query(
      'SELECT * FROM service_pricing_rules WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!original) return res.status(404).json({ success: false, message: 'Service pricing rule not found' });

    const newName = `${original.name} (Copy)`;
    const result = await execute(
      `INSERT INTO service_pricing_rules (workshop_id, name, service_bay_id, customer_type, base_price, travel_fee_per_km,
        min_price, max_price, cash_fee_pct, express_surcharge, is_active, priority, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [req.workshopId, newName, original.service_bay_id, original.customer_type, original.base_price,
       original.travel_fee_per_km, original.min_price, original.max_price,
       original.cash_fee_pct, original.express_surcharge, original.priority || 0, original.description || null]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'service_pricing_rule.duplicate', entityType: 'service_pricing_rule', entityId: result.insertId, newValue: { source_id: original.id } });
    const [rule] = await query('SELECT * FROM service_pricing_rules WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: rule });
  } catch (err) {
    console.error('Duplicate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to duplicate service pricing rule' });
  }
});

// GET /api/service-pricing/history — pricing changes audit log
router.get('/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const rows = await query(
      `SELECT a.*, u.full_name as user_name
       FROM audit_logs a LEFT JOIN users u ON a.user_id = u.id
       WHERE a.workshop_id = ? AND a.entity_type IN ('service_pricing_rule', 'surge_rule')
       ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
      [req.workshopId, limit, offset]
    );
    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM audit_logs
       WHERE workshop_id = ? AND entity_type IN ('service_pricing_rule', 'surge_rule')`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rows, total, page, limit });
  } catch (err) {
    console.error('History error:', err);
    return res.json({ success: true, data: [], total: 0, page: 1, limit: 20 });
  }
});

// GET /api/service-pricing/stats — pricing overview statistics
router.get('/stats', async (req, res) => {
  try {
    const [ruleStats] = await query(
      `SELECT COUNT(*) as total_rules,
              SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_rules,
              AVG(base_price) as avg_base_price,
              MIN(base_price) as min_base_price,
              MAX(base_price) as max_base_price
       FROM service_pricing_rules WHERE workshop_id = ?`,
      [req.workshopId]
    );
    let surgeStats = { total_surge: 0, active_surge: 0 };
    try {
      const [ss] = await query(
        `SELECT COUNT(*) as total_surge,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_surge
         FROM surge_rules WHERE workshop_id = ?`,
        [req.workshopId]
      );
      surgeStats = ss;
    } catch (e) {}

    // Work orders using pricing in last 30 days
    let recentWorkOrders = { total_work_orders: 0, total_revenue: 0 };
    try {
      const [ro] = await query(
        `SELECT COUNT(*) as total_work_orders, COALESCE(SUM(service_fee), 0) as total_revenue
         FROM work_orders WHERE workshop_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
        [req.workshopId]
      );
      recentWorkOrders = ro;
    } catch (e) {}

    return res.json({
      success: true,
      data: {
        ...ruleStats,
        ...surgeStats,
        work_orders_30d: recentWorkOrders.total_work_orders,
        revenue_30d: parseFloat(recentWorkOrders.total_revenue) || 0,
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SERVICE PRICING RULES CRUD  (parametric /:id routes LAST)
// ═══════════════════════════════════════════════════════════════

// GET /api/service-pricing
router.get('/', async (req, res) => {
  try {
    const rules = await query(
      `SELECT p.*, b.name as service_bay_name FROM service_pricing_rules p
       LEFT JOIN service_bays b ON p.service_bay_id = b.id
       WHERE p.workshop_id = ? ORDER BY p.priority DESC, p.name`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rules });
  } catch (err) {
    console.error('Service pricing GET error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch service pricing rules' });
  }
});

// POST /api/service-pricing
router.post('/', async (req, res) => {
  try {
    const {
      name, service_bay_id, customer_type = 'all', base_price = 50, travel_fee_per_km = 0,
      min_price = 20, max_price = 5000, cash_fee_pct = 0,
      express_surcharge = 25, priority = 0, description = ''
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
    const bp = parseFloat(base_price) || 0;
    const minP = parseFloat(min_price) || 0;
    const maxP = parseFloat(max_price) || 5000;
    if (minP > maxP) return res.status(400).json({ success: false, message: 'Min price cannot exceed max price' });
    const cashPct = parseFloat(cash_fee_pct) || 0;
    if (cashPct < 0 || cashPct > 100) return res.status(400).json({ success: false, message: 'Cash fee % must be 0-100' });
    const ct = VALID_CUSTOMER_TYPES.includes(customer_type) ? customer_type : 'all';

    const result = await execute(
      `INSERT INTO service_pricing_rules (workshop_id, name, service_bay_id, customer_type, base_price, travel_fee_per_km,
        min_price, max_price, cash_fee_pct, express_surcharge, priority, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, name.trim(), service_bay_id || null, ct, bp, parseFloat(travel_fee_per_km) || 0,
       minP, maxP, cashPct, parseFloat(express_surcharge) || 0,
       parseInt(priority) || 0, description || null]
    );
    const [rule] = await query('SELECT * FROM service_pricing_rules WHERE id = ?', [result.insertId]);
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'service_pricing_rule.create', entityType: 'service_pricing_rule', entityId: result.insertId, newValue: rule });
    return res.status(201).json({ success: true, data: rule });
  } catch (err) {
    console.error('Service pricing POST error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create service pricing rule' });
  }
});

// GET /api/service-pricing/:id
router.get('/:id', async (req, res) => {
  try {
    const [rule] = await query(
      `SELECT p.*, b.name as service_bay_name FROM service_pricing_rules p
       LEFT JOIN service_bays b ON p.service_bay_id = b.id
       WHERE p.id = ? AND p.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!rule) return res.status(404).json({ success: false, message: 'Service pricing rule not found' });
    return res.json({ success: true, data: rule });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch service pricing rule' });
  }
});

// PUT /api/service-pricing/:id
router.put('/:id', async (req, res) => {
  try {
    const {
      name, service_bay_id, customer_type, base_price, travel_fee_per_km,
      min_price, max_price, cash_fee_pct, express_surcharge, is_active, priority, description
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
    const minP = parseFloat(min_price) || 0;
    const maxP = parseFloat(max_price) || 5000;
    if (minP > maxP) return res.status(400).json({ success: false, message: 'Min price cannot exceed max price' });
    const cashPct = parseFloat(cash_fee_pct) || 0;
    if (cashPct < 0 || cashPct > 100) return res.status(400).json({ success: false, message: 'Cash fee % must be 0-100' });
    const ct = VALID_CUSTOMER_TYPES.includes(customer_type) ? customer_type : 'all';

    const [existing] = await query('SELECT * FROM service_pricing_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Service pricing rule not found' });

    await execute(
      `UPDATE service_pricing_rules SET name=?, service_bay_id=?, customer_type=?, base_price=?, travel_fee_per_km=?,
       min_price=?, max_price=?, cash_fee_pct=?, express_surcharge=?, is_active=?,
       priority=?, description=?
       WHERE id = ? AND workshop_id = ?`,
      [name.trim(), service_bay_id || null, ct, parseFloat(base_price) || 0, parseFloat(travel_fee_per_km) || 0,
       minP, maxP, cashPct, parseFloat(express_surcharge) || 0,
       is_active !== undefined ? is_active : true,
       parseInt(priority) || 0, description || null,
       req.params.id, req.workshopId]
    );
    const [rule] = await query('SELECT * FROM service_pricing_rules WHERE id = ?', [req.params.id]);
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'service_pricing_rule.update', entityType: 'service_pricing_rule', entityId: parseInt(req.params.id), oldValue: existing, newValue: rule });
    return res.json({ success: true, data: rule });
  } catch (err) {
    console.error('Service pricing PUT error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update service pricing rule' });
  }
});

// DELETE /api/service-pricing/:id
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM service_pricing_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Service pricing rule not found' });
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'service_pricing_rule.delete', entityType: 'service_pricing_rule', entityId: parseInt(req.params.id), oldValue: existing });
    await execute('DELETE FROM service_pricing_rules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Service pricing rule deleted' });
  } catch (err) {
    console.error('Service pricing DELETE error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete service pricing rule' });
  }
});

export default router;
