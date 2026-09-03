import express from 'express';
import { query } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { PLAN_FEATURES } from '../middleware/plan-gate.js';
import { refreshSchedule, stopSchedule, generateReportData, buildReportHTML, executeSchedule } from '../lib/scheduled-reports.js';
import { sendEmail, getWorkshopBranding } from '../lib/email.js';
import { getFinancialConfig } from '../lib/financial.js';

const router = express.Router();

// Validates a date string is YYYY-MM-DD format (no injection possible after this)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shared date filter builder
function buildDateFilter(req) {
  const { period = '30', date_from, date_to } = req.query;
  // Enforce data retention limit based on plan
  const planSlug = req.subscription?.plan || 'trial';
  const maxRetentionDays = req.subscription?.features?.data_retention_days
    || PLAN_FEATURES[planSlug]?.data_retention_days || 30;
  const days = Math.min(Math.max(parseInt(period) || 30, 1), maxRetentionDays);
  if (date_from && date_to && DATE_RE.test(date_from) && DATE_RE.test(date_to)) {
    // Clamp date_from to not exceed retention limit
    const earliest = new Date(Date.now() - maxRetentionDays * 86400000).toISOString().slice(0, 10);
    const clampedFrom = date_from < earliest ? earliest : date_from;
    return { dateFilter: 'DATE(created_at) BETWEEN ? AND ?', dateFilterJoin: 'DATE(o.created_at) BETWEEN ? AND ?', dateParams: [clampedFrom, date_to] };
  }
  return { dateFilter: 'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', dateFilterJoin: 'o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', dateParams: [days] };
}

// GET /api/reports — car workshop platform reports
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { type = 'overview', period = '30', date_from, date_to } = req.query;
    const workshopId = req.workshopId;

    // ── Validate & build date filter safely ──────────────────────────────────
    // Enforce data retention limit based on plan
    const planSlug = req.subscription?.plan || 'trial';
    const maxRetentionDays = req.subscription?.features?.data_retention_days
      || PLAN_FEATURES[planSlug]?.data_retention_days || 30;
    const days = Math.min(Math.max(parseInt(period) || 30, 1), maxRetentionDays);

    let dateFilter;        // SQL fragment for work_orders.created_at
    let dateFilterJoin;    // SQL fragment for o.created_at (JOIN queries)
    let dateParams;        // Positional params that match the placeholders above

    if (date_from && date_to && DATE_RE.test(date_from) && DATE_RE.test(date_to)) {
      dateFilter     = 'DATE(created_at) BETWEEN ? AND ?';
      dateFilterJoin = 'DATE(o.created_at) BETWEEN ? AND ?';
      dateParams     = [date_from, date_to];
    } else if (date_from && date_to) {
      // Dates supplied but invalid format — reject
      return res.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD.' });
    } else {
      // Use period (already clamped integer)
      dateFilter     = 'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
      dateFilterJoin = 'o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
      dateParams     = [days];
    }

    let data = {};

    // Overview stats
    const [totalWorkOrders]    = await query(`SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND ${dateFilter}`, [workshopId, ...dateParams]);
    const [completedWorkOrders] = await query(`SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}`, [workshopId, ...dateParams]);
    const [failedWorkOrders]   = await query(`SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status = 'cancelled' AND ${dateFilter}`, [workshopId, ...dateParams]);
    const [totalRevenue]   = await query(`SELECT COALESCE(SUM(service_fee - discount), 0) as total FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}`, [workshopId, ...dateParams]);
    const [cashCollected]   = await query(`SELECT COALESCE(SUM(cash_amount), 0) as total FROM work_orders WHERE workshop_id = ? AND payment_method = 'cash' AND status = 'completed' AND ${dateFilter}`, [workshopId, ...dateParams]);

    data.overview = {
      total_orders:  totalWorkOrders.count || 0,
      delivered:     completedWorkOrders.count || 0,
      failed:        failedWorkOrders.count || 0,
      success_rate:  totalWorkOrders.count > 0 ? ((completedWorkOrders.count / totalWorkOrders.count) * 100).toFixed(1) : 0,
      total_revenue: parseFloat(totalRevenue.total) || 0,
      // The Reports page and its PDF export both read `cash_collected`; this
      // object only ever emitted `cod_collected`, so the KPI card showed
      // AED 0.00 no matter how much cash had been taken. `cod_collected` is
      // kept as an alias in case anything else still reads the old name.
      cash_collected: parseFloat(cashCollected.total) || 0,
      cod_collected:  parseFloat(cashCollected.total) || 0,
    };

    // Work order volume by day
    const volumeByDay = await query(
      `SELECT DATE(created_at) as date, COUNT(*) as total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as delivered,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as failed
       FROM work_orders WHERE workshop_id = ? AND ${dateFilter}
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId, ...dateParams]
    );
    data.volume_by_day = volumeByDay;

    // Work orders by service bay
    const byZone = await query(
      `SELECT z.name as zone, COUNT(o.id) as orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue
       FROM work_orders o JOIN service_bays z ON o.service_bay_id = z.id
       WHERE o.workshop_id = ? AND ${dateFilterJoin}
       GROUP BY z.id ORDER BY orders DESC`,
      [workshopId, ...dateParams]
    );
    data.by_zone = byZone;

    // Work orders by emirate
    const byEmirate = await query(
      // Emirate lives on the customer, not the work order. The old query read
      // work_orders.customer_emirate, a column left over from the delivery
      // platform that does not exist here — it made the whole report 500, so
      // every tab rendered as "no data" regardless of the date range.
      `SELECT COALESCE(NULLIF(c.emirate, ''), 'Unspecified') as emirate, COUNT(*) as orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered
       FROM work_orders o LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND ${dateFilterJoin}
       GROUP BY emirate ORDER BY orders DESC`,
      [workshopId, ...dateParams]
    );
    data.by_emirate = byEmirate;

    // Mechanic performance
    const mechanicPerformance = await query(
      `SELECT m.full_name,
              -- The Reports table had a VEHICLE column reading row.vehicle_type,
              -- a leftover from the delivery platform where a driver had a
              -- vehicle. Mechanics have a specialty instead, and the query never
              -- selected any vehicle field, so the column was always blank.
              m.specialty,
              COUNT(o.id) as total_assigned,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered,
              SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as failed,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue,
              m.rating
       FROM work_orders o JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND ${dateFilterJoin}
       GROUP BY m.id ORDER BY delivered DESC LIMIT 20`,
      [workshopId, ...dateParams]
    );
    // The Reports page reads `mechanic_performance`; `driver_performance` is
    // the old delivery-platform name, kept as an alias for any other consumer.
    data.mechanic_performance = mechanicPerformance;
    data.driver_performance   = mechanicPerformance;

    // Work orders by type
    const byType = await query(
      `SELECT work_order_type, COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND ${dateFilter} GROUP BY work_order_type`,
      [workshopId, ...dateParams]
    );
    // Page reads `by_work_order_type`; keep the old name as an alias.
    data.by_work_order_type = byType;
    data.by_order_type      = byType;

    // Work orders by payment method
    const byPayment = await query(
      `SELECT payment_method, COUNT(*) as count, COALESCE(SUM(service_fee), 0) as revenue
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}
       GROUP BY payment_method`,
      [workshopId, ...dateParams]
    );
    data.by_payment_method = byPayment;

    // Top customers (#46)
    const topCustomers = await query(
      `SELECT c.id, c.full_name AS name, c.company_name AS company, c.email,
              COUNT(o.id) as orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered,
              SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as failed,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue,
              COALESCE(AVG(o.service_fee - o.discount), 0) as avg_order_value,
              COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.cash_amount ELSE 0 END), 0) as cod_total
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND ${dateFilterJoin}
       GROUP BY c.id ORDER BY orders DESC LIMIT 20`,
      [workshopId, ...dateParams]
    );
    // Page reads `top_customers`; keep the old name as an alias.
    data.top_customers = topCustomers;
    data.top_clients   = topCustomers;

    // Service time by service bay (#51)
    const serviceTimeByZone = await query(
      `SELECT z.name as zone,
              COUNT(o.id) as delivered,
              ROUND(AVG(TIMESTAMPDIFF(MINUTE, o.created_at, o.completed_at))) as avg_minutes,
              ROUND(MIN(TIMESTAMPDIFF(MINUTE, o.created_at, o.completed_at))) as min_minutes,
              ROUND(MAX(TIMESTAMPDIFF(MINUTE, o.created_at, o.completed_at))) as max_minutes
       FROM work_orders o JOIN service_bays z ON o.service_bay_id = z.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND o.completed_at IS NOT NULL AND ${dateFilterJoin}
       GROUP BY z.id ORDER BY avg_minutes ASC`,
      [workshopId, ...dateParams]
    );
    data.delivery_time_by_zone = serviceTimeByZone;

    // Failure reasons breakdown (#54)
    const failureReasons = await query(
      `SELECT COALESCE(failure_reason, 'Not Specified') as reason, COUNT(*) as count
       FROM work_orders WHERE workshop_id = ? AND status = 'cancelled' AND ${dateFilter}
       GROUP BY failure_reason ORDER BY count DESC`,
      [workshopId, ...dateParams]
    );
    data.failure_reasons = failureReasons;

    return res.json({ success: true, data });
  } catch (error) {
    console.error('Reports error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
});

// ── GET /api/reports/performance — server-side performance & SLA metrics ──
router.get('/performance', authMiddleware, async (req, res) => {
  try {
    const { period = 'month', date_from, date_to } = req.query;
    const workshopId = req.workshopId;
    const SLA_HOURS = 24;

    // Build date filter
    let dateFilter, dateFilterJoin, dateParams;
    if (date_from && date_to && DATE_RE.test(date_from) && DATE_RE.test(date_to)) {
      dateFilter     = 'DATE(created_at) BETWEEN ? AND ?';
      dateFilterJoin = 'DATE(o.created_at) BETWEEN ? AND ?';
      dateParams     = [date_from, date_to];
    } else {
      let days = 30;
      if (period === 'today') days = 0;
      else if (period === 'week') days = 7;
      else if (period === 'month') days = 30;
      else if (period === 'quarter') days = 90;
      else if (period === 'year') days = 365;
      if (days === 0) {
        dateFilter     = 'DATE(created_at) = CURDATE()';
        dateFilterJoin = 'DATE(o.created_at) = CURDATE()';
        dateParams     = [];
      } else {
        dateFilter     = 'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        dateFilterJoin = 'o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
        dateParams     = [days];
      }
    }

    // ── Global KPIs (single query for efficiency) ──
    const [kpis] = await query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as delivered,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as failed,
         0 as returned,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_transit,
         SUM(CASE WHEN status = 'inspection' THEN 1 ELSE 0 END) as inspection,
         SUM(CASE WHEN status = 'ready_for_pickup' THEN 1 ELSE 0 END) as ready_for_pickup,
         SUM(CASE WHEN status IN ('pending','assigned','accepted','confirmed') THEN 1 ELSE 0 END) as pending,
         ROUND(AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
           THEN TIMESTAMPDIFF(MINUTE, created_at, completed_at) END), 1) as avg_delivery_minutes,
         SUM(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
           AND TIMESTAMPDIFF(HOUR, created_at, completed_at) <= ${SLA_HOURS} THEN 1 ELSE 0 END) as on_time
       FROM work_orders WHERE workshop_id = ? AND ${dateFilter}`,
      [workshopId, ...dateParams]
    );

    const total = parseInt(kpis.total) || 0;
    const delivered = parseInt(kpis.delivered) || 0;
    const failed = parseInt(kpis.failed) || 0;
    const returned = parseInt(kpis.returned) || 0;
    const onTime = parseInt(kpis.on_time) || 0;
    const inTransit = parseInt(kpis.in_transit) || 0;
    const inspection = parseInt(kpis.inspection) || 0;
    const readyForPickup = parseInt(kpis.ready_for_pickup) || 0;
    const pending = parseInt(kpis.pending) || 0;
    const avgMinutes = parseFloat(kpis.avg_delivery_minutes) || 0;
    const deliveryRate = total ? Math.round((delivered / total) * 100) : 0;
    const onTimePct = delivered ? Math.round((onTime / delivered) * 100) : 0;
    const firstAttemptTotal = delivered + failed;
    const firstAttemptPct = firstAttemptTotal ? Math.round((delivered / firstAttemptTotal) * 100) : 0;

    // ── Per-mechanic performance with REAL ratings ──
    const mechanicPerf = await query(
      `SELECT
         m.id as driver_id, m.full_name as name, m.phone,
         COUNT(o.id) as total,
         SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as delivered,
         SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as failed,
         0 as returned,
         ROUND(AVG(CASE WHEN o.status = 'completed' AND o.completed_at IS NOT NULL
           THEN TIMESTAMPDIFF(MINUTE, o.created_at, o.completed_at) END), 1) as avg_minutes,
         SUM(CASE WHEN o.status = 'completed' AND o.completed_at IS NOT NULL
           AND TIMESTAMPDIFF(HOUR, o.created_at, o.completed_at) <= ${SLA_HOURS} THEN 1 ELSE 0 END) as on_time,
         COALESCE(SUM(CASE WHEN o.payment_method = 'cash' AND o.cash_collected > 0
           THEN o.cash_amount ELSE 0 END), 0) as cod_collected,
         -- Rating is a column on the mechanic. The old query averaged a
         -- mechanic_ratings table that does not exist in this schema, which
         -- made the whole performance report 500.
         COALESCE(m.rating, 0) as avg_rating,
         SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as rating_count
       FROM work_orders o
       JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND ${dateFilterJoin}
       GROUP BY m.id
       ORDER BY delivered DESC`,
      [workshopId, ...dateParams]
    );

    // Compute per-mechanic success rate, grade, etc.
    const mechanics = mechanicPerf.map((d, i) => {
      const dTotal = parseInt(d.total) || 0;
      const dDelivered = parseInt(d.delivered) || 0;
      const dFailed = parseInt(d.failed) || 0;
      const successRate = dTotal ? Math.round((dDelivered / dTotal) * 100) : 0;
      const dOnTimePct = dDelivered ? Math.round((parseInt(d.on_time) || 0) / dDelivered * 100) : 0;
      const avgHours = d.avg_minutes ? parseFloat(d.avg_minutes) / 60 : 0;
      return {
        driver_id: d.driver_id,
        name: d.name,
        phone: d.phone,
        total: dTotal,
        delivered: dDelivered,
        failed: dFailed,
        returned: parseInt(d.returned) || 0,
        successRate,
        onTimePct: dOnTimePct,
        avgHours: Math.round(avgHours * 10) / 10,
        cod_collected: parseFloat(d.cod_collected) || 0,
        rating: parseFloat(d.avg_rating) || 0,
        ratingCount: d.rating_count || 0,
        grade: successRate >= 85 ? 'excellent' : successRate >= 60 ? 'good' : 'poor',
      };
    });

    // ── Status distribution (for chart) ──
    const statusDist = {
      delivered, failed, returned,
      in_transit: inTransit,
      inspection,
      ready_for_pickup: readyForPickup,
      pending,
    };

    return res.json({
      success: true,
      data: {
        kpis: {
          total, delivered, failed, returned,
          in_transit: statusDist.in_transit,
          inspection: statusDist.inspection,
          ready_for_pickup: statusDist.ready_for_pickup,
          pending: statusDist.pending,
          deliveryRate, onTimePct, firstAttemptPct,
          avgDeliveryHours: Math.round(avgMinutes / 60 * 10) / 10,
          avgDeliveryMinutes: Math.round(avgMinutes),
          slaTargetHours: SLA_HOURS,
        },
        drivers: mechanics,
        statusDistribution: statusDist,
      }
    });
  } catch (error) {
    console.error('Performance report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate performance report' });
  }
});

// ── GET /api/reports/financial — financial summary (#55) ──────────────────────
router.get('/financial', authMiddleware, async (req, res) => {
  try {
    const { period = '30', date_from, date_to } = req.query;
    const workshopId = req.workshopId;
    const days = Math.min(Math.max(parseInt(period) || 30, 1), 365);

    let dateFilter, dateFilterJoin, dateParams;
    if (date_from && date_to && DATE_RE.test(date_from) && DATE_RE.test(date_to)) {
      dateFilter     = 'DATE(created_at) BETWEEN ? AND ?';
      dateFilterJoin = 'DATE(o.created_at) BETWEEN ? AND ?';
      dateParams     = [date_from, date_to];
    } else {
      dateFilter     = 'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
      dateFilterJoin = 'o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
      dateParams     = [days];
    }

    // 1) High-level financial KPIs
    const [totals] = await query(
      `SELECT
         COUNT(*) as total_orders,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as delivered,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN service_fee ELSE 0 END), 0) as gross_delivery_fees,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN discount ELSE 0 END), 0) as total_discounts,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN service_fee - discount ELSE 0 END), 0) as net_revenue,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status = 'completed' THEN cash_amount ELSE 0 END), 0) as cod_collected,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status IN ('pending','assigned','accepted','in_progress','confirmed') THEN cash_amount ELSE 0 END), 0) as cod_outstanding,
         COALESCE(SUM(CASE WHEN cash_collected >= 1 THEN cash_amount ELSE 0 END), 0) as cod_settled,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status = 'completed' AND (cash_collected = 0 OR cash_collected IS NULL) THEN cash_amount ELSE 0 END), 0) as cod_unsettled,
         COALESCE(AVG(CASE WHEN status = 'completed' THEN service_fee - discount END), 0) as avg_order_value
       FROM work_orders WHERE workshop_id = ? AND ${dateFilter}`,
      [workshopId, ...dateParams]
    );

    // 2) Revenue by day (for line chart)
    const revenueByDay = await query(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(service_fee - discount), 0) as revenue,
              COUNT(*) as orders,
              COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN cash_amount ELSE 0 END), 0) as cod
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId, ...dateParams]
    );

    // 3) Revenue by payment method
    const byPaymentMethod = await query(
      `SELECT payment_method,
              COUNT(*) as count,
              COALESCE(SUM(service_fee - discount), 0) as revenue,
              COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN cash_amount ELSE 0 END), 0) as cod_total
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}
       GROUP BY payment_method ORDER BY revenue DESC`,
      [workshopId, ...dateParams]
    );

    // 4) Revenue by service bay
    const revenueByZone = await query(
      `SELECT z.name as zone,
              COUNT(o.id) as orders,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue,
              COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.cash_amount ELSE 0 END), 0) as cod_total
       FROM work_orders o JOIN service_bays z ON o.service_bay_id = z.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND ${dateFilterJoin}
       GROUP BY z.id ORDER BY revenue DESC`,
      [workshopId, ...dateParams]
    );

    // 5) Top customers by revenue
    const topCustomersByRevenue = await query(
      `SELECT c.full_name AS name, c.company_name AS company,
              COUNT(o.id) as orders,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue,
              COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.cash_amount ELSE 0 END), 0) as cod_total
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND ${dateFilterJoin}
       GROUP BY c.id ORDER BY revenue DESC LIMIT 10`,
      [workshopId, ...dateParams]
    );

    // 6) Mechanic settlements
    const mechanicSettlements = await query(
      `SELECT m.full_name as name,
              COUNT(o.id) as deliveries,
              COALESCE(SUM(o.service_fee - o.discount), 0) as revenue_generated,
              COALESCE(SUM(CASE WHEN o.payment_method = 'cash' THEN o.cash_amount ELSE 0 END), 0) as cod_collected,
              COALESCE(SUM(CASE WHEN o.cash_collected >= 1 THEN o.cash_amount ELSE 0 END), 0) as cod_settled,
              COALESCE(SUM(CASE WHEN o.payment_method = 'cash' AND (o.cash_collected = 0 OR o.cash_collected IS NULL) AND o.status = 'completed' THEN o.cash_amount ELSE 0 END), 0) as cod_pending
       FROM work_orders o JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND ${dateFilterJoin}
       GROUP BY m.id ORDER BY revenue_generated DESC`,
      [workshopId, ...dateParams]
    );

    return res.json({
      success: true,
      data: {
        kpis: {
          total_orders:       parseInt(totals.total_orders) || 0,
          delivered:          parseInt(totals.delivered) || 0,
          // The Financial tab reads gross_service_fees and cash_collected; only
          // the delivery-era names were emitted, so both cards showed AED 0.00.
          // Old names kept as aliases for any other consumer.
          gross_service_fees:  parseFloat(totals.gross_delivery_fees) || 0,
          gross_delivery_fees: parseFloat(totals.gross_delivery_fees) || 0,
          total_discounts:    parseFloat(totals.total_discounts) || 0,
          net_revenue:        parseFloat(totals.net_revenue) || 0,
          cash_collected:     parseFloat(totals.cod_collected) || 0,
          cod_collected:      parseFloat(totals.cod_collected) || 0,
          cod_outstanding:    parseFloat(totals.cod_outstanding) || 0,
          cod_settled:        parseFloat(totals.cod_settled) || 0,
          cod_unsettled:      parseFloat(totals.cod_unsettled) || 0,
          avg_order_value:    parseFloat(totals.avg_order_value) || 0,
        },
        revenue_by_day: revenueByDay,
        by_payment_method: byPaymentMethod,
        revenue_by_zone: revenueByZone,
        top_clients: topCustomersByRevenue,
        driver_settlements: mechanicSettlements,
      }
    });
  } catch (error) {
    console.error('Financial report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate financial report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #70 — COMMISSION BREAKDOWN REPORT
// ═══════════════════════════════════════════════════════════════
router.get('/commission', authMiddleware, async (req, res) => {
  try {
    const { dateFilter, dateFilterJoin, dateParams } = buildDateFilter(req);
    const workshopId = req.workshopId;

    // Total commission earned
    const [totals] = await query(
      `SELECT
         COUNT(*) as total_orders,
         COALESCE(SUM(commission_amount), 0) as total_commission,
         COALESCE(SUM(net_payable), 0) as total_net_payable,
         COALESCE(SUM(vat_amount), 0) as total_vat,
         COALESCE(SUM(service_fee - discount), 0) as gross_revenue,
         COALESCE(AVG(commission_rate), 0) as avg_commission_rate
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}`,
      [workshopId, ...dateParams]
    );

    // Commission by customer
    const byClient = await query(
      `SELECT c.full_name AS name, c.company_name AS company,
              COUNT(o.id) as orders,
              COALESCE(SUM(o.commission_amount), 0) as commission,
              COALESCE(SUM(o.net_payable), 0) as net_payable,
              COALESCE(SUM(o.service_fee - o.discount), 0) as gross
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND ${dateFilterJoin}
       GROUP BY c.id ORDER BY commission DESC LIMIT 20`,
      [workshopId, ...dateParams]
    );

    // Commission by day
    const byDay = await query(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(commission_amount), 0) as commission,
              COALESCE(SUM(net_payable), 0) as net_payable,
              COUNT(*) as orders
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId, ...dateParams]
    );

    return res.json({ success: true, data: { totals: { total_orders: totals.total_orders, total_commission: parseFloat(totals.total_commission), total_net_payable: parseFloat(totals.total_net_payable), total_vat: parseFloat(totals.total_vat), gross_revenue: parseFloat(totals.gross_revenue), avg_commission_rate: parseFloat(totals.avg_commission_rate) }, by_client: byClient, by_day: byDay } });
  } catch (error) {
    console.error('Commission report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate commission report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #72 — PLATFORM REVENUE DASHBOARD
// ═══════════════════════════════════════════════════════════════
router.get('/platform-revenue', authMiddleware, async (req, res) => {
  try {
    const { dateFilter, dateParams } = buildDateFilter(req);
    const workshopId = req.workshopId;

    const [rev] = await query(
      `SELECT
         COALESCE(SUM(commission_amount), 0) as commission_revenue,
         COALESCE(SUM(platform_fee), 0) as platform_fee_revenue,
         COALESCE(SUM(vat_amount), 0) as vat_collected,
         COALESCE(SUM(service_fee - discount), 0) as total_merchant_revenue,
         COALESCE(SUM(net_payable), 0) as total_payable_to_merchants,
         COALESCE(SUM(commission_amount) + SUM(platform_fee), 0) as total_platform_earnings,
         COUNT(*) as total_delivered
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}`,
      [workshopId, ...dateParams]
    );

    // Platform earnings by day
    const byDay = await query(
      `SELECT DATE(created_at) as date,
              COALESCE(SUM(commission_amount), 0) as commission,
              COALESCE(SUM(platform_fee), 0) as platform_fee,
              COALESCE(SUM(commission_amount) + SUM(platform_fee), 0) as total_earnings
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${dateFilter}
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId, ...dateParams]
    );

    return res.json({ success: true, data: { kpis: { commission_revenue: parseFloat(rev.commission_revenue), platform_fee_revenue: parseFloat(rev.platform_fee_revenue), vat_collected: parseFloat(rev.vat_collected), total_merchant_revenue: parseFloat(rev.total_merchant_revenue), total_payable_to_merchants: parseFloat(rev.total_payable_to_merchants), total_platform_earnings: parseFloat(rev.total_platform_earnings), total_delivered: rev.total_delivered }, earnings_by_day: byDay } });
  } catch (error) {
    console.error('Platform revenue error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate platform revenue' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #82 — PERIOD-OVER-PERIOD FINANCIAL COMPARISON
// ═══════════════════════════════════════════════════════════════
router.get('/financial-comparison', authMiddleware, async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const days = Math.min(Math.max(parseInt(period) || 30, 1), 365);
    const workshopId = req.workshopId;

    const getMetrics = async (filter, params) => {
      const [m] = await query(
        `SELECT COUNT(*) as orders,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as delivered,
                COALESCE(SUM(CASE WHEN status='completed' THEN service_fee - discount ELSE 0 END), 0) as revenue,
                COALESCE(SUM(commission_amount), 0) as commission,
                COALESCE(SUM(net_payable), 0) as net_payable,
                COALESCE(SUM(vat_amount), 0) as vat
         FROM work_orders WHERE workshop_id = ? AND ${filter}`,
        [workshopId, ...params]
      );
      return m;
    };

    const current = await getMetrics(
      'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [days]
    );
    const previous = await getMetrics(
      'created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days * 2, days]
    );

    const calcDelta = (c, p) => p > 0 ? Math.round(((c - p) / p) * 100) : (c > 0 ? 100 : 0);

    return res.json({ success: true, data: {
      current: { orders: current.orders, delivered: current.delivered, revenue: parseFloat(current.revenue), commission: parseFloat(current.commission), net_payable: parseFloat(current.net_payable), vat: parseFloat(current.vat) },
      previous: { orders: previous.orders, delivered: previous.delivered, revenue: parseFloat(previous.revenue), commission: parseFloat(previous.commission), net_payable: parseFloat(previous.net_payable), vat: parseFloat(previous.vat) },
      deltas: { orders: calcDelta(current.orders, previous.orders), delivered: calcDelta(current.delivered, previous.delivered), revenue: calcDelta(parseFloat(current.revenue), parseFloat(previous.revenue)), commission: calcDelta(parseFloat(current.commission), parseFloat(previous.commission)) }
    }});
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to generate comparison' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #83 — NET EARNINGS REPORT PER CUSTOMER
// ═══════════════════════════════════════════════════════════════
router.get('/merchant-earnings', authMiddleware, async (req, res) => {
  try {
    const { dateFilter: df, dateFilterJoin: dfj, dateParams } = buildDateFilter(req);
    const workshopId = req.workshopId;

    const customersEarnings = await query(
      `SELECT c.id, c.full_name AS name, c.company_name AS company, c.email,
              COUNT(o.id) as total_orders,
              SUM(CASE WHEN o.status='completed' THEN 1 ELSE 0 END) as delivered,
              COALESCE(SUM(o.service_fee), 0) as gross_delivery_fees,
              COALESCE(SUM(o.discount), 0) as total_discounts,
              COALESCE(SUM(o.commission_amount), 0) as commission_deducted,
              COALESCE(SUM(o.vat_amount), 0) as vat_amount,
              COALESCE(SUM(o.platform_fee), 0) as platform_fees,
              COALESCE(SUM(o.net_payable), 0) as net_payable,
              COALESCE(AVG(o.service_fee - o.discount), 0) as avg_order_value
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND ${dfj}
       GROUP BY c.id ORDER BY net_payable DESC`,
      [workshopId, ...dateParams]
    );

    return res.json({ success: true, data: customersEarnings });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to generate customer earnings' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #87 — TAX SUMMARY / VAT RETURN REPORT
// ═══════════════════════════════════════════════════════════════
router.get('/tax-summary', authMiddleware, async (req, res) => {
  try {
    const { dateFilter: df, dateFilterJoin: dfj, dateParams } = buildDateFilter(req);
    const workshopId = req.workshopId;

    // Get VAT config
    let finConfig;
    try { finConfig = await getFinancialConfig(workshopId); } catch { finConfig = { vatEnabled: false, vatRate: 0, vatNumber: '' }; }

    // Total tax collected
    const [totals] = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN status='completed' THEN service_fee - discount ELSE 0 END), 0) as total_taxable,
         COALESCE(SUM(vat_amount), 0) as total_vat_collected,
         COALESCE(SUM(CASE WHEN vat_rate > 0 THEN 1 ELSE 0 END), 0) as taxed_orders,
         COUNT(*) as total_orders
       FROM work_orders WHERE workshop_id = ? AND ${df}`,
      [workshopId, ...dateParams]
    );

    // VAT by rate (in case different rates were used over time)
    const byRate = await query(
      `SELECT vat_rate, COUNT(*) as orders, COALESCE(SUM(vat_amount), 0) as vat_total
       FROM work_orders WHERE workshop_id = ? AND vat_rate > 0 AND ${df}
       GROUP BY vat_rate ORDER BY vat_rate`,
      [workshopId, ...dateParams]
    );

    // VAT from invoices
    const [invTotals] = await query(
      `SELECT COALESCE(SUM(tax_amount), 0) as invoice_vat, COUNT(*) as invoices
       FROM invoices WHERE workshop_id = ? AND tax_rate > 0 AND ${df.replace('created_at', 'invoices.created_at')}`,
      [workshopId, ...dateParams]
    );

    return res.json({ success: true, data: {
      vat_number: finConfig.vatNumber,
      vat_rate: finConfig.vatRate,
      vat_enabled: finConfig.vatEnabled,
      totals: { total_taxable: parseFloat(totals.total_taxable), total_vat_collected: parseFloat(totals.total_vat_collected), taxed_orders: totals.taxed_orders, total_orders: totals.total_orders },
      by_rate: byRate,
      invoice_vat: { total: parseFloat(invTotals?.invoice_vat || 0), invoices: invTotals?.invoices || 0 }
    }});
  } catch (error) {
    console.error('Tax summary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate tax summary' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #71 — CSV/EXCEL EXPORT FOR FINANCIAL REPORTS
// ═══════════════════════════════════════════════════════════════
router.get('/financial/export', authMiddleware, async (req, res) => {
  try {
    const { dateFilter: df, dateFilterJoin: dfj, dateParams } = buildDateFilter(req);
    const workshopId = req.workshopId;
    const { type = 'orders' } = req.query;

    if (type === 'commission') {
      const rows = await query(
        `SELECT o.work_order_number, o.created_at, c.full_name as client, o.service_fee, o.discount,
                o.commission_rate, o.commission_amount, o.vat_rate, o.vat_amount,
                o.platform_fee, o.net_payable, o.total_amount, o.status
         FROM work_orders o LEFT JOIN customers c ON o.customer_id = c.id
         WHERE o.workshop_id = ? AND ${dfj} ORDER BY o.created_at DESC`,
        [workshopId, ...dateParams]
      );
      const header = 'WorkOrder#,Date,Customer,Service Fee,Discount,Commission %,Commission,VAT %,VAT,Platform Fee,Net Payable,Total,Status\n';
      const csv = rows.map(r =>
        `${r.work_order_number},"${r.created_at}","${r.client || ''}",${r.service_fee},${r.discount},${r.commission_rate},${r.commission_amount},${r.vat_rate},${r.vat_amount},${r.platform_fee},${r.net_payable},${r.total_amount},${r.status}`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="financial_report.csv"');
      return res.send(header + csv);
    }

    // Default: revenue overview
    const rows = await query(
      `SELECT DATE(created_at) as date, COUNT(*) as orders,
              COALESCE(SUM(service_fee - discount), 0) as revenue,
              COALESCE(SUM(commission_amount), 0) as commission,
              COALESCE(SUM(vat_amount), 0) as vat,
              COALESCE(SUM(net_payable), 0) as net_payable
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${df}
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId, ...dateParams]
    );
    const header = 'Date,Orders,Revenue,Commission,VAT,Net Payable\n';
    const csv = rows.map(r => `${r.date},${r.orders},${r.revenue},${r.commission},${r.vat},${r.net_payable}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue_report.csv"');
    return res.send(header + csv);
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to export report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #95 — DISCREPANCY DETECTION / RECONCILIATION CHECK
// ═══════════════════════════════════════════════════════════════
router.get('/discrepancies', authMiddleware, async (req, res) => {
  try {
    const workshopId = req.workshopId;
    const issues = [];

    // 1. Check wallet balance vs transaction sum
    try {
      const [wallet] = await query('SELECT balance, held_balance FROM wallets WHERE workshop_id = ?', [workshopId]);
      if (wallet) {
        const [txSum] = await query(
          `SELECT COALESCE(SUM(CASE WHEN type IN ('topup','cod_settled','prepaid_settled') THEN amount ELSE 0 END), 0) as credits,
                  COALESCE(SUM(CASE WHEN type IN ('withdrawal') THEN ABS(amount) ELSE 0 END), 0) as debits
           FROM wallet_transactions WHERE workshop_id = ?`,
          [workshopId]
        );
        const expectedBalance = parseFloat(txSum.credits) - parseFloat(txSum.debits);
        const actualBalance = parseFloat(wallet.balance);
        if (Math.abs(expectedBalance - actualBalance) > 0.01) {
          issues.push({ type: 'wallet_balance_mismatch', expected: expectedBalance, actual: actualBalance, diff: Math.round((actualBalance - expectedBalance) * 100) / 100 });
        }
      }
    } catch (e) { /* ignore */ }

    // 2. Check invoice totals vs work order totals
    try {
      const mismatched = await query(
        `SELECT i.id as invoice_id, i.invoice_number, i.total_amount as invoice_total,
                o.total_amount as order_total, o.work_order_number
         FROM invoices i JOIN work_orders o ON i.work_order_id = o.id
         WHERE i.workshop_id = ? AND ABS(i.total_amount - o.total_amount) > 0.01
         LIMIT 20`,
        [workshopId]
      );
      for (const m of mismatched) {
        issues.push({ type: 'invoice_order_mismatch', invoice: m.invoice_number, order: m.work_order_number, invoice_total: m.invoice_total, order_total: m.order_total });
      }
    } catch (e) { /* ignore */ }

    // 3. Work orders with negative net_payable
    try {
      const negative = await query(
        'SELECT work_order_number, net_payable FROM work_orders WHERE workshop_id = ? AND net_payable < 0 LIMIT 10',
        [workshopId]
      );
      for (const n of negative) {
        issues.push({ type: 'negative_net_payable', order: n.work_order_number, net_payable: n.net_payable });
      }
    } catch (e) { /* ignore */ }

    return res.json({ success: true, data: { issues, count: issues.length, checked_at: new Date().toISOString() } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to check discrepancies' });
  }
});

// ── Scheduled Reports Management (#58) ────────────────────────────────────────

// GET /api/reports/schedules — list schedules
router.get('/schedules', authMiddleware, async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM report_schedules WHERE workshop_id = ? ORDER BY created_at DESC',
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('List schedules error:', err);
    return res.status(500).json({ success: false, message: 'Failed to list schedules' });
  }
});

// POST /api/reports/schedules — create schedule
router.post('/schedules', authMiddleware, async (req, res) => {
  try {
    const { frequency = 'daily', recipients = [], cron_expression } = req.body;
    if (!recipients.length) return res.status(400).json({ success: false, message: 'At least one recipient email is required' });

    const cronExpr = cron_expression || (frequency === 'weekly' ? '0 7 * * 1' : '0 7 * * *');
    const result = await query(
      'INSERT INTO report_schedules (workshop_id, frequency, cron_expression, recipients, is_active) VALUES (?, ?, ?, ?, TRUE)',
      [req.workshopId, frequency, cronExpr, JSON.stringify(recipients)]
    );
    const [schedule] = await query('SELECT * FROM report_schedules WHERE id = ?', [result.insertId]);
    refreshSchedule(schedule);
    return res.json({ success: true, data: schedule });
  } catch (err) {
    console.error('Create schedule error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create schedule' });
  }
});

// PUT /api/reports/schedules/:id — update schedule
router.put('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    const { frequency, recipients, cron_expression, is_active } = req.body;
    const updates = [];
    const params = [];
    if (frequency !== undefined)       { updates.push('frequency = ?'); params.push(frequency); }
    if (recipients !== undefined)      { updates.push('recipients = ?'); params.push(JSON.stringify(recipients)); }
    if (cron_expression !== undefined) { updates.push('cron_expression = ?'); params.push(cron_expression); }
    if (is_active !== undefined)       { updates.push('is_active = ?'); params.push(is_active); }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    params.push(req.params.id, req.workshopId);
    await query(`UPDATE report_schedules SET ${updates.join(', ')} WHERE id = ? AND workshop_id = ?`, params);
    const [schedule] = await query('SELECT * FROM report_schedules WHERE id = ?', [req.params.id]);
    if (schedule) refreshSchedule(schedule);
    return res.json({ success: true, data: schedule });
  } catch (err) {
    console.error('Update schedule error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update schedule' });
  }
});

// DELETE /api/reports/schedules/:id
router.delete('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    stopSchedule(parseInt(req.params.id));
    await query('DELETE FROM report_schedules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete schedule error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete schedule' });
  }
});

// POST /api/reports/schedules/:id/send-now — send report immediately
router.post('/schedules/:id/send-now', authMiddleware, async (req, res) => {
  try {
    const [schedule] = await query('SELECT * FROM report_schedules WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!schedule) return res.status(404).json({ success: false, message: 'Schedule not found' });
    await executeSchedule(schedule);
    return res.json({ success: true, message: 'Report sent successfully' });
  } catch (err) {
    console.error('Send now error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send report' });
  }
});

// POST /api/reports/schedules/preview — preview report without sending
router.post('/schedules/preview', authMiddleware, async (req, res) => {
  try {
    const { frequency = 'daily' } = req.body;
    const days = frequency === 'weekly' ? 7 : 1;
    const data = await generateReportData(req.workshopId, days);
    const branding = await getWorkshopBranding(req.workshopId);
    const html = buildReportHTML(data, frequency === 'weekly' ? 'Weekly' : 'Daily', branding);
    return res.json({ success: true, data: { ...data, html } });
  } catch (err) {
    console.error('Preview error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate preview' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #96 — PROFIT & LOSS PER CUSTOMER
// ═══════════════════════════════════════════════════════════════

router.get('/profit-loss', authMiddleware, async (req, res) => {
  try {
    const { dateFilter: df, dateParams: dp } = buildDateFilter(req);
    const { customer_id } = req.query;

    let where = `o.workshop_id = ? AND o.status = 'completed' AND ${df.replace('created_at', 'o.created_at')}`;
    const params = [req.workshopId, ...dp];
    if (customer_id) { where += ' AND o.customer_id = ?'; params.push(customer_id); }

    const rows = await query(
      `SELECT c.id as customer_id, c.full_name as merchant_name,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(o.service_fee), 0) as gross_revenue,
        COALESCE(SUM(o.discount), 0) as total_discounts,
        COALESCE(SUM(o.service_fee - COALESCE(o.discount, 0)), 0) as net_revenue,
        COALESCE(SUM(o.commission_amount), 0) as commission_earned,
        COALESCE(SUM(o.platform_fee), 0) as platform_fees,
        COALESCE(SUM(o.service_fee - COALESCE(o.discount,0) - COALESCE(o.commission_amount,0) - COALESCE(o.platform_fee,0)), 0) as merchant_net,
        COALESCE(SUM(o.commission_amount + COALESCE(o.platform_fee,0)), 0) as platform_earnings
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE ${where}
       GROUP BY c.id ORDER BY platform_earnings DESC`,
      params
    );

    const totals = rows.reduce((acc, r) => ({
      gross_revenue: acc.gross_revenue + parseFloat(r.gross_revenue),
      total_discounts: acc.total_discounts + parseFloat(r.total_discounts),
      net_revenue: acc.net_revenue + parseFloat(r.net_revenue),
      commission_earned: acc.commission_earned + parseFloat(r.commission_earned),
      platform_fees: acc.platform_fees + parseFloat(r.platform_fees),
      platform_earnings: acc.platform_earnings + parseFloat(r.platform_earnings),
      merchant_net: acc.merchant_net + parseFloat(r.merchant_net),
      total_orders: acc.total_orders + parseInt(r.total_orders)
    }), { gross_revenue: 0, total_discounts: 0, net_revenue: 0, commission_earned: 0, platform_fees: 0, platform_earnings: 0, merchant_net: 0, total_orders: 0 });

    return res.json({ success: true, data: { merchants: rows, totals } });
  } catch (err) {
    console.error('P&L report error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate P&L report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #97 — PLATFORM MARGIN ANALYSIS
// ═══════════════════════════════════════════════════════════════

router.get('/margin-analysis', authMiddleware, async (req, res) => {
  try {
    const { dateFilter: df, dateParams: dp } = buildDateFilter(req);
    const t = req.workshopId;

    const [overall] = await query(
      `SELECT
         COALESCE(SUM(service_fee - COALESCE(discount,0)), 0) as net_revenue,
         COALESCE(SUM(commission_amount), 0) as commission_total,
         COALESCE(SUM(platform_fee), 0) as platform_fee_total,
         COALESCE(SUM(commission_amount + COALESCE(platform_fee,0)), 0) as total_platform_income,
         COUNT(*) as order_count
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${df}`, [t, ...dp]
    );

    const gross = parseFloat(overall.net_revenue) || 1;
    const platformIncome = parseFloat(overall.total_platform_income) || 0;

    const byDay = await query(
      `SELECT DATE(created_at) as date,
         COALESCE(SUM(service_fee - COALESCE(discount,0)), 0) as revenue,
         COALESCE(SUM(commission_amount + COALESCE(platform_fee,0)), 0) as platform_income,
         ROUND(COALESCE(SUM(commission_amount + COALESCE(platform_fee,0)),0) / GREATEST(SUM(service_fee - COALESCE(discount,0)),1) * 100, 2) as margin_pct
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND ${df}
       GROUP BY DATE(created_at) ORDER BY date`, [t, ...dp]
    );

    return res.json({
      success: true,
      data: {
        overall_margin_pct: gross > 0 ? ((platformIncome / gross) * 100).toFixed(2) : 0,
        platform_income: platformIncome,
        gross_revenue: parseFloat(overall.net_revenue),
        order_count: parseInt(overall.order_count),
        avg_margin_per_order: overall.order_count > 0 ? (platformIncome / parseInt(overall.order_count)).toFixed(2) : 0,
        daily_margin: byDay
      }
    });
  } catch (err) {
    console.error('Margin analysis error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate margin analysis' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #98 — FINANCIAL FORECASTING
// ═══════════════════════════════════════════════════════════════

router.get('/forecast', authMiddleware, async (req, res) => {
  try {
    const { forecast_days = 30 } = req.query;
    const t = req.workshopId;
    const days = Math.min(parseInt(forecast_days) || 30, 90);

    // Get last 90 days of data for trend analysis
    const history = await query(
      `SELECT DATE(created_at) as date,
         COUNT(*) as orders,
         COALESCE(SUM(service_fee - COALESCE(discount,0)), 0) as revenue,
         COALESCE(SUM(commission_amount + COALESCE(platform_fee,0)), 0) as platform_income
       FROM work_orders WHERE workshop_id = ? AND status = 'completed'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
       GROUP BY DATE(created_at) ORDER BY date`, [t]
    );

    if (history.length < 7) {
      return res.json({ success: true, data: { message: 'Not enough data for forecasting (need at least 7 days)', forecast: [] } });
    }

    // Simple linear regression for forecasting
    const n = history.length;
    const sumX = history.reduce((s, _, i) => s + i, 0);
    const sumY = history.reduce((s, h) => s + parseFloat(h.revenue), 0);
    const sumXY = history.reduce((s, h, i) => s + i * parseFloat(h.revenue), 0);
    const sumX2 = history.reduce((s, _, i) => s + i * i, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const avgOrders = sumY > 0 ? history.reduce((s, h) => s + parseInt(h.orders), 0) / n : 0;
    const avgPlatformRatio = sumY > 0 ? history.reduce((s, h) => s + parseFloat(h.platform_income), 0) / sumY : 0;

    const forecast = [];
    for (let i = 0; i < days; i++) {
      const dayIndex = n + i;
      const forecastedRevenue = Math.max(0, intercept + slope * dayIndex);
      const d = new Date();
      d.setDate(d.getDate() + i + 1);
      forecast.push({
        date: d.toISOString().split('T')[0],
        projected_revenue: Math.round(forecastedRevenue * 100) / 100,
        projected_orders: Math.round(avgOrders),
        projected_platform_income: Math.round(forecastedRevenue * avgPlatformRatio * 100) / 100
      });
    }

    const total_projected = forecast.reduce((s, f) => s + f.projected_revenue, 0);
    const trend = slope > 0 ? 'growing' : slope < -0.1 ? 'declining' : 'stable';

    return res.json({
      success: true,
      data: {
        trend,
        daily_growth_rate: ((slope / (intercept || 1)) * 100).toFixed(2),
        forecast_period_days: days,
        total_projected_revenue: Math.round(total_projected * 100) / 100,
        total_projected_platform_income: Math.round(total_projected * avgPlatformRatio * 100) / 100,
        forecast,
        historical_avg_daily_revenue: Math.round((sumY / n) * 100) / 100
      }
    });
  } catch (err) {
    console.error('Forecast error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate forecast' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #99 — AI-DRIVEN REVENUE INSIGHTS
// ═══════════════════════════════════════════════════════════════

router.get('/insights', authMiddleware, async (req, res) => {
  try {
    const t = req.workshopId;
    const insights = [];

    // Insight 1: Revenue trend (last 30 vs previous 30)
    const [current] = await query(
      `SELECT COALESCE(SUM(service_fee - COALESCE(discount,0)), 0) as rev, COUNT(*) as cnt
       FROM work_orders WHERE workshop_id = ? AND status = 'completed'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [t]
    );
    const [previous] = await query(
      `SELECT COALESCE(SUM(service_fee - COALESCE(discount,0)), 0) as rev, COUNT(*) as cnt
       FROM work_orders WHERE workshop_id = ? AND status = 'completed'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 60 DAY)
       AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`, [t]
    );
    const revChange = previous.rev > 0 ? ((current.rev - previous.rev) / previous.rev * 100).toFixed(1) : 0;
    if (revChange > 10) insights.push({ type: 'positive', category: 'revenue', title: 'Revenue Growing', message: `Revenue increased ${revChange}% vs previous period`, metric: revChange + '%' });
    else if (revChange < -10) insights.push({ type: 'warning', category: 'revenue', title: 'Revenue Declining', message: `Revenue decreased ${Math.abs(revChange)}% vs previous period. Consider promotions.`, metric: revChange + '%' });
    else insights.push({ type: 'info', category: 'revenue', title: 'Revenue Stable', message: `Revenue is stable (${revChange}% change)`, metric: revChange + '%' });

    // Insight 2: Top customer concentration risk
    const topCustomers = await query(
      `SELECT c.full_name, COUNT(*) as orders, SUM(service_fee) as rev
       FROM work_orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.workshop_id = ? AND o.status = 'completed' AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY c.id ORDER BY rev DESC LIMIT 5`, [t]
    );
    if (topCustomers.length > 0 && current.rev > 0) {
      const topRev = parseFloat(topCustomers[0].rev);
      const concentration = (topRev / parseFloat(current.rev) * 100).toFixed(1);
      if (concentration > 50) insights.push({ type: 'warning', category: 'risk', title: 'High Revenue Concentration', message: `${topCustomers[0].full_name} accounts for ${concentration}% of revenue. Diversify customer base.`, metric: concentration + '%' });
    }

    // Insight 3: Failed work order rate
    const [failed] = await query(
      `SELECT COUNT(*) as cnt FROM work_orders WHERE workshop_id = ? AND status = 'cancelled'
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [t]
    );
    if (current.cnt > 0) {
      const failRate = (failed.cnt / (parseInt(current.cnt) + failed.cnt) * 100).toFixed(1);
      if (failRate > 15) insights.push({ type: 'critical', category: 'operations', title: 'High Failure Rate', message: `${failRate}% work order failure rate. Investigate mechanic scheduling or parts issues.`, metric: failRate + '%' });
      else if (failRate > 5) insights.push({ type: 'warning', category: 'operations', title: 'Moderate Failure Rate', message: `${failRate}% failure rate. Room for improvement.`, metric: failRate + '%' });
    }

    // Insight 4: Cash payment collection efficiency
    const [cashPending] = await query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(cash_amount), 0) as amount
       FROM work_orders WHERE workshop_id = ? AND payment_method = 'cash'
       AND status = 'completed' AND (cash_collected IS NULL OR cash_collected = 0)
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [t]
    );
    if (cashPending.cnt > 0) {
      insights.push({ type: 'warning', category: 'collections', title: 'Uncollected Cash Payments', message: `${cashPending.cnt} work orders with uncollected cash payment (${cashPending.amount} total). Follow up with mechanics.`, metric: cashPending.amount.toString() });
    }

    // Insight 5: Average order value trend
    const avgCurrent = current.cnt > 0 ? (current.rev / current.cnt).toFixed(2) : 0;
    const avgPrevious = previous.cnt > 0 ? (previous.rev / previous.cnt).toFixed(2) : 0;
    if (avgPrevious > 0 && avgCurrent < avgPrevious * 0.8) {
      insights.push({ type: 'warning', category: 'pricing', title: 'Declining Order Value', message: `Average work order value dropped from ${avgPrevious} to ${avgCurrent}. Review pricing strategy.`, metric: avgCurrent });
    }

    return res.json({ success: true, data: { insights, period: 'last_30_days', generated_at: new Date().toISOString() } });
  } catch (err) {
    console.error('Insights error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate insights' });
  }
});

export default router;
