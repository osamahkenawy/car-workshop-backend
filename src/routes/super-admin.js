import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';
import { sendNotificationEmail, sendEmail, getLogoCidAttachment, buildEmailTemplate, getWorkshopBranding } from '../lib/email.js';
import { superAdminLoginLimiter } from '../lib/rate-limits.js';

const router = express.Router();

// Default modules every workshop gets when none are explicitly configured
const DEFAULT_MODULE_IDS = [
  'dashboard', 'work-orders', 'job-assignment', 'mechanics', 'customers', 'live-map',
  'service-status', 'bulk-import', 'warranty-claims', 'wallet', 'invoices',
  'cash-payment', 'reports', 'performance', 'service-bays', 'pricing', 'notifications',
  'settings', 'integrations', 'barcode', 'mechanic-scan', 'mechanic-dashboard',
  'my-jobs'
];

// Middleware to verify super admin token
const verifySuperAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied. Super admin only.' });
    }

    const admins = await query(
      'SELECT id, username, email, full_name, role, permissions FROM super_admins WHERE id = ? AND is_active = 1',
      [decoded.id]
    );

    if (!admins || admins.length === 0) {
      return res.status(401).json({ error: 'Super admin not found or inactive.' });
    }

    req.superAdmin = admins[0];
    next();
  } catch (error) {
    console.error('Super admin auth error:', error);
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// Super Admin Login
router.post('/login', superAdminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    const admins = await query(
      'SELECT * FROM super_admins WHERE (username = ? OR email = ?) AND is_active = 1',
      [username, username]
    );

    if (!admins || admins.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = admins[0];
    const validPassword = await bcrypt.compare(password, admin.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await execute('UPDATE super_admins SET last_login = NOW() WHERE id = ?', [admin.id]);

    const token = jwt.sign(
      { id: admin.id, username: admin.username, type: 'super_admin', role: admin.role },
      config.jwt.secret,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        type: 'super_admin'
      }
    });
  } catch (error) {
    console.error('Super admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current super admin session
router.get('/session', verifySuperAdmin, (req, res) => {
  res.json({ user: { ...req.superAdmin, type: 'super_admin' } });
});

// Global search across workshops, users, tickets
router.get('/search', verifySuperAdmin, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ workshops: [], users: [], tickets: [] });

    const term = `%${q}%`;

    const [workshops, users, tickets] = await Promise.all([
      query(
        `SELECT id, name, email, status, industry FROM workshops WHERE name LIKE ? OR email LIKE ? LIMIT 5`,
        [term, term]
      ),
      query(
        `SELECT id, full_name, email, username, role, workshop_id FROM users WHERE full_name LIKE ? OR email LIKE ? OR username LIKE ? LIMIT 5`,
        [term, term, term]
      ),
      query(
        `SELECT id, subject, status, priority, workshop_name FROM support_tickets WHERE subject LIKE ? OR workshop_name LIKE ? LIMIT 5`,
        [term, term]
      ).catch(() => [])
    ]);

    res.json({ workshops: workshops || [], users: users || [], tickets: tickets || [] });
  } catch (error) {
    console.error('Search error:', error);
    res.json({ workshops: [], users: [], tickets: [] });
  }
});

// ═══════════════════════════════════════════════════════════
//  DASHBOARD — aggregated data for the executive dashboard
// ═══════════════════════════════════════════════════════════
router.get('/dashboard', verifySuperAdmin, async (req, res) => {
  try {
    // ── KPI stats ──
    const workshopStats = await query(`
      SELECT
        COUNT(*) as total_workshops,
        SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) as active_workshops,
        SUM(CASE WHEN t.status = 'trial' OR EXISTS (
          SELECT 1 FROM subscriptions s2 WHERE s2.workshop_id = t.id AND s2.status = 'trialing' AND s2.trial_end > NOW()
        ) THEN 1 ELSE 0 END) as trial_workshops,
        SUM(CASE WHEN t.status = 'suspended' THEN 1 ELSE 0 END) as suspended_workshops
      FROM workshops t
    `);
    const userStats = await query(`SELECT COUNT(*) as total_users FROM users WHERE is_active = 1`);
    const workOrderStats = await query(`
      SELECT COUNT(*) as total_work_orders, COALESCE(SUM(total_amount), 0) as total_revenue
      FROM work_orders
    `);

    // MRR
    let mrr = 0;
    try {
      const mrrResult = await query(`
        SELECT COALESCE(SUM(
          CASE WHEN s.billing_cycle = 'yearly' THEN p.price_aed / 12
               ELSE COALESCE(p.price_aed, 0) END
        ), 0) as mrr
        FROM subscriptions s
        LEFT JOIN plans p ON s.plan = p.slug
        WHERE s.status = 'active'
      `);
      mrr = mrrResult[0]?.mrr || 0;
    } catch (_) {}

    // Previous-period comparison (30 days ago vs 60 days ago)
    let prevWorkshops = 0, prevUsers = 0, prevWorkOrders = 0, prevMrr = 0;
    try {
      const pt = await query(`SELECT COUNT(*) as c FROM workshops WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
      const curT = workshopStats[0]?.total_workshops || 0;
      prevWorkshops = pt[0]?.c || 0;
      const pu = await query(`SELECT COUNT(*) as c FROM users WHERE is_active = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
      prevUsers = pu[0]?.c || 0;
      const po = await query(`SELECT COUNT(*) as c FROM work_orders WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`);
      prevWorkOrders = po[0]?.c || 0;
    } catch (_) {}

    const calcGrowth = (current, prev) => {
      if (!prev || prev === 0) return current > 0 ? 100 : 0;
      return Number(((current - prev) / prev * 100).toFixed(1));
    };

    const kpi = {
      total_workshops: workshopStats[0]?.total_workshops || 0,
      active_workshops: workshopStats[0]?.active_workshops || 0,
      trial_workshops: workshopStats[0]?.trial_workshops || 0,
      suspended_workshops: workshopStats[0]?.suspended_workshops || 0,
      total_users: userStats[0]?.total_users || 0,
      total_work_orders: workOrderStats[0]?.total_work_orders || 0,
      mrr: Number(mrr) || 0,
      workshop_growth: calcGrowth(workshopStats[0]?.total_workshops || 0, prevWorkshops),
      user_growth: calcGrowth(userStats[0]?.total_users || 0, prevUsers),
      work_order_growth: calcGrowth(workOrderStats[0]?.total_work_orders || 0, prevWorkOrders),
    };

    // ── Revenue by month (last 6 months) ──
    let revenueByMonth = [];
    try {
      revenueByMonth = await query(`
        SELECT DATE_FORMAT(created_at, '%Y-%m') as month,
               COALESCE(SUM(total_amount), 0) as revenue,
               COUNT(*) as work_orders
        FROM work_orders
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY month ASC
      `);
    } catch (_) {}

    // ── Workshop growth by month (new signups per month, last 6 months) ──
    let workshopGrowthByMonth = [];
    try {
      workshopGrowthByMonth = await query(`
        SELECT DATE_FORMAT(created_at, '%Y-%m') as month,
               COUNT(*) as new_workshops
        FROM workshops
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
        ORDER BY month ASC
      `);
    } catch (_) {}

    // ── Plan distribution ──
    let planDistribution = [];
    try {
      planDistribution = await query(`
        SELECT COALESCE(s.plan, 'none') as plan_name, COUNT(*) as count
        FROM workshops t
        LEFT JOIN subscriptions s ON s.workshop_id = t.id AND s.status = 'active'
        GROUP BY s.plan
        ORDER BY count DESC
      `);
    } catch (_) {}

    // ── Recent activity (last 20 entries from audit_logs) ──
    let recentActivity = [];
    try {
      recentActivity = await query(`
        SELECT al.id, al.action, al.details, al.created_at,
               u.full_name as user_name, t.name as workshop_name
        FROM audit_logs al
        LEFT JOIN users u ON al.user_id = u.id
        LEFT JOIN workshops t ON al.workshop_id = t.id
        ORDER BY al.created_at DESC
        LIMIT 15
      `);
    } catch (_) {}

    // Fill with recent workshop signups if no audit logs
    if (!recentActivity || recentActivity.length === 0) {
      try {
        const recent = await query(`
          SELECT id, name, email, status, created_at FROM workshops ORDER BY created_at DESC LIMIT 10
        `);
        recentActivity = (recent || []).map(t => ({
          id: t.id,
          action: 'workshop_signup',
          details: `${t.name} signed up`,
          created_at: t.created_at,
          user_name: t.name,
          workshop_name: t.name
        }));
      } catch (_) {}
    }

    // ── Alerts ──
    let alerts = [];
    try {
      // Expiring trials (within 7 days)
      const expiringTrials = await query(`
        SELECT id, name, trial_end FROM workshops
        WHERE status = 'trial' AND trial_end IS NOT NULL
          AND trial_end BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
        ORDER BY trial_end ASC LIMIT 5
      `);
      (expiringTrials || []).forEach(t => {
        alerts.push({ type: 'warning', title: 'Trial Expiring', message: `${t.name} trial ends ${t.trial_end}`, link: `/super-admin/workshops/${t.id}` });
      });

      // Pending tickets
      const pendingTickets = await query(`
        SELECT COUNT(*) as c FROM support_tickets WHERE status IN ('open', 'pending')
      `).catch(() => [{ c: 0 }]);
      const ticketCount = pendingTickets[0]?.c || 0;
      if (ticketCount > 0) {
        alerts.push({ type: 'info', title: 'Pending Tickets', message: `${ticketCount} ticket${ticketCount > 1 ? 's' : ''} awaiting response`, link: '/super-admin/tickets' });
      }

      // Suspended workshops
      const suspended = workshopStats[0]?.suspended_workshops || 0;
      if (suspended > 0) {
        alerts.push({ type: 'danger', title: 'Suspended Workshops', message: `${suspended} workshop${suspended > 1 ? 's' : ''} currently suspended`, link: '/super-admin/workshops?status=suspended' });
      }
    } catch (_) {}

    // ── Top performing workshops ──
    let topWorkshops = [];
    try {
      topWorkshops = await query(`
        SELECT t.id, t.name, t.status,
          COUNT(o.id) as work_order_count,
          COALESCE(SUM(o.total_amount), 0) as revenue,
          (SELECT COUNT(*) FROM users WHERE workshop_id = t.id AND is_active = 1) as users
        FROM workshops t
        LEFT JOIN work_orders o ON o.workshop_id = t.id
        GROUP BY t.id
        ORDER BY work_order_count DESC
        LIMIT 5
      `);
    } catch (_) {}

    // ── Recent workshops (for card grid) ──
    const recentWorkshops = await query(`
      SELECT t.id, t.name, t.email, t.industry, t.status, t.created_at,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id) as user_count,
        (SELECT plan FROM subscriptions WHERE workshop_id = t.id ORDER BY id DESC LIMIT 1) as plan
      FROM workshops t
      ORDER BY t.created_at DESC
      LIMIT 6
    `);

    res.json({
      kpi,
      revenueByMonth: revenueByMonth || [],
      workshopGrowthByMonth: workshopGrowthByMonth || [],
      planDistribution: planDistribution || [],
      recentActivity: recentActivity || [],
      alerts: alerts || [],
      topWorkshops: topWorkshops || [],
      recentWorkshops: recentWorkshops || []
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get platform statistics
router.get('/stats', verifySuperAdmin, async (req, res) => {
  try {
    const workshopStats = await query(`
      SELECT
        COUNT(*) as total_workshops,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_workshops,
        SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) as trial_workshops,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended_workshops
      FROM workshops
    `);

    const userStats = await query(`
      SELECT COUNT(*) as total_users FROM users WHERE is_active = 1
    `);
    const workOrderStats = await query(`
      SELECT COUNT(*) as total_work_orders FROM work_orders
    `);

    // Monthly recurring revenue from active subscriptions
    let mrr = 0;
    try {
      const mrrResult = await query(`
        SELECT COALESCE(SUM(
          CASE WHEN s.billing_cycle = 'yearly' THEN p.price_aed / 12
               ELSE COALESCE(p.price_aed, 0)
          END
        ), 0) as mrr
        FROM subscriptions s
        LEFT JOIN plans p ON s.plan = p.slug
        WHERE s.status = 'active'
      `);
      mrr = mrrResult[0]?.mrr || 0;
    } catch (_) {}

    // Trial conversion rate: workshops that were trial and converted to active
    let trialConversion = 0;
    try {
      const totalTrialEver = await query(`
        SELECT COUNT(*) as c FROM workshops WHERE status IN ('active', 'trial') OR trial_ends_at IS NOT NULL
      `);
      const converted = await query(`
        SELECT COUNT(*) as c FROM workshops WHERE status = 'active' AND trial_ends_at IS NOT NULL
      `);
      const totalTrial = totalTrialEver[0]?.c || 0;
      trialConversion = totalTrial > 0 ? ((converted[0]?.c || 0) / totalTrial * 100) : 0;
    } catch (_) {}

    const recentWorkshops = await query(`
      SELECT id, name, email, industry, status, created_at
      FROM workshops
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({
      stats: {
        ...(workshopStats[0] || {}),
        total_users: userStats[0]?.total_users || 0,
        total_work_orders: workOrderStats[0]?.total_work_orders || 0,
        mrr: Number(mrr) || 0,
        trial_conversion: Number(trialConversion.toFixed(1)) || 0
      },
      recentWorkshops: recentWorkshops || []
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all workshops
router.get('/workshops', verifySuperAdmin, async (req, res) => {
  try {
    const { status, search, q, page = 1, limit = 20, sort_by = 'created_at', sort_dir = 'desc' } = req.query;
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
    const offset = (pg - 1) * lim;
    const searchTerm = q || search;

    // Whitelisted sort columns to prevent SQL injection
    const sortColumnMap = {
      created_at: 't.created_at',
      name: 't.name',
      status: 't.status',
      updated_at: 't.updated_at',
    };
    const sortCol = sortColumnMap[sort_by] || 't.created_at';
    const sortOrder = String(sort_dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Latest subscription per workshop via correlated subquery (matches existing data pattern)
    const baseSelect = `
      SELECT t.*,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id AND role != 'mechanic') as user_count,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id AND role != 'mechanic' AND is_active = 1) as active_users,
        (SELECT COUNT(*) FROM mechanics WHERE workshop_id = t.id) as mechanic_count,
        s.id AS subscription_id,
        s.plan AS plan,
        s.status AS subscription_status,
        s.billing_cycle,
        s.max_users,
        s.price_monthly,
        s.price_yearly,
        s.current_period_end,
        s.trial_end AS sub_trial_end,
        s.stripe_customer_id,
        s.stripe_subscription_id,
        s.cancel_at_period_end,
        s.cancel_at,
        DATEDIFF(NOW(), s.current_period_end) AS days_past_due
      FROM workshops t
      LEFT JOIN subscriptions s
        ON s.id = (SELECT id FROM subscriptions WHERE workshop_id = t.id ORDER BY id DESC LIMIT 1)
      WHERE 1=1
    `;

    let sql = baseSelect;
    const params = [];

    // status param accepts CSV like "trial,trial_expired"
    // Special virtual statuses: "past_due" (subscription_status = 'past_due')
    if (status && status !== 'all') {
      const wanted = String(status).split(',').map(s => s.trim()).filter(Boolean);
      const workshopStatuses = wanted.filter(s => s !== 'past_due');
      const wantsPastDue = wanted.includes('past_due');
      const orParts = [];
      if (workshopStatuses.length) {
        orParts.push(`t.status IN (${workshopStatuses.map(() => '?').join(',')})`);
        params.push(...workshopStatuses);
      }
      if (wantsPastDue) orParts.push(`s.status = 'past_due'`);
      if (orParts.length) sql += ' AND (' + orParts.join(' OR ') + ')';
    }

    if (searchTerm) {
      sql += ' AND (t.name LIKE ? OR t.email LIKE ? OR t.slug LIKE ? OR t.subdomain LIKE ? OR t.domain LIKE ?)';
      const like = `%${searchTerm}%`;
      params.push(like, like, like, like, like);
    }

    sql += ` ORDER BY ${sortCol} ${sortOrder} LIMIT ${lim} OFFSET ${offset}`;
    const workshops = await query(sql, params);

    // Build the same WHERE clause for COUNT
    let countSql = `
      SELECT COUNT(*) AS total
      FROM workshops t
      LEFT JOIN subscriptions s
        ON s.id = (SELECT id FROM subscriptions WHERE workshop_id = t.id ORDER BY id DESC LIMIT 1)
      WHERE 1=1
    `;
    const countParams = [];
    if (status && status !== 'all') {
      const wanted = String(status).split(',').map(s => s.trim()).filter(Boolean);
      const workshopStatuses = wanted.filter(s => s !== 'past_due');
      const wantsPastDue = wanted.includes('past_due');
      const orParts = [];
      if (workshopStatuses.length) {
        orParts.push(`t.status IN (${workshopStatuses.map(() => '?').join(',')})`);
        countParams.push(...workshopStatuses);
      }
      if (wantsPastDue) orParts.push(`s.status = 'past_due'`);
      if (orParts.length) countSql += ' AND (' + orParts.join(' OR ') + ')';
    }
    if (searchTerm) {
      countSql += ' AND (t.name LIKE ? OR t.email LIKE ? OR t.slug LIKE ? OR t.subdomain LIKE ? OR t.domain LIKE ?)';
      const like = `%${searchTerm}%`;
      countParams.push(like, like, like, like, like);
    }
    const [countRow] = await query(countSql, countParams);

    // Aggregate counts across ALL workshops (independent of filters/pagination) — used for status chips
    const statRows = await query(`
      SELECT
        COUNT(*) AS total,
        SUM(t.status = 'active') AS active,
        SUM(t.status = 'trial') AS trial,
        SUM(t.status = 'trial_expired') AS trial_expired,
        SUM(t.status = 'suspended') AS suspended,
        SUM(t.status = 'cancelled') AS cancelled,
        (SELECT COUNT(DISTINCT workshop_id) FROM subscriptions WHERE status = 'past_due') AS past_due
      FROM workshops t
    `);
    const s = statRows[0] || {};
    const stats = {
      total: Number(s.total || 0),
      active: Number(s.active || 0),
      trial: Number(s.trial || 0),
      trial_expired: Number(s.trial_expired || 0),
      suspended: Number(s.suspended || 0),
      cancelled: Number(s.cancelled || 0),
      past_due: Number(s.past_due || 0),
    };

    const workshopsWithModules = (workshops || []).map(t => {
      let settings = t.settings || {};
      if (typeof settings === 'string') {
        try { settings = JSON.parse(settings); } catch (e) { settings = {}; }
      }
      const allowedModules = settings.allowed_modules || DEFAULT_MODULE_IDS;
      // Surface a single "effective_status" so the UI can distinguish past_due workshops
      // (whose workshops.status is still 'active') from healthy ones.
      let effective_status = t.status;
      if (t.subscription_status === 'past_due' && t.status === 'active') effective_status = 'past_due';
      return {
        ...t,
        allowed_modules: allowedModules,
        module_count: allowedModules.length,
        user_count: (t.user_count || 0) + (t.mechanic_count || 0),
        effective_status,
        settings,
      };
    });

    res.json({
      workshops: workshopsWithModules,
      stats,
      pagination: {
        page: pg,
        limit: lim,
        total: Number(countRow?.total || 0),
        total_pages: Math.max(1, Math.ceil(Number(countRow?.total || 0) / lim)),
      }
    });
  } catch (error) {
    console.error('Get workshops error:', error);
    res.status(500).json({ error: 'Failed to fetch workshops' });
  }
});

// Get single workshop
router.get('/workshops/:id', verifySuperAdmin, async (req, res) => {
  try {
    const workshops = await query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id) as user_count,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id AND is_active = 1) as active_users
      FROM workshops t WHERE t.id = ?`,
      [req.params.id]
    );

    if (!workshops || workshops.length === 0) {
      return res.status(404).json({ error: 'Workshop not found' });
    }

    const users = await query(
      'SELECT id, username, email, full_name, role, is_active, last_login_at, created_at FROM users WHERE workshop_id = ?',
      [req.params.id]
    );

    const subscription = await query(
      'SELECT * FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
      [req.params.id]
    );

    // Parse settings JSON and expose allowed_modules at top level
    let tSettings = workshops[0].settings || {};
    if (typeof tSettings === 'string') {
      try { tSettings = JSON.parse(tSettings); } catch (e) { tSettings = {}; }
    }
    // If no modules explicitly set, default to all modules enabled
    const tAllowedModules = tSettings.allowed_modules || DEFAULT_MODULE_IDS;

    res.json({
      workshop: { ...workshops[0], allowed_modules: tAllowedModules, settings: tSettings, max_users: subscription?.[0]?.max_users || 10, plan: subscription?.[0]?.plan || 'trial' },
      users: users || [],
      subscription: subscription?.[0] || null
    });
  } catch (error) {
    console.error('Get workshop error:', error);
    res.status(500).json({ error: 'Failed to fetch workshop' });
  }
});

// Update workshop
router.put('/workshops/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { name, status, email, phone, city, country, industry, settings, max_users, allowed_modules } = req.body;

    // Update workshop record (only valid columns)
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email); }
    if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
    if (city !== undefined) { updates.push('city = ?'); params.push(city); }
    if (country !== undefined) { updates.push('country = ?'); params.push(country); }
    if (industry !== undefined) { updates.push('industry = ?'); params.push(industry); }

    // Store allowed_modules in settings JSON
    if (allowed_modules !== undefined || settings !== undefined) {
      const currentWorkshop = await query('SELECT settings FROM workshops WHERE id = ?', [req.params.id]);
      let currentSettings = currentWorkshop?.[0]?.settings || {};
      if (typeof currentSettings === 'string') currentSettings = JSON.parse(currentSettings);
      if (allowed_modules !== undefined) currentSettings.allowed_modules = allowed_modules;
      if (settings !== undefined) Object.assign(currentSettings, settings);
      updates.push('settings = ?');
      params.push(JSON.stringify(currentSettings));
    }

    if (updates.length > 0) {
      params.push(req.params.id);
      await execute(`UPDATE workshops SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    // Update max_users in subscriptions if provided
    if (max_users !== undefined) {
      const sub = await query('SELECT id FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);
      if (sub && sub.length > 0) {
        await execute('UPDATE subscriptions SET max_users = ? WHERE id = ?', [max_users, sub[0].id]);
      } else {
        await execute('INSERT INTO subscriptions (workshop_id, plan, status, max_users) VALUES (?, "starter", "active", ?)', [req.params.id, max_users]);
      }
    }

    const updated = await query('SELECT * FROM workshops WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    console.error('Update workshop error:', error);
    res.status(500).json({ error: 'Failed to update workshop' });
  }
});

// Activate/Deactivate workshop
router.post('/workshops/:id/toggle-status', verifySuperAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const workshopId = req.params.id;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be active or suspended' });
    }

    // Verify workshop exists
    const [workshop] = await query('SELECT id, status FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) return res.status(404).json({ success: false, error: 'Workshop not found' });

    await execute('UPDATE workshops SET status = ? WHERE id = ?', [status, workshopId]);

    if (status === 'suspended') {
      await execute('UPDATE users SET is_active = 0 WHERE workshop_id = ?', [workshopId]);
      // Also suspend their subscription
      await execute("UPDATE subscriptions SET status = 'suspended' WHERE workshop_id = ? AND status IN ('active','trialing')", [workshopId]);
    } else if (status === 'active') {
      await execute('UPDATE users SET is_active = 1 WHERE workshop_id = ?', [workshopId]);
      // Reactivate their subscription
      await execute("UPDATE subscriptions SET status = 'active' WHERE workshop_id = ? AND status = 'suspended'", [workshopId]);
    }

    console.log(`[SuperAdmin] Workshop ${workshopId} status → ${status}`);
    res.json({ success: true, message: `Workshop ${status === 'active' ? 'activated' : 'suspended'}` });
  } catch (error) {
    console.error('Toggle workshop status error:', error);
    res.status(500).json({ success: false, error: 'Failed to update workshop status' });
  }
});

/* ── Trial Management Endpoints (Scenario 8) ─────────────────── */

// POST /super-admin/workshops/:id/send-payment-reminder — manually email a past_due / trial_expired workshop
router.post('/workshops/:id/send-payment-reminder', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const [workshop] = await query(
      `SELECT t.id, t.name, t.email, t.status,
              s.status AS sub_status, s.plan, s.billing_cycle,
              s.price_monthly, s.price_yearly, s.current_period_end,
              GREATEST(DATEDIFF(NOW(), COALESCE(s.current_period_end, s.updated_at)), 1) AS days_past_due
       FROM workshops t
       LEFT JOIN subscriptions s
         ON s.id = (SELECT id FROM subscriptions WHERE workshop_id = t.id ORDER BY id DESC LIMIT 1)
       WHERE t.id = ?`,
      [workshopId]
    );
    if (!workshop) return res.status(404).json({ success: false, error: 'Workshop not found' });
    if (!workshop.email) return res.status(400).json({ success: false, error: 'Workshop has no email on file' });

    const planLabel = (workshop.plan || '').charAt(0).toUpperCase() + (workshop.plan || '').slice(1);
    const periodLabel = workshop.billing_cycle === 'yearly' ? 'annual' : 'monthly';
    const amount = workshop.billing_cycle === 'yearly' ? workshop.price_yearly : workshop.price_monthly;
    const daysPastDue = Number(workshop.days_past_due) || 0;

    const branding = await getWorkshopBranding(workshopId);
    const html = buildEmailTemplate(branding, `
      <h2 style="color:#dc2626;">Action Required: Update Your Payment</h2>
      <p>Hi <strong>${workshop.name}</strong>,</p>
      <p>This is a reminder from the Pioneer team — your ${workshop.sub_status === 'past_due' ? 'subscription payment has failed' : 'subscription needs attention'}.</p>
      ${workshop.plan ? `<p><strong>Plan:</strong> ${planLabel} (${periodLabel})${amount ? ` — <strong>AED ${Number(amount).toFixed(2)}</strong>` : ''}</p>` : ''}
      ${daysPastDue > 0 ? `<p><strong>Days past due:</strong> ${daysPastDue}</p>` : ''}
      <p>Please update your payment method to keep your account active:</p>
      <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Update Payment Method</a>
      <p style="margin-top:20px;color:#6b7280;">Need help? Contact us at info@pioneercarservice.com</p>
    `);
    await sendEmail({
      to: workshop.email,
      subject: `🔴 Action Required — Update your Pioneer payment (${workshop.name})`,
      html
    });
    console.log(`[SuperAdmin] Sent manual payment reminder to workshop ${workshopId} (${workshop.email})`);
    res.json({ success: true, message: `Reminder email sent to ${workshop.email}` });
  } catch (error) {
    console.error('Send payment reminder error:', error);
    res.status(500).json({ success: false, error: 'Failed to send reminder email' });
  }
});

// GET /super-admin/workshops/:id/billing-history
// Returns per-billing-period payment status (paid / unpaid / pending) for a workshop.
// Useful for older workshops to show "Month X — Paid on Y" or "Month X — Unpaid".
router.get('/workshops/:id/billing-history', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const [workshop] = await query(
      'SELECT id, name, currency, created_at FROM workshops WHERE id = ?',
      [workshopId]
    );
    if (!workshop) return res.status(404).json({ success: false, error: 'Workshop not found' });

    const [sub] = await query(
      `SELECT id, plan, billing_cycle, status, price_monthly, price_yearly,
              trial_end, current_period_start, current_period_end, created_at
       FROM subscriptions
       WHERE workshop_id = ?
       ORDER BY id DESC LIMIT 1`,
      [workshopId]
    );

    // Fetch all billing audit / invoice rows for this workshop
    const invoices = await query(
      `SELECT id, invoice_number, amount, currency, status,
              billing_period_start, billing_period_end, due_date, paid_at,
              payment_method, notes, created_at
       FROM platform_invoices
       WHERE workshop_id = ?
       ORDER BY COALESCE(billing_period_start, created_at) ASC`,
      [workshopId]
    );

    // Build expected billing periods from the moment paid billing started.
    // Anchor: trial_end (if exists) → falls back to subscription.created_at → workshop.created_at
    const cycle = (sub?.billing_cycle === 'yearly') ? 'yearly' : 'monthly';
    const unitPrice = cycle === 'yearly'
      ? Number(sub?.price_yearly || 0)
      : Number(sub?.price_monthly || 0);
    const currency = workshop.currency || 'AED';

    let anchor = sub?.trial_end ? new Date(sub.trial_end)
               : sub?.created_at ? new Date(sub.created_at)
               : new Date(workshop.created_at);
    // If anchor is in the future (e.g. trial still running), no billing periods yet
    const now = new Date();
    const periods = [];
    if (anchor && anchor <= now) {
      // Normalize to first day of period
      let cursor = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const endCap = new Date(now.getFullYear(), now.getMonth(), 1);
      let safety = 0;
      while (cursor <= endCap && safety < 240) { // cap 20 years
        const periodStart = new Date(cursor);
        const periodEnd = cycle === 'yearly'
          ? new Date(cursor.getFullYear() + 1, cursor.getMonth(), 0)
          : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);

        // Find a paid invoice whose period overlaps this window
        const matching = invoices.find(inv => {
          if (inv.status !== 'paid') return false;
          const ps = inv.billing_period_start ? new Date(inv.billing_period_start) : null;
          const pp = inv.paid_at ? new Date(inv.paid_at) : null;
          const ref = ps || pp;
          if (!ref) return false;
          return ref >= periodStart && ref <= periodEnd;
        });

        const isCurrent = (cursor.getFullYear() === now.getFullYear()
                        && cursor.getMonth() === now.getMonth());

        periods.push({
          period_start: periodStart.toISOString().slice(0, 10),
          period_end: periodEnd.toISOString().slice(0, 10),
          label: cycle === 'yearly'
            ? String(periodStart.getFullYear())
            : periodStart.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
          paid: !!matching,
          current: isCurrent,
          invoice: matching ? {
            id: matching.id,
            invoice_number: matching.invoice_number,
            amount: Number(matching.amount),
            currency: matching.currency,
            paid_at: matching.paid_at,
            payment_method: matching.payment_method,
          } : null,
          expected_amount: unitPrice || null,
          currency,
        });

        if (cycle === 'yearly') cursor = new Date(cursor.getFullYear() + 1, cursor.getMonth(), 1);
        else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        safety++;
      }
    }

    const totalPaid = invoices
      .filter(i => i.status === 'paid')
      .reduce((s, i) => s + Number(i.amount || 0), 0);
    const paidCount = periods.filter(p => p.paid).length;
    const unpaidCount = periods.filter(p => !p.paid && !p.current).length;

    return res.json({
      success: true,
      workshop: { id: workshop.id, name: workshop.name, currency },
      subscription: sub ? {
        id: sub.id, plan: sub.plan, billing_cycle: cycle, status: sub.status,
        price_monthly: sub.price_monthly, price_yearly: sub.price_yearly,
        trial_end: sub.trial_end, created_at: sub.created_at,
      } : null,
      summary: {
        total_periods: periods.length,
        paid_periods: paidCount,
        unpaid_periods: unpaidCount,
        total_paid_amount: totalPaid,
        currency,
        cycle,
      },
      periods,
      invoices, // raw audit rows for advanced display
    });
  } catch (error) {
    console.error('Billing history error:', error);
    res.status(500).json({ success: false, error: 'Failed to load billing history' });
  }
});

// POST /super-admin/workshops/:id/extend-trial — extend a workshop's trial
router.post('/workshops/:id/extend-trial', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const { days } = req.body;
    const extensionDays = parseInt(days, 10);

    if (!extensionDays || extensionDays < 1 || extensionDays > 90) {
      return res.status(400).json({ success: false, message: 'Days must be between 1 and 90' });
    }

    // Get current subscription
    const [sub] = await query(
      'SELECT id, trial_end, trial_days, status FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
      [workshopId]
    );

    if (!sub) {
      return res.status(404).json({ success: false, message: 'No subscription found for this workshop' });
    }

    // Calculate new trial_end: extend from current trial_end or from NOW if expired
    const baseDate = sub.trial_end && new Date(sub.trial_end) > new Date()
      ? new Date(sub.trial_end)
      : new Date();
    const newTrialEnd = new Date(baseDate);
    newTrialEnd.setDate(newTrialEnd.getDate() + extensionDays);

    const newTotalDays = (sub.trial_days || 7) + extensionDays;

    await execute(
      `UPDATE subscriptions
       SET trial_end = ?, trial_days = ?, trial_extended = 1, status = 'trialing'
       WHERE id = ?`,
      [newTrialEnd, newTotalDays, sub.id]
    );

    // Also restore workshop status if it was expired/suspended
    await execute(
      "UPDATE workshops SET status = 'trial', trial_ends_at = ? WHERE id = ? AND status IN ('trial_expired', 'suspended', 'trial')",
      [newTrialEnd, workshopId]
    );

    // Reactivate users if they were deactivated
    await execute('UPDATE users SET is_active = 1 WHERE workshop_id = ?', [workshopId]);

    console.log(`[SuperAdmin] Extended trial for workshop ${workshopId} by ${extensionDays} days → ends ${newTrialEnd.toISOString()}`);

    res.json({
      success: true,
      message: `Trial extended by ${extensionDays} days`,
      trial_end: newTrialEnd,
      total_trial_days: newTotalDays,
    });
  } catch (error) {
    console.error('Extend trial error:', error);
    res.status(500).json({ error: 'Failed to extend trial' });
  }
});

// POST /super-admin/workshops/:id/stop-trial — immediately expire a workshop's trial
router.post('/workshops/:id/stop-trial', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;

    const [sub] = await query(
      "SELECT id, status FROM subscriptions WHERE workshop_id = ? AND (status = 'trialing' OR (status = 'active' AND trial_end IS NOT NULL AND trial_end > NOW())) ORDER BY id DESC LIMIT 1",
      [workshopId]
    );

    if (!sub) {
      return res.status(400).json({ success: false, message: 'No active trial found for this workshop' });
    }

    await execute(
      "UPDATE subscriptions SET status = 'trial_expired', trial_end = NOW() WHERE id = ?",
      [sub.id]
    );
    await execute(
      "UPDATE workshops SET status = 'trial_expired' WHERE id = ?",
      [workshopId]
    );

    console.log(`[SuperAdmin] Stopped trial for workshop ${workshopId}`);

    res.json({ success: true, message: 'Trial stopped — workshop is now in trial_expired state' });
  } catch (error) {
    console.error('Stop trial error:', error);
    res.status(500).json({ error: 'Failed to stop trial' });
  }
});

// POST /super-admin/workshops/:id/activate-plan — convert trial/expired workshop to active paid plan
router.post('/workshops/:id/activate-plan', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const { plan } = req.body;

    const validPlans = ['starter', 'growth', 'professional', 'enterprise', 'self_hosted'];
    if (!plan || !validPlans.includes(plan)) {
      return res.status(400).json({ success: false, message: `Plan must be one of: ${validPlans.join(', ')}` });
    }

    // Update or create subscription
    const [existingSub] = await query(
      'SELECT id FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
      [workshopId]
    );

    const periodEnd = new Date();
    periodEnd.setFullYear(periodEnd.getFullYear() + 1); // 1 year default

    // Resolve max_users for the plan (all plans have unlimited users/mechanics)
    // Look up max_users from the plans table; fall back to unlimited
    let maxUsers = 999999;
    try {
      const [planRow] = await query('SELECT max_users FROM plans WHERE slug = ? LIMIT 1', [plan]);
      if (planRow && planRow.max_users) maxUsers = planRow.max_users;
    } catch (_) {}

    if (existingSub) {
      // BUG 10 FIX: Set current_period_start and billing_cycle so the subscription
      // data is complete and any future period-end checks can work correctly.
      await execute(
        `UPDATE subscriptions
         SET plan = ?, status = 'active', max_users = ?, billing_cycle = 'yearly',
             current_period_start = NOW(), current_period_end = ?, trial_end = NULL
         WHERE id = ?`,
        [plan, maxUsers, periodEnd, existingSub.id]
      );
    } else {
      await execute(
        `INSERT INTO subscriptions (workshop_id, plan, status, current_period_end, max_users, created_at)
         VALUES (?, ?, 'active', ?, ?, NOW())`,
        [workshopId, plan, periodEnd, maxUsers]
      );
    }

    // Activate workshop
    await execute("UPDATE workshops SET status = 'active' WHERE id = ?", [workshopId]);
    await execute('UPDATE users SET is_active = 1 WHERE workshop_id = ?', [workshopId]);
    // Mark owner email as verified since super-admin approved this workshop
    await execute('UPDATE users SET email_verified = 1 WHERE workshop_id = ? AND is_owner = 1', [workshopId]);

    console.log(`[SuperAdmin] Activated plan '${plan}' for workshop ${workshopId}`);

    res.json({ success: true, message: `Workshop activated with ${plan} plan`, plan });
  } catch (error) {
    console.error('Activate plan error:', error);
    res.status(500).json({ error: 'Failed to activate plan' });
  }
});

// POST /super-admin/workshops/:id/send-welcome-email — Send welcome email to workshop owner
router.post('/workshops/:id/send-welcome-email', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;

    const [workshop] = await query('SELECT id, name, email, trial_ends_at, status FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) return res.status(404).json({ success: false, message: 'Workshop not found' });

    const [owner] = await query(
      'SELECT id, full_name, email FROM users WHERE workshop_id = ? AND is_owner = 1 LIMIT 1',
      [workshopId]
    );
    if (!owner) return res.status(404).json({ success: false, message: 'No owner user found for this workshop' });

    const trialEnd = workshop.trial_ends_at ? new Date(workshop.trial_ends_at) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const trialDays = Math.max(1, Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24)));
    const trialEndFormatted = trialEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });
    const frontendUrl = process.env.FRONTEND_URL || config.frontendUrl || 'https://dispatch.pioneercarservice.com';
    const loginUrl = `${frontendUrl}/login`;

    const cidLogo = getLogoCidAttachment();
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td align="center" style="padding:0 0 28px;">
            <table cellpadding="0" cellspacing="0" style="display:inline-table;">
              <tr>
                <td style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;
                           box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:14px 28px;text-align:center;">
                  <img src="${cidLogo.src}" alt="Pioneer" height="44"
                       style="display:block;height:44px;width:auto;max-width:220px;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;
                     box-shadow:0 4px 24px rgba(0,0,0,0.06);overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="height:6px;font-size:0;line-height:0;" bgcolor="#f97316">&nbsp;</td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:40px 40px 32px;">
                  <h1 style="margin:0 0 4px;font-size:24px;font-weight:700;color:#111827;">Welcome to Pioneer! &#128640;</h1>
                  <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Your ${trialDays}-day free trial has started</p>

                  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#1e40af;font-weight:600;">&#127881; TRIAL DETAILS</p>
                    <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Company</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${workshop.name}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Admin</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${owner.full_name}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Trial Period</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${trialDays} days</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Expires On</td><td style="padding:4px 0;font-size:14px;color:#dc2626;font-weight:700;">${trialEndFormatted}</td></tr>
                    </table>
                  </div>

                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 16px;">
                    Hi <strong>${owner.full_name}</strong>, your workspace <strong>${workshop.name}</strong> has been created!
                  </p>
                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 24px;">
                    During your trial, you have <strong>full access</strong> to all features — create work orders, add mechanics, manage job assignment,
                    use live map, generate reports, and more.
                  </p>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
                    <tr><td align="center">
                      <table cellpadding="0" cellspacing="0" style="border-radius:10px;" bgcolor="#f97316">
                        <tr>
                          <td align="center" style="padding:14px 44px;border-radius:10px;" bgcolor="#f97316">
                            <a href="${loginUrl}" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
                              Log In to Your Dashboard &#8594;
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>

                  <p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">
                    Need help? Contact us at <a href="mailto:info@pioneercarservice.com" style="color:#f97316;">info@pioneercarservice.com</a>
                    or WhatsApp <a href="https://wa.me/971503920037" style="color:#f97316;">+971 50 392 0037</a>
                  </p>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">
                    ${new Date().getFullYear()} &copy; Pioneer Solutions. All rights reserved.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const result = await sendEmail({
      to: owner.email,
      subject: `Welcome to Pioneer — Your ${trialDays}-Day Free Trial Has Started`,
      html,
      fromName: 'Pioneer',
      attachments: [cidLogo.attachment],
    });

    if (result.success) {
      console.log(`[SuperAdmin] Welcome email sent to ${owner.email} for workshop ${workshopId}`);
      res.json({ success: true, message: `Welcome email sent to ${owner.email}` });
    } else {
      res.status(500).json({ success: false, message: result.error || 'Failed to send email' });
    }
  } catch (error) {
    console.error('Send welcome email error:', error);
    res.status(500).json({ success: false, message: 'Failed to send welcome email' });
  }
});

// GET /super-admin/workshops/:id/trial-status — detailed trial info for a workshop
router.get('/workshops/:id/trial-status', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;

    const [sub] = await query(
      `SELECT s.*, t.name, t.email, t.status AS workshop_status, t.trial_ends_at,
              DATEDIFF(s.trial_end, NOW()) AS days_remaining,
              DATEDIFF(NOW(), s.trial_start) AS days_used
       FROM subscriptions s
       JOIN workshops t ON t.id = s.workshop_id
       WHERE s.workshop_id = ?
       ORDER BY s.id DESC LIMIT 1`,
      [workshopId]
    );

    if (!sub) {
      return res.status(404).json({ success: false, message: 'No subscription found' });
    }

    res.json({
      success: true,
      trial: {
        subscription_id: sub.id,
        plan: sub.plan,
        status: sub.status,
        workshop_status: sub.workshop_status,
        trial_start: sub.trial_start,
        trial_end: sub.trial_end,
        trial_days: sub.trial_days,
        trial_extended: !!sub.trial_extended,
        days_remaining: sub.days_remaining,
        days_used: sub.days_used,
        is_trialing: sub.status === 'trialing',
        is_expired: sub.status === 'trial_expired',
        workshop_email: sub.email,
        workshop_name: sub.name,
      },
    });
  } catch (error) {
    console.error('Get trial status error:', error);
    res.status(500).json({ error: 'Failed to get trial status' });
  }
});

// Set max users for workshop (stored in subscriptions table)
router.post('/workshops/:id/max-users', verifySuperAdmin, async (req, res) => {
  try {
    const { max_users } = req.body;
    const workshopId = req.params.id;

    // Update existing subscription or create one
    const sub = await query('SELECT id FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1', [workshopId]);
    if (sub && sub.length > 0) {
      await execute('UPDATE subscriptions SET max_users = ? WHERE id = ?', [max_users, sub[0].id]);
    } else {
      await execute('INSERT INTO subscriptions (workshop_id, plan, status, max_users) VALUES (?, "starter", "active", ?)', [workshopId, max_users]);
    }

    res.json({ success: true, message: `Max users set to ${max_users}` });
  } catch (error) {
    console.error('Set max users error:', error);
    res.status(500).json({ error: 'Failed to set max users' });
  }
});

// POST /super-admin/workshops/:id/users — add a user to a workshop (with max_users limit enforcement)
router.post('/workshops/:id/users', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const { full_name, username, email, phone, role, password } = req.body;

    if (!full_name || !username || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, username, email, and password are required' });
    }

    // Check workshop exists
    const [workshop] = await query('SELECT id, name FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) return res.status(404).json({ success: false, message: 'Workshop not found' });

    // Check max_users limit
    const [sub] = await query('SELECT max_users, plan FROM subscriptions WHERE workshop_id = ? AND status = "active" ORDER BY id DESC LIMIT 1', [workshopId]);
    const maxUsers = sub?.max_users || 5;
    const currentPlan = sub?.plan || 'starter';
    const [countRow] = await query('SELECT COUNT(*) as cnt FROM users WHERE workshop_id = ? AND is_active = 1', [workshopId]);
    const currentUsers = countRow?.cnt || 0;

    if (currentUsers >= maxUsers) {
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        limit_type: 'max_users',
        current_usage: currentUsers,
        limit: maxUsers,
        current_plan: currentPlan,
        message: `User limit reached for ${workshop.name} (${currentUsers}/${maxUsers}). The workshop needs to upgrade their plan or you need to increase max_users for this workshop.`,
        support: {
          email: 'support@pioneercarservice.com',
          info_email: 'info@pioneercarservice.com',
          whatsapp: '+971503920037',
        }
      });
    }

    // Check duplicate username/email
    const [dupUser] = await query('SELECT id FROM users WHERE workshop_id = ? AND (username = ? OR email = ?)', [workshopId, username, email]);
    if (dupUser) {
      return res.status(409).json({ success: false, message: 'A user with this username or email already exists in this workshop' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [workshopId, full_name, username, email, phone || null, hash, role || 'dispatcher']
    );

    const [newUser] = await query('SELECT id, full_name, username, email, role, is_active, created_at FROM users WHERE id = ?', [result.insertId]);

    res.status(201).json({
      success: true,
      data: newUser,
      message: `User ${full_name} added to ${workshop.name} (${currentUsers + 1}/${maxUsers})`,
    });
  } catch (error) {
    console.error('Super admin add user to workshop error:', error);
    res.status(500).json({ success: false, message: 'Failed to add user to workshop' });
  }
});

// Set allowed modules for workshop (stored in settings JSON)
router.post('/workshops/:id/modules', verifySuperAdmin, async (req, res) => {
  try {
    const { modules } = req.body;
    const workshopId = req.params.id;

    if (!Array.isArray(modules)) {
      return res.status(400).json({ error: 'modules must be an array' });
    }

    // Validate module IDs against known modules
    const VALID_MODULE_IDS = [
      'dashboard', 'work-orders', 'job-assignment', 'mechanics', 'customers', 'live-map',
      'service-status', 'bulk-import', 'warranty-claims', 'wallet', 'invoices',
      'cash-payment', 'reports', 'performance', 'service-bays', 'pricing', 'notifications',
      'settings', 'integrations', 'barcode', 'mechanic-scan', 'mechanic-dashboard',
      'my-jobs'
    ];
    const invalidModules = modules.filter(m => !VALID_MODULE_IDS.includes(m));
    if (invalidModules.length > 0) {
      return res.status(400).json({ error: `Invalid module IDs: ${invalidModules.join(', ')}` });
    }

    // Get current settings and merge allowed_modules into it
    const workshop = await query('SELECT settings FROM workshops WHERE id = ?', [workshopId]);
    let currentSettings = workshop?.[0]?.settings || {};
    if (typeof currentSettings === 'string') currentSettings = JSON.parse(currentSettings);
    currentSettings.allowed_modules = modules;

    await execute('UPDATE workshops SET settings = ? WHERE id = ?', [JSON.stringify(currentSettings), workshopId]);

    // Also sync modules into the workshop's roles so sidebar visibility matches
    // Admin role gets all assigned modules; dispatcher gets non-config modules;
    // mechanic role gets mechanic-specific modules only.
    const MECHANIC_MODULES = ['mechanic-dashboard', 'my-jobs', 'mechanic-scan', 'barcode'];
    const CONFIG_MODULES = ['service-bays', 'pricing', 'notifications', 'settings', 'integrations'];

    const adminModules  = modules; // admin sees everything enabled
    const mechanicModules = modules.filter(m => MECHANIC_MODULES.includes(m));
    const dispatchModules = modules.filter(m => !CONFIG_MODULES.includes(m) && !MECHANIC_MODULES.includes(m) || m === 'barcode');

    // Update existing roles (don't fail if roles don't exist yet)
    try {
      await execute(
        'UPDATE roles SET modules = ? WHERE workshop_id = ? AND slug = ?',
        [JSON.stringify(adminModules), workshopId, 'admin']
      );
      await execute(
        'UPDATE roles SET modules = ? WHERE workshop_id = ? AND slug = ?',
        [JSON.stringify(dispatchModules), workshopId, 'dispatcher']
      );
      await execute(
        'UPDATE roles SET modules = ? WHERE workshop_id = ? AND slug = ?',
        [JSON.stringify(mechanicModules), workshopId, 'mechanic']
      );
    } catch (roleErr) {
      console.warn('[SuperAdmin] Role module sync warning:', roleErr.message);
    }

    res.json({ success: true, message: 'Modules updated' });
  } catch (error) {
    console.error('Set modules error:', error);
    res.status(500).json({ error: 'Failed to set modules' });
  }
});

// Get available modules list — IDs MUST match Layout.jsx moduleKey values
router.get('/modules', verifySuperAdmin, (req, res) => {
  const modules = [
    { id: 'dashboard',           name: 'Dashboard',           nameAr: 'لوحة التحكم',       category: 'Core' },
    { id: 'work-orders',         name: 'Work Orders',         nameAr: 'أوامر العمل',        category: 'Operations' },
    { id: 'job-assignment',      name: 'Job Assignment',      nameAr: 'إسناد المهام',       category: 'Operations' },
    { id: 'mechanics',           name: 'Mechanics',           nameAr: 'الميكانيكيين',       category: 'Operations' },
    { id: 'customers',           name: 'Customers',           nameAr: 'العملاء',            category: 'Operations' },
    { id: 'live-map',            name: 'Live Map',            nameAr: 'الخريطة الحية',      category: 'Operations' },
    { id: 'service-status',      name: 'Service Status',      nameAr: 'حالة الخدمة',        category: 'Operations' },
    { id: 'bulk-import',         name: 'Bulk Import',         nameAr: 'الاستيراد الجماعي',  category: 'Operations' },
    { id: 'warranty-claims',     name: 'Warranty Claims',     nameAr: 'مطالبات الضمان',     category: 'Operations' },
    { id: 'wallet',              name: 'Wallet',              nameAr: 'المحفظة',            category: 'Finance' },
    { id: 'invoices',            name: 'Invoices',            nameAr: 'الفواتير',           category: 'Finance' },
    { id: 'cash-payment',        name: 'Cash Reconciliation', nameAr: 'تسوية الدفع النقدي', category: 'Finance' },
    { id: 'reports',             name: 'Reports',             nameAr: 'التقارير',           category: 'Analytics' },
    { id: 'performance',         name: 'Performance',         nameAr: 'الأداء',             category: 'Analytics' },
    { id: 'service-bays',        name: 'Service Bays',        nameAr: 'أروقة الخدمة',       category: 'Configuration' },
    { id: 'pricing',             name: 'Pricing',             nameAr: 'التسعير',            category: 'Configuration' },
    { id: 'notifications',       name: 'Notifications',       nameAr: 'الإشعارات',          category: 'Communication' },
    { id: 'settings',            name: 'Settings',            nameAr: 'الإعدادات',          category: 'Configuration' },
    { id: 'integrations',        name: 'API Keys',            nameAr: 'مفاتيح API',         category: 'Configuration' },
    { id: 'barcode',             name: 'Barcodes',            nameAr: 'الباركود',           category: 'Operations' },
    { id: 'mechanic-scan',       name: 'Mechanic Scan',       nameAr: 'مسح الميكانيكي',     category: 'Operations' },
    { id: 'mechanic-dashboard',  name: 'Mechanic Dashboard',  nameAr: 'لوحة تحكم الميكانيكي', category: 'Operations' },
    { id: 'my-jobs',             name: 'My Jobs',             nameAr: 'مهامي',              category: 'Operations' },
  ];

  res.json(modules);
});

// Get workshop usage stats
router.get('/workshops/:id/usage', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;

    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM work_orders WHERE workshop_id = ?) as work_orders,
        (SELECT COUNT(*) FROM work_orders WHERE workshop_id = ? AND status = 'completed') as completed_work_orders,
        (SELECT COUNT(*) FROM mechanics WHERE workshop_id = ?) as mechanics,
        (SELECT COUNT(*) FROM customers WHERE workshop_id = ?) as customers,
        (SELECT COUNT(*) FROM service_bays WHERE workshop_id = ?) as service_bays,
        (SELECT COUNT(*) FROM users WHERE workshop_id = ?) as users
    `, [workshopId, workshopId, workshopId, workshopId, workshopId, workshopId]);

    res.json(stats[0] || {});
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

// Login as workshop admin (impersonation)
router.post('/workshops/:id/impersonate', verifySuperAdmin, async (req, res) => {
  try {
    const admins = await query(
      "SELECT * FROM users WHERE workshop_id = ? AND role = 'admin' AND is_active = 1 LIMIT 1",
      [req.params.id]
    );

    if (!admins || admins.length === 0) {
      return res.status(404).json({ error: 'No active admin found for this workshop' });
    }

    const admin = admins[0];

    const token = jwt.sign(
      {
        id: admin.id,
        username: admin.username,
        workshop_id: admin.workshop_id,
        role: admin.role,
        impersonated_by: req.superAdmin.id
      },
      config.jwt.secret,
      { expiresIn: '2h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        workshop_id: admin.workshop_id
      }
    });

    // Audit log the impersonation
    try {
      await execute(
        `INSERT INTO sa_audit_logs (admin_id, admin_name, action, entity_type, entity_id, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.superAdmin?.id || null,
          req.superAdmin?.full_name || 'Unknown',
          'impersonate_workshop',
          'workshop',
          req.params.id,
          JSON.stringify({
            workshop_id: admin.workshop_id,
            impersonated_user: admin.username,
            impersonated_user_id: admin.id,
            reason: req.body?.reason || 'No reason provided'
          }),
          req.ip || req.connection?.remoteAddress,
          (req.headers['user-agent'] || '').substring(0, 500)
        ]
      );
    } catch (_) { /* audit table may not exist */ }
  } catch (error) {
    console.error('Impersonate error:', error);
    res.status(500).json({ error: 'Failed to impersonate' });
  }
});

// ══════════════════════════════════════════════════════════════
//  CREATE WORKSHOP
// ══════════════════════════════════════════════════════════════
router.post('/workshops', verifySuperAdmin, async (req, res) => {
  try {
    const { name, slug, email, phone, city, country, industry, max_users = 999999, plan: workshopPlan = 'starter', status = 'active' } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    const workshopSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    // Check slug uniqueness
    const existing = await query('SELECT id FROM workshops WHERE slug = ?', [workshopSlug]);
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'A workshop with this slug already exists' });
    }

    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 30);

    const result = await execute(
      `INSERT INTO workshops (name, slug, subdomain, email, phone, city, country, industry, status, trial_ends_at, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, workshopSlug, workshopSlug, email, phone || null, city || null, country || null, industry || null, status, trialEnds.toISOString().slice(0, 19).replace('T', ' '), JSON.stringify({})]
    );

    const workshopId = result.insertId;

    // Create default admin user for the workshop (unique username/email per workshop)
    const adminUsername = `admin_${workshopSlug}`;
    const adminHash = await bcrypt.hash('Admin@123', 10);
    await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, password, role, is_active, is_owner) VALUES (?, ?, ?, ?, ?, 'admin', TRUE, TRUE)`,
      [workshopId, `${name} Admin`, adminUsername, email, adminHash]
    );

    // Create a subscription
    // BUG 20 FIX: Use requested plan (default starter), features: {} so plan-gate
    // uses the plan's feature set rather than granting self_hosted-level access.
    const validWorkshopPlans = ['starter', 'professional', 'enterprise', 'self_hosted'];
    const safePlan = validWorkshopPlans.includes(workshopPlan) ? workshopPlan : 'starter';
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, billing_cycle, current_period_start, current_period_end, features) VALUES (?, ?, 'active', ?, 'yearly', NOW(), DATE_ADD(NOW(), INTERVAL 1 YEAR), ?)`,
      [workshopId, safePlan, max_users, JSON.stringify({})]
    );

    const newWorkshop = await query('SELECT * FROM workshops WHERE id = ?', [workshopId]);

    // Send welcome email to the workshop admin (fire-and-forget)
    if (email) {
      try {
        const loginUrl = config.frontendUrl + '/login';
        const bodyHtml = `
          <p>Hi <strong>${name} Admin</strong>,</p>
          <p>Your workshop <strong>${name}</strong> has been created on <strong>Pioneer Solutions</strong>. You can now log in and start managing your workshop operations.</p>
          <table cellpadding="0" cellspacing="0" style="margin:16px 0 20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;width:100%;">
            <tr style="background:#f8fafc;">
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0;">Workshop</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;border-bottom:1px solid #e2e8f0;">${name}</td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0;">Username</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;font-family:'Courier New',monospace;border-bottom:1px solid #e2e8f0;">${adminUsername}</td>
            </tr>
            <tr style="background:#f8fafc;">
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0;">Password</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;font-family:'Courier New',monospace;border-bottom:1px solid #e2e8f0;">Admin@123</td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;">Plan</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;">${ { starter: 'Starter', professional: 'Growth', enterprise: 'Enterprise', self_hosted: 'Self-Hosted' }[safePlan] || safePlan }</td>
            </tr>
          </table>
          <p style="color:#ef4444;font-size:13px;">&#9888; Please change your password after your first login for security.</p>
        `;
        sendNotificationEmail({
          to: email,
          subject: `Welcome to Pioneer — Your Workshop "${name}" is Ready!`,
          title: 'Welcome to Pioneer Solutions!',
          body: bodyHtml,
          ctaText: 'Login Now',
          ctaUrl: loginUrl,
          workshopId: workshopId,
        }).catch(err => console.error('Workshop welcome email failed:', err.message));
      } catch (emailErr) {
        console.error('Workshop welcome email setup error:', emailErr.message);
      }
    }

    res.status(201).json({ workshop: newWorkshop[0], defaultPassword: 'Admin@123' });
  } catch (error) {
    console.error('Create workshop error:', error);
    res.status(500).json({ error: 'Failed to create workshop' });
  }
});

// DELETE workshop
router.delete('/workshops/:id', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;

    // Prevent deleting the platform owner
    const workshop = await query('SELECT settings FROM workshops WHERE id = ?', [workshopId]);
    if (workshop[0]?.settings) {
      const settings = typeof workshop[0].settings === 'string' ? JSON.parse(workshop[0].settings) : workshop[0].settings;
      if (settings.isPlatformOwner) {
        return res.status(403).json({ error: 'Cannot delete the platform owner workshop' });
      }
    }

    // Cascade-delete all workshop data (child tables first)
    try { await execute('DELETE FROM ticket_replies WHERE ticket_id IN (SELECT id FROM support_tickets WHERE workshop_id = ?)', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM support_tickets WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE workshop_id = ?)', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM invoices WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM recurring_invoices WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM parts WHERE work_order_id IN (SELECT id FROM work_orders WHERE workshop_id = ?)', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM work_order_status_logs WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    await execute('DELETE FROM work_orders WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM mechanics WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM customers WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM service_bays WHERE workshop_id = ?', [workshopId]);
    try { await execute('DELETE FROM service_pricing_rules WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM roles WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM notifications WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM audit_logs WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM tenant_branding WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM pregenerated_tokens WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM api_keys WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM platform_invoices WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM wallet_transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE workshop_id = ?)', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM wallets WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    try { await execute('DELETE FROM payment_links WHERE workshop_id = ?', [workshopId]); } catch(e) {}
    await execute('DELETE FROM users WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM subscriptions WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM workshops WHERE id = ?', [workshopId]);

    res.json({ success: true, message: 'Workshop deleted' });
  } catch (error) {
    console.error('Delete workshop error:', error);
    res.status(500).json({ error: 'Failed to delete workshop' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PLATFORM ANALYTICS
// ══════════════════════════════════════════════════════════════
router.get('/analytics', verifySuperAdmin, async (req, res) => {
  try {
    // Overall platform stats
    const workshopStats = await query(`
      SELECT
        COUNT(*) as total_workshops,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) as trial,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended
      FROM workshops
    `);

    const userStats = await query(`
      SELECT
        COUNT(*) as total_users,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_users,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admins,
        SUM(CASE WHEN role = 'mechanic' THEN 1 ELSE 0 END) as mechanics,
        SUM(CASE WHEN role = 'dispatcher' THEN 1 ELSE 0 END) as dispatchers
      FROM users
    `);

    const workOrderStats = await query(`
      SELECT
        COUNT(*) as total_work_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'in_progress' OR status = 'assigned' THEN 1 ELSE 0 END) as in_progress,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(AVG(total_amount), 0) as avg_work_order_value
      FROM work_orders
    `);

    // Work orders by month (last 6 months)
    const workOrdersByMonth = await query(`
      SELECT
        DATE_FORMAT(created_at, '%Y-%m') as month,
        COUNT(*) as work_orders,
        COALESCE(SUM(total_amount), 0) as revenue
      FROM work_orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `);

    // Top workshops by work orders
    const topWorkshops = await query(`
      SELECT t.id, t.name, t.status, COUNT(o.id) as work_order_count,
        COALESCE(SUM(o.total_amount), 0) as revenue,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id AND is_active = 1) as users
      FROM workshops t
      LEFT JOIN work_orders o ON o.workshop_id = t.id
      GROUP BY t.id
      ORDER BY work_order_count DESC
      LIMIT 10
    `);

    // Recent signups (last 30 days)
    const recentSignups = await query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM workshops
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Active sessions (users who logged in last 24h)
    const activeSessions = await query(`
      SELECT COUNT(*) as count FROM users WHERE last_login_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `);

    res.json({
      workshops: workshopStats[0] || {},
      users: userStats[0] || {},
      work_orders: workOrderStats[0] || {},
      workOrdersByMonth: workOrdersByMonth || [],
      topWorkshops: topWorkshops || [],
      recentSignups: recentSignups || [],
      activeSessions: activeSessions[0]?.count || 0
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PLATFORM SETTINGS
// ══════════════════════════════════════════════════════════════
router.get('/settings', verifySuperAdmin, async (req, res) => {
  try {
    // Check if platform_settings table exists, create if not
    await execute(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        category VARCHAR(50) DEFAULT 'general',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const settings = await query('SELECT * FROM platform_settings ORDER BY category, setting_key');

    // Return settings grouped by category, with defaults
    const defaults = {
      platform_name: 'Pioneer Solutions',
      platform_email: 'info@pioneercarservice.com',
      support_email: 'support@pioneercarservice.com',
      default_currency: 'AED',
      default_language: 'en',
      max_tenants: '100',
      trial_days: '14',
      maintenance_mode: 'false',
      allow_registration: 'true',
      smtp_host: '',
      smtp_port: '587',
      smtp_user: '',
      smtp_from: 'noreply@pioneercarservice.com',
    };

    const result = { ...defaults };
    for (const s of settings) {
      result[s.setting_key] = s.setting_value;
    }

    res.json(result);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/settings', verifySuperAdmin, async (req, res) => {
  try {
    const updates = req.body;

    // Ensure table exists
    await execute(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT,
        category VARCHAR(50) DEFAULT 'general',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    for (const [key, value] of Object.entries(updates)) {
      await execute(
        `INSERT INTO platform_settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, String(value)]
      );
    }

    res.json({ success: true, message: 'Settings updated' });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ══════════════════════════════════════════════════════════════
//  PLATFORM USERS (Super Admin accounts)
// ══════════════════════════════════════════════════════════════
router.get('/platform-users', verifySuperAdmin, async (req, res) => {
  try {
    const users = await query(
      'SELECT id, username, email, full_name, role, is_active, last_login, created_at FROM super_admins ORDER BY created_at DESC'
    );
    res.json(users || []);
  } catch (error) {
    console.error('Get platform users error:', error);
    res.status(500).json({ error: 'Failed to fetch platform users' });
  }
});

router.post('/platform-users', verifySuperAdmin, async (req, res) => {
  try {
    const { username, email, password, full_name, role = 'support' } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email and password are required' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = await execute(
      'INSERT INTO super_admins (username, email, password, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, TRUE)',
      [username, email, hash, full_name || username, role]
    );

    res.status(201).json({ id: result.insertId, username, email, full_name, role });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error('Create platform user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/platform-users/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { full_name, email, role, is_active, password } = req.body;

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await execute(
        'UPDATE super_admins SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), role = COALESCE(?, role), is_active = COALESCE(?, is_active), password = ? WHERE id = ?',
        [full_name, email, role, is_active, hash, req.params.id]
      );
    } else {
      await execute(
        'UPDATE super_admins SET full_name = COALESCE(?, full_name), email = COALESCE(?, email), role = COALESCE(?, role), is_active = COALESCE(?, is_active) WHERE id = ?',
        [full_name, email, role, is_active, req.params.id]
      );
    }

    const updated = await query('SELECT id, username, email, full_name, role, is_active FROM super_admins WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    console.error('Update platform user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/platform-users/:id', verifySuperAdmin, async (req, res) => {
  try {
    // Prevent self-deletion
    if (parseInt(req.params.id) === req.superAdmin.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    await execute('DELETE FROM super_admins WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    console.error('Delete platform user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ══════════════════════════════════════════════════════════════
//  ACTIVITY LOG
// ══════════════════════════════════════════════════════════════
router.get('/activity-log', verifySuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Try fetching from audit_logs if it exists
    let logs = [];
    try {
      logs = await query(
        `SELECT al.*, u.full_name as user_name, t.name as workshop_name
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.id
         LEFT JOIN workshops t ON al.workshop_id = t.id
         ORDER BY al.created_at DESC
         LIMIT ? OFFSET ?`,
        [parseInt(limit), offset]
      );
    } catch (e) {
      // audit_logs table may not exist, return empty
    }

    res.json(logs || []);
  } catch (error) {
    console.error('Activity log error:', error);
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

// ═══════════════════════════════════════════════════════════
// SUPER ADMIN — BARCODE / PRE-GENERATED TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET /api/super-admin/barcodes/overview — aggregated stats across all workshops
router.get('/barcodes/overview', verifySuperAdmin, async (req, res) => {
  try {
    const rows = await query(
      `SELECT
         t.id as workshop_id, t.name as workshop_name, t.slug,
         COUNT(pt.id) as total_tokens,
         SUM(pt.is_used = 0 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())) as available,
         SUM(pt.is_used = 1) as used,
         SUM(pt.is_used = 0 AND pt.expires_at IS NOT NULL AND pt.expires_at <= NOW()) as expired
       FROM workshops t
       LEFT JOIN pregenerated_tokens pt ON t.id = pt.workshop_id
       GROUP BY t.id
       ORDER BY total_tokens DESC`
    );
    const totals = rows.reduce((acc, r) => ({
      total: acc.total + (Number(r.total_tokens) || 0),
      available: acc.available + (Number(r.available) || 0),
      used: acc.used + (Number(r.used) || 0),
      expired: acc.expired + (Number(r.expired) || 0),
    }), { total: 0, available: 0, used: 0, expired: 0 });
    res.json({ success: true, data: { workshops: rows, totals } });
  } catch (err) {
    console.error('[SuperAdmin] Barcodes overview error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch barcode overview' });
  }
});

// GET /api/super-admin/barcodes/workshop/:workshopId — list tokens for a specific workshop
router.get('/barcodes/workshop/:workshopId', verifySuperAdmin, async (req, res) => {
  try {
    const { workshopId } = req.params;
    const { used, batch_name, page = 1, limit = 100 } = req.query;
    const pg  = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(Math.max(1, parseInt(limit) || 100), 500);
    const offset = (pg - 1) * lim;

    let where = 'WHERE pt.workshop_id = ?';
    const params = [workshopId];

    if (used === 'false' || used === '0') {
      where += ' AND pt.is_used = 0 AND (pt.expires_at IS NULL OR pt.expires_at > NOW())';
    } else if (used === 'true' || used === '1') {
      where += ' AND pt.is_used = 1';
    }
    if (batch_name) {
      where += ' AND pt.batch_name = ?';
      params.push(batch_name);
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM pregenerated_tokens pt ${where}`, params
    );
    const tokens = await query(
      `SELECT pt.*,
              o.work_order_number, o.customer_name, o.status as work_order_status,
              DATEDIFF(pt.expires_at, NOW()) as days_remaining
       FROM pregenerated_tokens pt
       LEFT JOIN work_orders o ON pt.work_order_id = o.id
       ${where} ORDER BY pt.created_at DESC LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    // also fetch workshop name
    const [workshop] = await query('SELECT name FROM workshops WHERE id = ?', [workshopId]);

    res.json({ success: true, data: tokens, workshop_name: workshop?.name || 'Unknown', pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    console.error('[SuperAdmin] Workshop barcodes error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch workshop barcodes' });
  }
});

// POST /api/super-admin/barcodes/workshop/:workshopId/generate — generate tokens for a workshop
router.post('/barcodes/workshop/:workshopId/generate', verifySuperAdmin, async (req, res) => {
  try {
    const { workshopId } = req.params;
    const { count = 10, batch_name = '' } = req.body;
    const n = Math.min(Math.max(1, parseInt(count) || 10), 200);

    // Verify workshop exists
    const [workshop] = await query('SELECT id, name FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) return res.status(404).json({ success: false, error: 'Workshop not found' });

    const { default: crypto } = await import('crypto');
    const genToken = () => 'TRS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const tokens = [];
    for (let i = 0; i < n; i++) {
      let token, inserted = false, attempts = 0;
      while (!inserted && attempts < 5) {
        token = genToken();
        try {
          const result = await execute(
            `INSERT INTO pregenerated_tokens (workshop_id, tracking_token, barcode_value, batch_name, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            [workshopId, token, token, batch_name || null, expiresAt]
          );
          tokens.push({ id: result.insertId, tracking_token: token, barcode_value: token });
          inserted = true;
        } catch (e) {
          if (e.code === 'ER_DUP_ENTRY') { attempts++; continue; }
          throw e;
        }
      }
    }

    res.json({ success: true, message: `Generated ${tokens.length} tokens for ${workshop.name}`, data: tokens });
  } catch (err) {
    console.error('[SuperAdmin] Generate barcodes error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate tokens' });
  }
});

// DELETE /api/super-admin/barcodes/:id — delete unused token
router.delete('/barcodes/:id', verifySuperAdmin, async (req, res) => {
  try {
    const [token] = await query('SELECT id, is_used FROM pregenerated_tokens WHERE id = ?', [req.params.id]);
    if (!token) return res.status(404).json({ success: false, error: 'Token not found' });
    if (token.is_used) return res.status(400).json({ success: false, error: 'Cannot delete used token' });
    await execute('DELETE FROM pregenerated_tokens WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Token deleted' });
  } catch (err) {
    console.error('[SuperAdmin] Delete barcode error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete token' });
  }
});

export default router;
