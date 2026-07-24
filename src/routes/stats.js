import express from 'express';
import { query } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// GET /api/stats — car workshop platform KPIs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const workshopId = req.workshopId;
    const today = new Date().toISOString().slice(0, 10);

    // Work orders today
    const [workOrdersToday] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND DATE(created_at) = CURDATE()",
      [workshopId]
    );
    // Active work orders (in progress)
    const [activeWorkOrders] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status IN ('assigned','accepted','in_progress','ready_for_pickup')",
      [workshopId]
    );
    // Completed today
    const [completedToday] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND DATE(completed_at) = CURDATE()",
      [workshopId]
    );
    // Pending
    const [pendingWorkOrders] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status IN ('pending','confirmed')",
      [workshopId]
    );
    // Failed today
    const [failedToday] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status = 'failed' AND DATE(failed_at) = CURDATE()",
      [workshopId]
    );
    // Total revenue today (completed work orders)
    const [revenueToday] = await query(
      "SELECT COALESCE(SUM(service_fee - discount), 0) as total FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND DATE(completed_at) = CURDATE()",
      [workshopId]
    );
    // Revenue this month
    const [revenueMonth] = await query(
      "SELECT COALESCE(SUM(service_fee - discount), 0) as total FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND MONTH(completed_at) = MONTH(CURDATE()) AND YEAR(completed_at) = YEAR(CURDATE())",
      [workshopId]
    );
    // Available mechanics
    const [availableMechanics] = await query(
      "SELECT COUNT(*) as count FROM mechanics WHERE workshop_id = ? AND status = 'available' AND is_active = TRUE",
      [workshopId]
    );
    // Total active mechanics
    const [totalMechanics] = await query(
      "SELECT COUNT(*) as count FROM mechanics WHERE workshop_id = ? AND is_active = TRUE",
      [workshopId]
    );
    // Mechanic utilization (#52)
    const mechanicUtilization = await query(
      `SELECT status, COUNT(*) as count FROM mechanics WHERE workshop_id = ? AND is_active = TRUE GROUP BY status`,
      [workshopId]
    );
    // Work orders per mechanic today (workload balance)
    const mechanicWorkload = await query(
      `SELECT m.id, m.full_name, m.status as mechanic_status, COUNT(o.id) as work_orders_today
       FROM mechanics m LEFT JOIN work_orders o ON o.mechanic_id = m.id AND DATE(o.created_at) = CURDATE() AND o.workshop_id = ?
       WHERE m.workshop_id = ? AND m.is_active = TRUE
       GROUP BY m.id ORDER BY work_orders_today DESC LIMIT 10`,
      [workshopId, workshopId]
    );
    // Work orders last 7 days (chart data)
    const workOrdersChart = await query(
      `SELECT DATE(created_at) as date, COUNT(*) as total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM work_orders WHERE workshop_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at) ORDER BY date`,
      [workshopId]
    );
    // Work orders by status
    const workOrdersByStatus = await query(
      "SELECT status, COUNT(*) as count FROM work_orders WHERE workshop_id = ? GROUP BY status",
      [workshopId]
    );
    // Top service bays — show all active bays, LEFT JOIN so bays with 0 work orders still appear
    const topServiceBays = await query(
      `SELECT z.name, z.emirate, z.base_service_fee, z.radius,
              COUNT(o.id) as work_orders
       FROM service_bays z
       LEFT JOIN work_orders o ON o.service_bay_id = z.id AND o.workshop_id = z.workshop_id
       WHERE z.workshop_id = ? AND z.is_active = 1
       GROUP BY z.id ORDER BY work_orders DESC, z.name ASC LIMIT 5`,
      [workshopId]
    );
    // Top mechanics this month
    const topMechanics = await query(
      `SELECT m.full_name, COUNT(o.id) as jobs_completed
       FROM work_orders o JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND o.status = 'completed'
       AND MONTH(o.completed_at) = MONTH(CURDATE())
       GROUP BY m.id ORDER BY jobs_completed DESC LIMIT 5`,
      [workshopId]
    );
    // Recent work orders
    const recentWorkOrders = await query(
      `SELECT o.id, o.work_order_number, o.status, o.customer_name, o.customer_emirate,
              o.service_fee, o.created_at, m.full_name as mechanic_name
       FROM work_orders o LEFT JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? ORDER BY o.created_at DESC LIMIT 10`,
      [workshopId]
    );

    // ── Average service time today (minutes) ──
    const [avgServiceTime] = await query(
      `SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, completed_at)) as avg_minutes
       FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND DATE(completed_at) = CURDATE()`,
      [workshopId]
    );

    // ── Cash payment stats ──
    const [cashOutstanding] = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(cash_amount),0) as total
       FROM work_orders WHERE workshop_id = ? AND payment_method = 'cash'
       AND status IN ('completed','in_progress','assigned','accepted','ready_for_pickup')
       AND (cash_collected = FALSE OR cash_collected IS NULL)`,
      [workshopId]
    );
    const [cashSettledToday] = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(cash_amount),0) as total
       FROM work_orders WHERE workshop_id = ? AND payment_method = 'cash'
       AND cash_collected = TRUE AND DATE(updated_at) = CURDATE()`,
      [workshopId]
    );
    const [cashTotal] = await query(
      `SELECT COALESCE(SUM(cash_amount),0) as total
       FROM work_orders WHERE workshop_id = ? AND payment_method = 'cash'
       AND status = 'completed' AND MONTH(completed_at) = MONTH(CURDATE())
       AND YEAR(completed_at) = YEAR(CURDATE())`,
      [workshopId]
    );

    // ── Previous period comparisons (yesterday) ──
    const [workOrdersYesterday] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
      [workshopId]
    );
    const [completedYesterday] = await query(
      "SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND DATE(completed_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
      [workshopId]
    );
    const [revenueYesterday] = await query(
      "SELECT COALESCE(SUM(service_fee - discount), 0) as total FROM work_orders WHERE workshop_id = ? AND status = 'completed' AND DATE(completed_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
      [workshopId]
    );

    // ── Work orders by hour (today's activity pattern) (#56) ──
    const workOrdersByHour = await query(
      `SELECT HOUR(created_at) as hour,
              COUNT(*) as work_orders,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
       FROM work_orders WHERE workshop_id = ? AND DATE(created_at) = CURDATE()
       GROUP BY HOUR(created_at) ORDER BY hour`,
      [workshopId]
    );
    // Fill all 24 hours
    const hourlyData = Array.from({ length: 24 }, (_, h) => {
      const row = workOrdersByHour.find(r => r.hour === h);
      return { hour: h, label: `${h.toString().padStart(2,'0')}:00`, orders: row?.work_orders || 0, delivered: row?.completed || 0 };
    });

    // Compute success rate
    const ot = workOrdersToday.count || 0;
    const dt = completedToday.count || 0;
    const successRate = ot > 0 ? Math.round((dt / ot) * 100) : 0;

    // Compute deltas
    const oy = workOrdersYesterday.count || 0;
    const dy = completedYesterday.count || 0;
    const ry = parseFloat(revenueYesterday.total) || 0;
    const calcDelta = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : (curr > 0 ? 100 : 0);

    // Map work_orders_chart → daily_chart with `orders` field name frontend expects
    // Fill all 7 days so the chart always shows a complete week
    const dailyChart = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));          // -6 … 0
      const iso = d.toISOString().slice(0, 10);   // YYYY-MM-DD
      const row = workOrdersChart.find(r => {
        const rd = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        return rd === iso;
      });
      return {
        date: iso,
        orders: row ? (row.total || 0) : 0,
        delivered: row ? (row.completed || 0) : 0,
        failed: row ? (row.failed || 0) : 0,
      };
    });

    return res.json({
      success: true,
      data: {
        // ── Flat KPI object the Dashboard frontend expects ──
        kpis: {
          orders_today: ot,
          active_orders: activeWorkOrders.count || 0,
          delivered_today: dt,
          pending_orders: pendingWorkOrders.count || 0,
          failed_today: failedToday.count || 0,
          success_rate: successRate,
          revenue_today: parseFloat(revenueToday.total) || 0,
          revenue_month: parseFloat(revenueMonth.total) || 0,
          available_drivers: availableMechanics.count || 0,
          total_drivers: totalMechanics.count || 0,
          avg_delivery_minutes: Math.round(avgServiceTime.avg_minutes || 0),
          // Cash payment stats
          cod_outstanding: parseFloat(cashOutstanding.total) || 0,
          cod_outstanding_count: cashOutstanding.count || 0,
          cod_settled_today: parseFloat(cashSettledToday.total) || 0,
          cod_settled_today_count: cashSettledToday.count || 0,
          cod_month_total: parseFloat(cashTotal.total) || 0,
          // Yesterday comparisons
          orders_yesterday: oy,
          delivered_yesterday: dy,
          revenue_yesterday: ry,
          delta_orders: calcDelta(ot, oy),
          delta_delivered: calcDelta(dt, dy),
          delta_revenue: calcDelta(parseFloat(revenueToday.total) || 0, ry),
        },
        daily_chart: dailyChart,
        orders_by_status: workOrdersByStatus,
        top_zones: topServiceBays,
        top_mechanics: topMechanics,
        recent_orders: recentWorkOrders,
        mechanic_utilization: mechanicUtilization,
        mechanic_workload: mechanicWorkload,
        orders_by_hour: hourlyData,
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

export default router;
