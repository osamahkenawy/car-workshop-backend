import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import os from 'os';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';
import { sendNotificationEmail } from '../lib/email.js';

const router = express.Router();

// ──────────────────────────────────────────────────────────────
//  SHARED MIDDLEWARE
// ──────────────────────────────────────────────────────────────
const verifySuperAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== 'super_admin') return res.status(403).json({ error: 'Super admin only.' });

    const admins = await query(
      'SELECT id, username, email, full_name, role, permissions FROM super_admins WHERE id = ? AND is_active = 1',
      [decoded.id]
    );
    if (!admins?.length) return res.status(401).json({ error: 'Super admin not found or inactive.' });

    req.superAdmin = admins[0];
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// ──────────────────────────────────────────────────────────────
//  HELPER: Ensure a table exists (idempotent)
// ──────────────────────────────────────────────────────────────
async function ensureTables() {
  // Audit logs (super admin level — separate from workshop audit_logs)
  await execute(`
    CREATE TABLE IF NOT EXISTS sa_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT,
      admin_name VARCHAR(200),
      action VARCHAR(100) NOT NULL,
      entity_type VARCHAR(80),
      entity_id INT,
      details JSON,
      ip_address VARCHAR(45),
      user_agent VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_admin (admin_id),
      INDEX idx_action (action),
      INDEX idx_entity (entity_type, entity_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Announcements
  await execute(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      type ENUM('info','warning','critical','maintenance','update') DEFAULT 'info',
      target ENUM('all','specific') DEFAULT 'all',
      tenant_ids JSON,
      is_active BOOLEAN DEFAULT TRUE,
      is_pinned BOOLEAN DEFAULT FALSE,
      created_by INT,
      expires_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_active (is_active),
      INDEX idx_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Support tickets
  await execute(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT,
      workshop_name VARCHAR(255),
      user_id INT,
      user_name VARCHAR(255),
      subject VARCHAR(500) NOT NULL,
      description TEXT,
      category ENUM('bug','feature_request','billing','account','technical','other') DEFAULT 'other',
      priority ENUM('low','medium','high','critical') DEFAULT 'medium',
      status ENUM('open','in_progress','waiting','resolved','closed') DEFAULT 'open',
      assigned_to INT,
      assigned_name VARCHAR(200),
      resolution TEXT,
      resolved_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_priority (priority),
      INDEX idx_workshop (workshop_id),
      INDEX idx_assigned (assigned_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Ticket replies
  await execute(`
    CREATE TABLE IF NOT EXISTS ticket_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ticket_id INT NOT NULL,
      sender_type ENUM('admin','workshop') DEFAULT 'admin',
      sender_id INT,
      sender_name VARCHAR(200),
      message TEXT NOT NULL,
      attachments JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ticket (ticket_id),
      FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Email templates
  await execute(`
    CREATE TABLE IF NOT EXISTS sa_email_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      subject VARCHAR(500) NOT NULL,
      body TEXT NOT NULL,
      variables JSON,
      category ENUM('welcome','notification','billing','system','custom') DEFAULT 'custom',
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Workshop branding
  await execute(`
    CREATE TABLE IF NOT EXISTS tenant_branding (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT NOT NULL UNIQUE,
      logo_url VARCHAR(500),
      favicon_url VARCHAR(500),
      primary_color VARCHAR(20) DEFAULT '#f97316',
      secondary_color VARCHAR(20) DEFAULT '#1e293b',
      accent_color VARCHAR(20) DEFAULT '#3b82f6',
      sidebar_color VARCHAR(20) DEFAULT '#1e293b',
      font_family VARCHAR(100) DEFAULT 'Inter',
      custom_domain VARCHAR(255),
      custom_css TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id),
      FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Billing / invoices for platform (workshop invoices for their subscription)
  await execute(`
    CREATE TABLE IF NOT EXISTS platform_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT NOT NULL,
      subscription_id INT,
      invoice_number VARCHAR(50) UNIQUE,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      status ENUM('draft','sent','paid','overdue','cancelled') DEFAULT 'draft',
      billing_period_start DATE,
      billing_period_end DATE,
      due_date DATE,
      paid_at DATETIME,
      payment_method VARCHAR(100),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id),
      INDEX idx_status (status),
      FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed default email templates (ignore duplicates)
  const templateCount = await query('SELECT COUNT(*) as c FROM sa_email_templates');
  if ((templateCount[0]?.c || 0) === 0) {
    const templates = [
      {
        name: 'Welcome Email',
        slug: 'welcome',
        subject: 'Welcome to Pioneer — Your account is ready!',
        body: `<h2>Welcome to Pioneer, {{workshop_name}}!</h2>
<p>Your workshop management platform is ready.</p>
<p><strong>Login URL:</strong> {{login_url}}</p>
<p><strong>Username:</strong> {{username}}</p>
<p><strong>Password:</strong> {{password}}</p>
<p>Best regards,<br>Pioneer Team</p>`,
        variables: JSON.stringify(['workshop_name', 'login_url', 'username', 'password']),
        category: 'welcome'
      },
      {
        name: 'Subscription Activated',
        slug: 'subscription_activated',
        subject: 'Your subscription has been activated',
        body: `<h2>Subscription Activated</h2>
<p>Dear {{workshop_name}},</p>
<p>Your <strong>{{plan_name}}</strong> plan is now active.</p>
<p>Plan features: {{features_list}}</p>
<p>Next billing: {{next_billing_date}}</p>`,
        variables: JSON.stringify(['workshop_name', 'plan_name', 'features_list', 'next_billing_date']),
        category: 'billing'
      },
      {
        name: 'Subscription Expiring',
        slug: 'subscription_expiring',
        subject: 'Your subscription is expiring soon',
        body: `<h2>Subscription Expiring</h2>
<p>Dear {{workshop_name}},</p>
<p>Your <strong>{{plan_name}}</strong> plan will expire on <strong>{{expiry_date}}</strong>.</p>
<p>Please renew to avoid service interruption.</p>`,
        variables: JSON.stringify(['workshop_name', 'plan_name', 'expiry_date']),
        category: 'billing'
      },
      {
        name: 'Account Suspended',
        slug: 'account_suspended',
        subject: 'Your account has been suspended',
        body: `<h2>Account Suspended</h2>
<p>Dear {{workshop_name}},</p>
<p>Your account has been suspended. Reason: {{reason}}</p>
<p>Please contact support to resolve this issue.</p>`,
        variables: JSON.stringify(['workshop_name', 'reason']),
        category: 'system'
      },
      {
        name: 'Password Reset',
        slug: 'password_reset',
        subject: 'Password Reset Request',
        body: `<h2>Password Reset</h2>
<p>You requested a password reset.</p>
<p>Click <a href="{{reset_link}}">here</a> to reset your password.</p>
<p>This link expires in 1 hour.</p>`,
        variables: JSON.stringify(['reset_link']),
        category: 'system'
      },
      {
        name: 'Platform Announcement',
        slug: 'announcement',
        subject: '{{title}}',
        body: `<h2>{{title}}</h2>
<p>{{message}}</p>
<p>— Pioneer Team</p>`,
        variables: JSON.stringify(['title', 'message']),
        category: 'notification'
      }
    ];

    for (const t of templates) {
      try {
        await execute(
          `INSERT IGNORE INTO sa_email_templates (name, slug, subject, body, variables, category) VALUES (?, ?, ?, ?, ?, ?)`,
          [t.name, t.slug, t.subject, t.body, t.variables, t.category]
        );
      } catch (_) {}
    }
  }
}

// Initialize tables on load
ensureTables().catch(err => console.error('Enhanced tables init error:', err));

// Extend category ENUM to include mobile app values (safe — ignores if already present)
(async () => {
  try {
    await execute(`ALTER TABLE support_tickets MODIFY COLUMN category ENUM('bug','feature_request','billing','account','technical','other','order_issue','app_bug','payment','navigation') DEFAULT 'other'`);
  } catch (_) { /* ignore if already extended or column doesn't exist yet */ }
  try {
    await execute(`ALTER TABLE ticket_replies MODIFY COLUMN sender_type ENUM('admin','workshop','mechanic','support') DEFAULT 'admin'`);
  } catch (_) { /* ignore */ }
})();

// ──────────────────────────────────────────────────────────────
//  HELPER: Log audit action
// ──────────────────────────────────────────────────────────────
async function logAudit(req, action, entityType, entityId, details = {}) {
  try {
    await execute(
      `INSERT INTO sa_audit_logs (admin_id, admin_name, action, entity_type, entity_id, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.superAdmin?.id || null,
        req.superAdmin?.full_name || 'System',
        action,
        entityType,
        entityId,
        JSON.stringify(details),
        req.ip || req.connection?.remoteAddress,
        req.headers['user-agent']?.substring(0, 500) || ''
      ]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}


// ══════════════════════════════════════════════════════════════
//  1. AUDIT / ACTIVITY LOG
// ══════════════════════════════════════════════════════════════
router.get('/audit-log', verifySuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, action, entity_type, admin_id, from, to, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '1=1';
    const params = [];

    if (action) { where += ' AND action = ?'; params.push(action); }
    if (entity_type) { where += ' AND entity_type = ?'; params.push(entity_type); }
    if (admin_id) { where += ' AND admin_id = ?'; params.push(parseInt(admin_id)); }
    if (from) { where += ' AND created_at >= ?'; params.push(from); }
    if (to) { where += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }
    if (search) { where += ' AND (admin_name LIKE ? OR action LIKE ? OR details LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const total = await query(`SELECT COUNT(*) as count FROM sa_audit_logs WHERE ${where}`, params);
    const logs = await query(
      `SELECT * FROM sa_audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Get unique actions and entity types for filters
    const actions = await query('SELECT DISTINCT action FROM sa_audit_logs ORDER BY action');
    const entityTypes = await query('SELECT DISTINCT entity_type FROM sa_audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type');

    res.json({
      logs: logs || [],
      total: total[0]?.count || 0,
      page: parseInt(page),
      totalPages: Math.ceil((total[0]?.count || 0) / parseInt(limit)),
      filters: {
        actions: actions.map(a => a.action),
        entityTypes: entityTypes.map(e => e.entity_type)
      }
    });
  } catch (error) {
    console.error('Audit log error:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Get audit log stats
router.get('/audit-log/stats', verifySuperAdmin, async (req, res) => {
  try {
    const today = await query(`SELECT COUNT(*) as count FROM sa_audit_logs WHERE DATE(created_at) = CURDATE()`);
    const thisWeek = await query(`SELECT COUNT(*) as count FROM sa_audit_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);
    const byAction = await query(`
      SELECT action, COUNT(*) as count FROM sa_audit_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY action ORDER BY count DESC LIMIT 10
    `);
    const byAdmin = await query(`
      SELECT admin_name, COUNT(*) as count FROM sa_audit_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND admin_name IS NOT NULL
      GROUP BY admin_name ORDER BY count DESC LIMIT 10
    `);

    res.json({
      today: today[0]?.count || 0,
      thisWeek: thisWeek[0]?.count || 0,
      byAction: byAction || [],
      byAdmin: byAdmin || []
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit stats' });
  }
});


// ══════════════════════════════════════════════════════════════
//  2. SUBSCRIPTION & BILLING MANAGEMENT
// ══════════════════════════════════════════════════════════════

// Get all plans (include landing pricing fields)
router.get('/plans', verifySuperAdmin, async (req, res) => {
  try {
    const plans = await query(`
      SELECT p.*, COALESCE(sc.sub_count, 0) as subscriber_count
      FROM plans p
      LEFT JOIN (SELECT plan, COUNT(*) as sub_count FROM subscriptions WHERE status IN ('active','trialing') GROUP BY plan) sc ON sc.plan = p.slug
      ORDER BY p.sort_order ASC, p.price_aed ASC
    `);
    const parsed = (plans || []).map(p => {
      let features = p.features;
      if (typeof features === 'string') { try { features = JSON.parse(features); } catch { features = []; } }
      let landing_features = p.landing_features;
      if (typeof landing_features === 'string') { try { landing_features = JSON.parse(landing_features); } catch { landing_features = []; } }
      return { ...p, features: features || [], landing_features: landing_features || [] };
    });
    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// Create / update plan (includes landing page pricing fields)
router.post('/plans', verifySuperAdmin, async (req, res) => {
  try {
    const { id, name, slug, description, max_mechanics, max_users, max_work_orders_per_month,
      price_aed, setup_fee_aed, features, is_active,
      base_stops, extra_rate_aed, is_featured, badge_key, landing_features, landing_visible, sort_order
    } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Name and slug are required' });

    if (id) {
      await execute(
        `UPDATE plans SET name=?, slug=?, description=?, max_mechanics=?, max_users=?, max_work_orders_per_month=?,
         price_aed=?, setup_fee_aed=?, features=?, is_active=?,
         base_stops=?, extra_rate_aed=?, is_featured=?, badge_key=?, landing_features=?, landing_visible=?, sort_order=?
         WHERE id=?`,
        [name, slug, description || null, max_mechanics || 10, max_users || 5, max_work_orders_per_month || 1000,
         price_aed || 0, setup_fee_aed || 0, JSON.stringify(features || []), is_active !== false ? 1 : 0,
         base_stops || 0, extra_rate_aed || 0, is_featured ? 1 : 0, badge_key || null,
         JSON.stringify(landing_features || []), landing_visible !== false ? 1 : 0, sort_order || 0, id]
      );
      await logAudit(req, 'plan_updated', 'plan', id, { name });
      res.json({ success: true, message: 'Plan updated' });
    } else {
      const result = await execute(
        `INSERT INTO plans (name, slug, description, max_mechanics, max_users, max_work_orders_per_month,
         price_aed, setup_fee_aed, features, is_active,
         base_stops, extra_rate_aed, is_featured, badge_key, landing_features, landing_visible, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, slug, description || null, max_mechanics || 10, max_users || 5, max_work_orders_per_month || 1000,
         price_aed || 0, setup_fee_aed || 0, JSON.stringify(features || []), 1,
         base_stops || 0, extra_rate_aed || 0, is_featured ? 1 : 0, badge_key || null,
         JSON.stringify(landing_features || []), 1, sort_order || 0]
      );
      await logAudit(req, 'plan_created', 'plan', result.insertId, { name });
      res.status(201).json({ id: result.insertId, success: true });
    }
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Plan slug already exists' });
    res.status(500).json({ error: 'Failed to save plan' });
  }
});

// Delete plan
router.delete('/plans/:id', verifySuperAdmin, async (req, res) => {
  try {
    const plan = await query('SELECT slug FROM plans WHERE id = ?', [req.params.id]);
    if (plan && plan[0]) {
      const subs = await query('SELECT COUNT(*) as c FROM subscriptions WHERE plan = ? AND status IN ("active","trialing")', [plan[0].slug]);
      if (subs[0]?.c > 0) {
        return res.status(400).json({ error: `Cannot delete plan with ${subs[0].c} active subscription(s). Change their plans first.` });
      }
    }
    await execute('DELETE FROM plans WHERE id = ?', [req.params.id]);
    await logAudit(req, 'plan_deleted', 'plan', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// Get all subscriptions with workshop info
router.get('/subscriptions', verifySuperAdmin, async (req, res) => {
  try {
    const { status, plan, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = '1=1';
    const params = [];

    if (status) { where += ' AND s.status = ?'; params.push(status); }
    if (plan) { where += ' AND s.plan = ?'; params.push(plan); }

    const subs = await query(`
      SELECT s.*, t.name as workshop_name, t.status as workshop_status, t.email as workshop_email
      FROM subscriptions s
      LEFT JOIN workshops t ON s.workshop_id = t.id
      WHERE ${where}
      ORDER BY s.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const total = await query(`SELECT COUNT(*) as c FROM subscriptions s WHERE ${where}`, params);
    res.json({ subscriptions: subs || [], total: total[0]?.c || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

// Update a subscription (change plan, extend, etc.)
router.put('/subscriptions/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { plan, status, max_users, price_monthly, price_yearly, billing_cycle, current_period_end } = req.body;

    // If plan is being changed and max_users not explicitly set, pull from plan table
    let resolvedMaxUsers = max_users;
    let resolvedPrice = price_monthly;
    if (plan && !max_users) {
      const planRow = await query('SELECT max_users, price_aed FROM plans WHERE slug = ?', [plan]);
      if (planRow && planRow[0]) {
        resolvedMaxUsers = planRow[0].max_users;
        if (!price_monthly) resolvedPrice = planRow[0].price_aed;
      }
    }

    await execute(`
      UPDATE subscriptions SET
        plan = COALESCE(?, plan),
        status = COALESCE(?, status),
        max_users = COALESCE(?, max_users),
        price_monthly = COALESCE(?, price_monthly),
        price_yearly = COALESCE(?, price_yearly),
        billing_cycle = COALESCE(?, billing_cycle),
        current_period_end = COALESCE(?, current_period_end)
      WHERE id = ?
    `, [plan, status, resolvedMaxUsers, resolvedPrice, price_yearly, billing_cycle, current_period_end, req.params.id]);

    // Sync workshop plan field if plan changed
    if (plan) {
      const sub = await query('SELECT workshop_id FROM subscriptions WHERE id = ?', [req.params.id]);
      if (sub && sub[0]) {
        await execute('UPDATE workshops SET plan = ? WHERE id = ?', [plan, sub[0].workshop_id]);
      }
    }

    await logAudit(req, 'subscription_updated', 'subscription', parseInt(req.params.id), { plan, status });
    const updated = await query('SELECT * FROM subscriptions WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// Get platform invoices
router.get('/invoices', verifySuperAdmin, async (req, res) => {
  try {
    const { status, workshop_id, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = '1=1';
    const params = [];

    if (status) { where += ' AND pi.status = ?'; params.push(status); }
    if (workshop_id) { where += ' AND pi.workshop_id = ?'; params.push(parseInt(workshop_id)); }

    const invoices = await query(`
      SELECT pi.*, t.name as workshop_name, t.email as workshop_email
      FROM platform_invoices pi
      LEFT JOIN workshops t ON pi.workshop_id = t.id
      WHERE ${where}
      ORDER BY pi.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const total = await query(`SELECT COUNT(*) as c FROM platform_invoices pi WHERE ${where}`, params);
    res.json({ invoices: invoices || [], total: total[0]?.c || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Create platform invoice
router.post('/invoices', verifySuperAdmin, async (req, res) => {
  try {
    const { workshop_id, amount, currency, billing_period_start, billing_period_end, due_date, notes } = req.body;
    if (!workshop_id || !amount) return res.status(400).json({ error: 'Workshop and amount are required' });

    const invNum = `INV-${Date.now().toString(36).toUpperCase()}`;
    const result = await execute(
      `INSERT INTO platform_invoices (workshop_id, invoice_number, amount, currency, billing_period_start, billing_period_end, due_date, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [workshop_id, invNum, amount, currency || 'AED', billing_period_start, billing_period_end, due_date, notes]
    );

    await logAudit(req, 'invoice_created', 'platform_invoice', result.insertId, { workshop_id, amount });
    res.status(201).json({ id: result.insertId, invoice_number: invNum });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Update invoice status
router.put('/invoices/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { status, paid_at, payment_method, notes } = req.body;
    await execute(`
      UPDATE platform_invoices SET
        status = COALESCE(?, status),
        paid_at = COALESCE(?, paid_at),
        payment_method = COALESCE(?, payment_method),
        notes = COALESCE(?, notes)
      WHERE id = ?
    `, [status, status === 'paid' ? (paid_at || new Date()) : paid_at, payment_method, notes, req.params.id]);

    await logAudit(req, 'invoice_updated', 'platform_invoice', parseInt(req.params.id), { status });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});


// ══════════════════════════════════════════════════════════════
//  3. ANNOUNCEMENTS / WORKSHOP COMMUNICATION
// ══════════════════════════════════════════════════════════════
router.get('/announcements', verifySuperAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const announcements = await query(`
      SELECT a.*, sa.full_name as created_by_name
      FROM announcements a
      LEFT JOIN super_admins sa ON a.created_by = sa.id
      ORDER BY a.is_pinned DESC, a.created_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), offset]);

    const total = await query('SELECT COUNT(*) as c FROM announcements');
    res.json({ announcements: announcements || [], total: total[0]?.c || 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

router.post('/announcements', verifySuperAdmin, async (req, res) => {
  try {
    const { title, message, type, target, tenant_ids, is_pinned, expires_at, send_email } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required' });

    const result = await execute(
      `INSERT INTO announcements (title, message, type, target, tenant_ids, is_pinned, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, message, type || 'info', target || 'all', tenant_ids ? JSON.stringify(tenant_ids) : null, is_pinned || false, expires_at, req.superAdmin.id]
    );

    // Optionally send email to workshops
    if (send_email) {
      let workshops;
      if (target === 'specific' && tenant_ids?.length) {
        workshops = await query(`SELECT email, name FROM workshops WHERE id IN (${tenant_ids.map(() => '?').join(',')}) AND email IS NOT NULL`, tenant_ids);
      } else {
        workshops = await query('SELECT email, name FROM workshops WHERE status = "active" AND email IS NOT NULL');
      }

      for (const t of workshops) {
        try {
          await sendNotificationEmail({
            to: t.email,
            subject: `[Pioneer] ${title}`,
            title: title,
            body: `<p>${message}</p><p>— Pioneer Team</p>`,
          });
        } catch (_) {}
      }
    }

    await logAudit(req, 'announcement_created', 'announcement', result.insertId, { title, target });
    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

router.put('/announcements/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { title, message, type, is_active, is_pinned, expires_at } = req.body;
    await execute(`
      UPDATE announcements SET
        title = COALESCE(?, title), message = COALESCE(?, message),
        type = COALESCE(?, type), is_active = COALESCE(?, is_active),
        is_pinned = COALESCE(?, is_pinned), expires_at = COALESCE(?, expires_at)
      WHERE id = ?
    `, [title, message, type, is_active, is_pinned, expires_at, req.params.id]);

    await logAudit(req, 'announcement_updated', 'announcement', parseInt(req.params.id), { title });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.delete('/announcements/:id', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM announcements WHERE id = ?', [req.params.id]);
    await logAudit(req, 'announcement_deleted', 'announcement', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});


// ══════════════════════════════════════════════════════════════
//  4. BULK OPERATIONS
// ══════════════════════════════════════════════════════════════

// Bulk toggle workshop status
router.post('/bulk/toggle-status', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_ids, status } = req.body;
    if (!tenant_ids?.length || !status) return res.status(400).json({ error: 'tenant_ids and status are required' });

    const validStatuses = ['active', 'suspended', 'trial'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const placeholders = tenant_ids.map(() => '?').join(',');
    await execute(`UPDATE workshops SET status = ? WHERE id IN (${placeholders})`, [status, ...tenant_ids]);

    // If suspending, deactivate all users. If activating, reactivate them.
    if (status === 'suspended') {
      await execute(`UPDATE users SET is_active = 0 WHERE workshop_id IN (${placeholders})`, tenant_ids);
    } else if (status === 'active') {
      await execute(`UPDATE users SET is_active = 1 WHERE workshop_id IN (${placeholders})`, tenant_ids);
    }

    await logAudit(req, 'bulk_status_change', 'workshop', null, { tenant_ids, status, count: tenant_ids.length });

    res.json({ success: true, message: `${tenant_ids.length} workshops updated to ${status}` });
  } catch (error) {
    res.status(500).json({ error: 'Bulk operation failed' });
  }
});

// Bulk assign modules
router.post('/bulk/assign-modules', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_ids, modules, mode } = req.body; // mode: 'set' | 'add' | 'remove'
    if (!tenant_ids?.length || !modules?.length) return res.status(400).json({ error: 'tenant_ids and modules are required' });

    for (const workshopId of tenant_ids) {
      if (mode === 'set') {
        await execute('UPDATE workshops SET settings = JSON_SET(COALESCE(settings, "{}"), "$.allowed_modules", CAST(? AS JSON)) WHERE id = ?',
          [JSON.stringify(modules), workshopId]);
      } else if (mode === 'add') {
        const current = await query('SELECT settings FROM workshops WHERE id = ?', [workshopId]);
        const settings = JSON.parse(current[0]?.settings || '{}');
        const existing = settings.allowed_modules || [];
        const merged = [...new Set([...existing, ...modules])];
        await execute('UPDATE workshops SET settings = JSON_SET(COALESCE(settings, "{}"), "$.allowed_modules", CAST(? AS JSON)) WHERE id = ?',
          [JSON.stringify(merged), workshopId]);
      } else if (mode === 'remove') {
        const current = await query('SELECT settings FROM workshops WHERE id = ?', [workshopId]);
        const settings = JSON.parse(current[0]?.settings || '{}');
        const existing = settings.allowed_modules || [];
        const filtered = existing.filter(m => !modules.includes(m));
        await execute('UPDATE workshops SET settings = JSON_SET(COALESCE(settings, "{}"), "$.allowed_modules", CAST(? AS JSON)) WHERE id = ?',
          [JSON.stringify(filtered), workshopId]);
      }
    }

    await logAudit(req, 'bulk_module_change', 'workshop', null, { tenant_ids, modules, mode, count: tenant_ids.length });
    res.json({ success: true, message: `Modules ${mode} for ${tenant_ids.length} workshops` });
  } catch (error) {
    res.status(500).json({ error: 'Bulk module operation failed' });
  }
});

// Bulk assign plan
router.post('/bulk/assign-plan', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_ids, plan, plan_id, max_users } = req.body;
    const planValue = plan || plan_id;
    if (!tenant_ids?.length || !planValue) return res.status(400).json({ error: 'tenant_ids and plan (or plan_id) are required' });

    const placeholders = tenant_ids.map(() => '?').join(',');

    if (max_users) {
      await execute(`UPDATE subscriptions SET plan = ?, max_users = ? WHERE workshop_id IN (${placeholders})`, [String(planValue), max_users, ...tenant_ids]);
    } else {
      await execute(`UPDATE subscriptions SET plan = ? WHERE workshop_id IN (${placeholders})`, [String(planValue), ...tenant_ids]);
    }

    await logAudit(req, 'bulk_plan_change', 'subscription', null, { tenant_ids, plan: planValue, count: tenant_ids.length });
    res.json({ success: true, message: `Plan set for ${tenant_ids.length} workshops` });
  } catch (error) {
    res.status(500).json({ error: 'Bulk plan assignment failed' });
  }
});

// Bulk delete workshops
router.post('/bulk/delete', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_ids, confirm } = req.body;
    if (!tenant_ids?.length) return res.status(400).json({ error: 'tenant_ids required' });
    if (confirm !== 'DELETE_CONFIRMED') return res.status(400).json({ error: 'Please confirm deletion with confirm: "DELETE_CONFIRMED"' });

    for (const id of tenant_ids) {
      await execute('DELETE FROM subscriptions WHERE workshop_id = ?', [id]);
      await execute('DELETE FROM users WHERE workshop_id = ?', [id]);
      try { await execute('DELETE FROM work_orders WHERE workshop_id = ?', [id]); } catch (_) {}
      try { await execute('DELETE FROM customers WHERE workshop_id = ?', [id]); } catch (_) {}
      try { await execute('DELETE FROM service_bays WHERE workshop_id = ?', [id]); } catch (_) {}
      await execute('DELETE FROM workshops WHERE id = ?', [id]);
    }

    await logAudit(req, 'bulk_workshop_delete', 'workshop', null, { tenant_ids, count: tenant_ids.length });
    res.json({ success: true, message: `${tenant_ids.length} workshops deleted permanently` });
  } catch (error) {
    res.status(500).json({ error: 'Bulk delete failed' });
  }
});


// ══════════════════════════════════════════════════════════════
//  5. SYSTEM HEALTH & MONITORING
// ══════════════════════════════════════════════════════════════
router.get('/system-health', verifySuperAdmin, async (req, res) => {
  try {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const cpus = os.cpus();

    // Database stats
    let dbStats = {};
    try {
      const dbSize = await query(`
        SELECT
          ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) as size_mb,
          SUM(TABLE_ROWS) as total_rows
        FROM information_schema.tables
        WHERE table_schema = ?
      `, [config.db?.database || 'pioneer_workshop']);

      const tableCount = await query(`
        SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = ?
      `, [config.db?.database || 'pioneer_workshop']);

      const processlist = await query('SHOW PROCESSLIST');

      dbStats = {
        size_mb: dbSize[0]?.size_mb || 0,
        total_rows: dbSize[0]?.total_rows || 0,
        table_count: tableCount[0]?.count || 0,
        active_connections: processlist?.length || 0
      };
    } catch (_) {}

    // Recent errors (from audit log)
    let recentErrors = 0;
    try {
      const errCount = await query(`SELECT COUNT(*) as c FROM sa_audit_logs WHERE action LIKE '%error%' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
      recentErrors = errCount[0]?.c || 0;
    } catch (_) {}

    // Workshop activity
    let activeWorkshopsToday = 0;
    try {
      const at = await query(`SELECT COUNT(DISTINCT workshop_id) as c FROM users WHERE last_login_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
      activeWorkshopsToday = at[0]?.c || 0;
    } catch (_) {}

    res.json({
      server: {
        platform: os.platform(),
        arch: os.arch(),
        hostname: os.hostname(),
        node_version: process.version,
        uptime_seconds: Math.floor(uptime),
        uptime_formatted: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        load_average: os.loadavg().map(l => l.toFixed(2)),
        cpu_count: cpus.length,
        cpu_model: cpus[0]?.model || 'Unknown'
      },
      memory: {
        total_mb: Math.round(os.totalmem() / 1024 / 1024),
        free_mb: Math.round(os.freemem() / 1024 / 1024),
        used_mb: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        usage_percent: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(1),
        process_rss_mb: Math.round(memUsage.rss / 1024 / 1024),
        process_heap_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
        process_heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024)
      },
      database: dbStats,
      activity: {
        active_workshops_today: activeWorkshopsToday,
        recent_errors: recentErrors
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('System health error:', error);
    res.status(500).json({ error: 'Failed to fetch system health' });
  }
});

// Database table sizes
router.get('/system-health/tables', verifySuperAdmin, async (req, res) => {
  try {
    const dbName = config.db?.database || config.database?.name || process.env.DB_NAME || 'pioneer_workshop';
    const tables = await query(
      'SELECT TABLE_NAME as name, TABLE_ROWS as `rows`, ROUND(data_length / 1024 / 1024, 2) as data_mb, ROUND(index_length / 1024 / 1024, 2) as index_mb, ROUND((data_length + index_length) / 1024 / 1024, 2) as total_mb FROM information_schema.tables WHERE table_schema = ? ORDER BY (data_length + index_length) DESC',
      [dbName]
    );

    res.json(tables || []);
  } catch (error) {
    console.error('Table stats error:', error.message);
    res.status(500).json({ error: 'Failed to fetch table stats' });
  }
});


// ══════════════════════════════════════════════════════════════
//  6. EMAIL TEMPLATE MANAGEMENT
// ══════════════════════════════════════════════════════════════
router.get('/email-templates', verifySuperAdmin, async (req, res) => {
  try {
    const templates = await query('SELECT * FROM sa_email_templates ORDER BY category, name');
    res.json(templates || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

router.post('/email-templates', verifySuperAdmin, async (req, res) => {
  try {
    const { name, slug, subject, body, variables, category } = req.body;
    if (!name || !slug || !subject || !body) return res.status(400).json({ error: 'Name, slug, subject, and body are required' });

    const result = await execute(
      `INSERT INTO sa_email_templates (name, slug, subject, body, variables, category) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, slug, subject, body, JSON.stringify(variables || []), category || 'custom']
    );

    await logAudit(req, 'template_created', 'email_template', result.insertId, { name, slug });
    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Template slug already exists' });
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/email-templates/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { name, subject, body, variables, category, is_active } = req.body;
    await execute(`
      UPDATE sa_email_templates SET
        name = COALESCE(?, name), subject = COALESCE(?, subject),
        body = COALESCE(?, body), variables = COALESCE(?, variables),
        category = COALESCE(?, category), is_active = COALESCE(?, is_active)
      WHERE id = ?
    `, [name, subject, body, variables ? JSON.stringify(variables) : null, category, is_active, req.params.id]);

    await logAudit(req, 'template_updated', 'email_template', parseInt(req.params.id), { name });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/email-templates/:id', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM sa_email_templates WHERE id = ?', [req.params.id]);
    await logAudit(req, 'template_deleted', 'email_template', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Toggle template active/inactive
router.patch('/email-templates/:id/toggle', verifySuperAdmin, async (req, res) => {
  try {
    await execute('UPDATE sa_email_templates SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    const rows = await query('SELECT is_active FROM sa_email_templates WHERE id = ?', [req.params.id]);
    await logAudit(req, 'template_toggled', 'email_template', parseInt(req.params.id), { is_active: rows[0]?.is_active });
    res.json({ success: true, is_active: rows[0]?.is_active });
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle template' });
  }
});

// Duplicate template
router.post('/email-templates/:id/duplicate', verifySuperAdmin, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM sa_email_templates WHERE id = ?', [req.params.id]);
    if (!rows?.length) return res.status(404).json({ error: 'Template not found' });
    const t = rows[0];
    const newSlug = `${t.slug}_copy_${Date.now()}`;
    const result = await execute(
      'INSERT INTO sa_email_templates (name, slug, subject, body, variables, category, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [`${t.name} (Copy)`, newSlug, t.subject, t.body, t.variables, t.category, false]
    );
    await logAudit(req, 'template_duplicated', 'email_template', result.insertId, { source_id: t.id });
    res.status(201).json({ id: result.insertId, slug: newSlug, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to duplicate template' });
  }
});

// Fetch all available recipients grouped by source
router.get('/email-templates/recipients', verifySuperAdmin, async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const source = req.query.source || 'all';

    let workshops = [], contacts = [], trials = [];

    if (source === 'all' || source === 'tenants') {
      const workshopQuery = search
        ? 'SELECT id, name, email, status FROM workshops WHERE email IS NOT NULL AND email != "" AND (name LIKE ? OR email LIKE ?) ORDER BY name'
        : 'SELECT id, name, email, status FROM workshops WHERE email IS NOT NULL AND email != "" ORDER BY name';
      workshops = await query(workshopQuery, search ? [search, search] : []);
    }

    if (source === 'all' || source === 'contacts') {
      const contactQuery = search
        ? 'SELECT id, first_name, last_name, email, status FROM landing_contacts WHERE email IS NOT NULL AND email != "" AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?) ORDER BY created_at DESC'
        : 'SELECT id, first_name, last_name, email, status FROM landing_contacts WHERE email IS NOT NULL AND email != "" ORDER BY created_at DESC';
      contacts = await query(contactQuery, search ? [search, search, search] : []);
    }

    if (source === 'all' || source === 'trials') {
      const trialQuery = search
        ? 'SELECT id, first_name, last_name, email, company_name, status FROM trial_requests WHERE email IS NOT NULL AND email != "" AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ?) ORDER BY created_at DESC'
        : 'SELECT id, first_name, last_name, email, company_name, status FROM trial_requests WHERE email IS NOT NULL AND email != "" ORDER BY created_at DESC';
      trials = await query(trialQuery, search ? [search, search, search, search] : []);
    }

    res.json({
      tenants: (workshops || []).map(t => ({ id: t.id, name: t.name, email: t.email, type: 'workshop', status: t.status })),
      contacts: (contacts || []).map(c => ({ id: c.id, name: `${c.first_name} ${c.last_name}`.trim(), email: c.email, type: 'contact', status: c.status })),
      trials: (trials || []).map(t => ({ id: t.id, name: `${t.first_name} ${t.last_name}`.trim(), email: t.email, company: t.company_name, type: 'trial', status: t.status })),
    });
  } catch (error) {
    console.error('Fetch recipients error:', error);
    res.status(500).json({ error: 'Failed to fetch recipients' });
  }
});

// Send test email
router.post('/email-templates/:id/test', verifySuperAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient email required' });

    const templates = await query('SELECT * FROM sa_email_templates WHERE id = ?', [req.params.id]);
    if (!templates?.length) return res.status(404).json({ error: 'Template not found' });

    const template = templates[0];
    let body = template.body;
    let subject = template.subject;
    const vars = JSON.parse(template.variables || '[]');
    for (const v of vars) {
      const re = new RegExp(`\\{\\{${v}\\}\\}`, 'g');
      body = body.replace(re, `[Sample: ${v}]`);
      subject = subject.replace(re, `[Sample: ${v}]`);
    }

    await sendNotificationEmail({ to, subject: `[TEST] ${subject}`, title: subject, body });
    await logAudit(req, 'template_test_sent', 'email_template', parseInt(req.params.id), { to });
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// Send template email to selected recipients
router.post('/email-templates/:id/send', verifySuperAdmin, async (req, res) => {
  try {
    const { recipients, customVariables } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'At least one recipient is required' });
    }

    // Limit bulk send to 100 recipients at a time
    if (recipients.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 recipients per send' });
    }

    const templates = await query('SELECT * FROM sa_email_templates WHERE id = ?', [req.params.id]);
    if (!templates?.length) return res.status(404).json({ error: 'Template not found' });
    if (!templates[0].is_active) return res.status(400).json({ error: 'Template is disabled. Enable it before sending.' });

    const template = templates[0];
    const vars = JSON.parse(template.variables || '[]');
    const results = { sent: 0, failed: 0, errors: [] };

    for (const recipient of recipients) {
      try {
        let body = template.body;
        let subject = template.subject;

        // Build variable map for this recipient
        const varMap = {
          workshop_name: recipient.name || '',
          name: recipient.name || '',
          first_name: (recipient.name || '').split(' ')[0] || '',
          last_name: (recipient.name || '').split(' ').slice(1).join(' ') || '',
          email: recipient.email || '',
          company_name: recipient.company || recipient.name || '',
          ...(customVariables || {}),
        };

        for (const v of vars) {
          const re = new RegExp(`\\{\\{${v}\\}\\}`, 'g');
          const replacement = varMap[v] || customVariables?.[v] || '';
          body = body.replace(re, replacement);
          subject = subject.replace(re, replacement);
        }

        const result = await sendNotificationEmail({
          to: recipient.email,
          subject,
          title: subject,
          body,
        });

        if (result.success) results.sent++;
        else { results.failed++; results.errors.push({ email: recipient.email, error: result.error }); }
      } catch (err) {
        results.failed++;
        results.errors.push({ email: recipient.email, error: err.message });
      }
    }

    await logAudit(req, 'template_bulk_sent', 'email_template', parseInt(req.params.id), {
      total: recipients.length, sent: results.sent, failed: results.failed,
    });

    res.json({ success: true, ...results });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ error: 'Failed to send emails' });
  }
});


// ══════════════════════════════════════════════════════════════
//  7. REVENUE & FINANCIAL DASHBOARD
// ══════════════════════════════════════════════════════════════
router.get('/revenue', verifySuperAdmin, async (req, res) => {
  try {
    // MRR (Monthly Recurring Revenue) — sum of active monthly subscriptions
    const mrr = await query(`
      SELECT COALESCE(SUM(CASE WHEN billing_cycle='monthly' THEN price_monthly ELSE price_yearly/12 END), 0) as mrr
      FROM subscriptions WHERE status = 'active'
    `);

    // Total revenue from paid invoices
    const totalRevenue = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM platform_invoices WHERE status = 'paid'`);

    // Outstanding invoices
    const outstanding = await query(`SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM platform_invoices WHERE status IN ('sent','overdue')`);

    // Revenue by month (last 12 months)
    const revenueByMonth = await query(`
      SELECT
        DATE_FORMAT(paid_at, '%Y-%m') as month,
        SUM(amount) as revenue,
        COUNT(*) as invoices_paid
      FROM platform_invoices
      WHERE status = 'paid' AND paid_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(paid_at, '%Y-%m')
      ORDER BY month ASC
    `);

    // Revenue per plan
    const revenueByPlan = await query(`
      SELECT s.plan, COUNT(*) as workshop_count,
        SUM(CASE WHEN s.billing_cycle='monthly' THEN s.price_monthly ELSE s.price_yearly/12 END) as monthly_revenue
      FROM subscriptions s
      WHERE s.status = 'active'
      GROUP BY s.plan
    `);

    // Top paying workshops
    const topPayers = await query(`
      SELECT t.id, t.name, t.status,
        COALESCE(SUM(pi.amount), 0) as total_paid,
        MAX(s.plan) as plan, MAX(s.price_monthly) as price_monthly
      FROM workshops t
      LEFT JOIN platform_invoices pi ON pi.workshop_id = t.id AND pi.status = 'paid'
      LEFT JOIN subscriptions s ON s.workshop_id = t.id
      GROUP BY t.id, t.name, t.status
      ORDER BY total_paid DESC
      LIMIT 10
    `);

    // Subscription distribution
    const planDistribution = await query(`
      SELECT plan, COUNT(*) as count FROM subscriptions GROUP BY plan
    `);

    res.json({
      mrr: mrr[0]?.mrr || 0,
      arr: (mrr[0]?.mrr || 0) * 12,
      totalRevenue: totalRevenue[0]?.total || 0,
      outstanding: { amount: outstanding[0]?.total || 0, count: outstanding[0]?.count || 0 },
      revenueByMonth: revenueByMonth || [],
      revenueByPlan: revenueByPlan || [],
      topPayers: topPayers || [],
      planDistribution: planDistribution || []
    });
  } catch (error) {
    console.error('Revenue error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue data' });
  }
});


// ══════════════════════════════════════════════════════════════
//  9. BACKUP & DATA EXPORT
// ══════════════════════════════════════════════════════════════

// Export workshop data as JSON
router.get('/export/tenant/:id', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.id;
    const workshop = await query('SELECT * FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop?.length) return res.status(404).json({ error: 'Workshop not found' });

    const users = await query('SELECT id, username, email, full_name, role, is_active, created_at FROM users WHERE workshop_id = ?', [workshopId]);
    const workOrders = await query('SELECT * FROM work_orders WHERE workshop_id = ?', [workshopId]);
    const customers = await query('SELECT * FROM customers WHERE workshop_id = ?', [workshopId]);
    const subscription = await query('SELECT * FROM subscriptions WHERE workshop_id = ?', [workshopId]);

    let serviceBays = [];
    try { serviceBays = await query('SELECT * FROM service_bays WHERE workshop_id = ?', [workshopId]); } catch (_) {}

    const exportData = {
      exported_at: new Date().toISOString(),
      exported_by: req.superAdmin.full_name,
      workshop: workshop[0],
      subscription: subscription[0] || null,
      users: users || [],
      work_orders: workOrders || [],
      customers: customers || [],
      service_bays: serviceBays || [],
      summary: {
        total_users: users?.length || 0,
        total_work_orders: workOrders?.length || 0,
        total_customers: customers?.length || 0,
        total_service_bays: serviceBays?.length || 0
      }
    };

    await logAudit(req, 'workshop_data_exported', 'workshop', parseInt(workshopId), { user_count: users.length, work_order_count: workOrders.length });

    res.setHeader('Content-Disposition', `attachment; filename=workshop_${workshopId}_export_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    res.status(500).json({ error: 'Failed to export workshop data' });
  }
});

// Export all workshops summary as CSV
router.get('/export/tenants-csv', verifySuperAdmin, async (req, res) => {
  try {
    const workshops = await query(`
      SELECT t.id, t.name, t.slug, t.email, t.phone, t.city, t.country, t.status, t.created_at,
        s.plan, s.max_users, s.price_monthly,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id) as user_count,
        (SELECT COUNT(*) FROM work_orders WHERE workshop_id = t.id) as work_order_count
      FROM workshops t
      LEFT JOIN subscriptions s ON s.workshop_id = t.id
      ORDER BY t.created_at DESC
    `);

    const headers = 'ID,Name,Slug,Email,Phone,City,Country,Status,Plan,Max Users,Monthly Price,Users,Work Orders,Created At\n';
    const rows = workshops.map(t =>
      `${t.id},"${t.name || ''}","${t.slug || ''}","${t.email || ''}","${t.phone || ''}","${t.city || ''}","${t.country || ''}",${t.status},${t.plan || ''},${t.max_users || ''},${t.price_monthly || ''},${t.user_count},${t.work_order_count},"${t.created_at}"`
    ).join('\n');

    await logAudit(req, 'workshops_csv_exported', 'workshop', null, { count: workshops.length });

    res.setHeader('Content-Disposition', `attachment; filename=workshops_export_${Date.now()}.csv`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(headers + rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

// Export audit logs
router.get('/export/audit-logs', verifySuperAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND created_at >= ?'; params.push(from); }
    if (to) { where += ' AND created_at <= ?'; params.push(to + ' 23:59:59'); }

    const logs = await query(`SELECT * FROM sa_audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT 10000`, params);

    await logAudit(req, 'audit_logs_exported', 'audit_log', null, { count: logs.length });

    res.setHeader('Content-Disposition', `attachment; filename=audit_logs_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(logs, null, 2));
  } catch (error) {
    res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

// Platform summary export
router.get('/export/platform-summary', verifySuperAdmin, async (req, res) => {
  try {
    const workshops = await query('SELECT COUNT(*) as c FROM workshops');
    const users = await query('SELECT COUNT(*) as c FROM users');
    const workOrders = await query('SELECT COUNT(*) as c FROM work_orders');
    const revenue = await query(`SELECT COALESCE(SUM(amount), 0) as total FROM platform_invoices WHERE status = 'paid'`);
    const subscriptions = await query('SELECT plan, COUNT(*) as count FROM subscriptions GROUP BY plan');
    const topWorkshops = await query(`
      SELECT t.name, t.status, COUNT(o.id) as work_orders,
        (SELECT COUNT(*) FROM users WHERE workshop_id = t.id) as users
      FROM workshops t
      LEFT JOIN work_orders o ON o.workshop_id = t.id
      GROUP BY t.id ORDER BY work_orders DESC LIMIT 20
    `);

    const summary = {
      generated_at: new Date().toISOString(),
      generated_by: req.superAdmin.full_name,
      platform: {
        total_workshops: workshops[0]?.c || 0,
        total_users: users[0]?.c || 0,
        total_work_orders: workOrders[0]?.c || 0,
        total_revenue: revenue[0]?.total || 0
      },
      subscriptions: subscriptions || [],
      top_workshops: topWorkshops || []
    };

    res.setHeader('Content-Disposition', `attachment; filename=platform_summary_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(summary, null, 2));
  } catch (error) {
    res.status(500).json({ error: 'Failed to export platform summary' });
  }
});


// ══════════════════════════════════════════════════════════════
//  10. WORKSHOP ONBOARDING WIZARD
// ══════════════════════════════════════════════════════════════
router.post('/onboard-tenant', verifySuperAdmin, async (req, res) => {
  try {
    // Support both nested (wizard UI) and flat payload formats
    const body = req.body;
    const company = body.company || {};
    const planObj = body.plan || {};
    const adminObj = body.admin || {};
    const brandingObj = body.branding || {};

    // Resolve fields — nested values take priority, fallback to flat
    const name            = company.name      || body.name;
    const domain          = company.domain     || body.domain || '';
    const email           = company.email      || body.email;
    const phone           = company.phone      || body.phone || null;
    const city            = company.city       || body.city || null;
    const country         = company.country    || body.country || null;
    const industry        = company.industry   || body.industry || null;

    const plan            = planObj.plan_id     || body.plan_id || (typeof body.plan === 'string' ? body.plan : null) || 'starter';
    const max_users       = planObj.max_users   || body.max_users || 5;
    const billing_cycle   = planObj.billing_cycle || body.billing_cycle || 'monthly';
    const price_monthly   = body.price_monthly || 0;
    const price_yearly    = body.price_yearly || 0;

    const modules         = body.modules       || body.allowed_modules || [];

    const admin_full_name = adminObj.name       || body.admin_full_name || body.admin_name || '';
    const admin_email     = adminObj.email      || body.admin_email;
    const admin_password  = adminObj.password   || body.admin_password;
    const admin_username  = body.admin_username || admin_email; // default username to email
    const send_welcome_email = adminObj.send_welcome_email ?? body.send_welcome_email ?? false;

    const primary_color   = brandingObj.primary_color   || body.primary_color || '#f97316';
    const secondary_color = brandingObj.secondary_color  || body.secondary_color || '#1e293b';
    const accent_color    = brandingObj.accent_color     || body.accent_color || '#3b82f6';
    const sidebar_color   = brandingObj.sidebar_color    || body.sidebar_color || '#1e293b';
    const font_family     = brandingObj.font_family      || body.font_family || 'Inter';
    const logo_url        = brandingObj.logo_url         || body.logo_url || null;
    const favicon_url     = brandingObj.favicon_url      || body.favicon_url || null;

    // Auto-generate slug from name if not provided
    const slug = body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    if (!name || !admin_email || !admin_password) {
      return res.status(400).json({ error: 'Company name, admin email and admin password are required' });
    }

    // 1. Create workshop
    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, domain, email, phone, city, country, industry, status, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [name, slug, domain || null, email, phone, city, country, industry,
        JSON.stringify({ allowed_modules: modules })]
    );
    const workshopId = workshopResult.insertId;

    // 2. Create subscription
    const safeCycle = billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, max_users, billing_cycle, price_monthly, price_yearly, status, started_at, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [workshopId, typeof plan === 'number' ? 'starter' : (plan || 'starter'), max_users, safeCycle, price_monthly, price_yearly, safeCycle === 'yearly' ? 365 : 30]
    );

    // 3. Create admin user
    const hash = await bcrypt.hash(admin_password, 10);
    await execute(
      `INSERT INTO users (workshop_id, username, password, email, full_name, role, is_active, is_owner) VALUES (?, ?, ?, ?, ?, 'admin', 1, 1)`,
      [workshopId, admin_username, hash, admin_email, admin_full_name || admin_username]
    );

    // 4. Branding
    await execute(
      `INSERT INTO tenant_branding (workshop_id, primary_color, secondary_color, accent_color, sidebar_color, font_family, logo_url, favicon_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workshopId, primary_color, secondary_color, accent_color, sidebar_color, font_family, logo_url, favicon_url]
    );

    // 5. Send welcome email
    if (send_welcome_email && (admin_email || email)) {
      try {
        const loginUrl = `https://dispatch.pioneercarservice.com/login`;
        const recipient = admin_email || email;
        await sendNotificationEmail({
          to: recipient,
          subject: 'Welcome to Pioneer — Your Workshop Platform is Ready!',
          title: `🎉 Welcome to Pioneer, ${name}!`,
          body: `
            <p>Your workshop management platform has been set up and is ready to use.</p>
            <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;">
              <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
              <p><strong>Username:</strong> ${admin_username}</p>
              <p><strong>Password:</strong> ${admin_password}</p>
            </div>
            <p>Plan: <strong>${typeof plan === 'string' ? plan : 'Starter'}</strong></p>
            <p>If you need help, reply to this email or contact support@pioneercarservice.com</p>`,
          ctaText: 'Login Now',
          ctaUrl: loginUrl,
        });
        console.log(`✅ Welcome email sent to ${recipient}`);
      } catch (emailErr) {
        console.error(`❌ Failed to send welcome email:`, emailErr.message);
      }
    }

    await logAudit(req, 'workshop_onboarded', 'workshop', workshopId, { name, plan, modules: modules.length });

    res.status(201).json({
      success: true,
      workshop_id: workshopId,
      message: `Workshop "${name}" onboarded successfully`,
      details: {
        slug,
        plan: typeof plan === 'string' ? plan : 'starter',
        modules: modules.length,
        welcome_email_sent: !!(send_welcome_email && (admin_email || email))
      }
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      const msg = error.message.includes('slug') ? 'A workshop with this name/slug already exists'
        : error.message.includes('email') ? 'Admin email already exists'
        : error.message.includes('username') ? 'Admin username already exists'
        : 'Workshop slug or admin email already exists';
      return res.status(409).json({ error: msg });
    }
    console.error('Onboarding error:', error);
    res.status(500).json({ error: 'Workshop onboarding failed' });
  }
});


// ══════════════════════════════════════════════════════════════
//  11. SUPPORT TICKETS
// ══════════════════════════════════════════════════════════════
router.get('/tickets', verifySuperAdmin, async (req, res) => {
  try {
    const { status, priority, category, page = 1, limit = 50, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = '1=1';
    const params = [];

    if (status) { where += ' AND t.status = ?'; params.push(status); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }
    if (category) { where += ' AND t.category = ?'; params.push(category); }
    if (search) { where += ' AND (t.subject LIKE ? OR t.workshop_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const tickets = await query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM ticket_replies WHERE ticket_id = t.id) as reply_count
      FROM support_tickets t
      WHERE ${where}
      ORDER BY FIELD(t.priority, 'critical','high','medium','low'), t.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    const total = await query(`SELECT COUNT(*) as c FROM support_tickets t WHERE ${where}`, params);

    // Stats
    const stats = await query(`
      SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_count,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting_count,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
        SUM(CASE WHEN priority = 'critical' AND status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) as critical_open
      FROM support_tickets
    `);

    res.json({ tickets: tickets || [], total: total[0]?.c || 0, stats: stats[0] || {} });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get single ticket with replies
router.get('/tickets/:id', verifySuperAdmin, async (req, res) => {
  try {
    const ticket = await query('SELECT * FROM support_tickets WHERE id = ?', [req.params.id]);
    if (!ticket?.length) return res.status(404).json({ error: 'Ticket not found' });

    const replies = await query('SELECT * FROM ticket_replies WHERE ticket_id = ? ORDER BY created_at ASC', [req.params.id]);
    res.json({ ticket: ticket[0], replies: replies || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// Create ticket (from super admin panel — on behalf of workshop or internally)
router.post('/tickets', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_id, subject, description, category, priority } = req.body;
    if (!subject) return res.status(400).json({ error: 'Subject is required' });

    let workshopName = null;
    if (tenant_id) {
      const t = await query('SELECT name FROM workshops WHERE id = ?', [tenant_id]);
      workshopName = t[0]?.name;
    }

    const result = await execute(
      `INSERT INTO support_tickets (workshop_id, workshop_name, user_name, subject, description, category, priority, assigned_to, assigned_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenant_id, workshopName, req.superAdmin.full_name, subject, description, category || 'other', priority || 'medium', req.superAdmin.id, req.superAdmin.full_name]
    );

    await logAudit(req, 'ticket_created', 'support_ticket', result.insertId, { subject, tenant_id });
    res.status(201).json({ id: result.insertId, success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Update ticket
router.put('/tickets/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { status, priority, assigned_to, resolution, category } = req.body;

    let assignedName = null;
    if (assigned_to) {
      const admin = await query('SELECT full_name FROM super_admins WHERE id = ?', [assigned_to]);
      assignedName = admin[0]?.full_name;
    }

    await execute(`
      UPDATE support_tickets SET
        status = COALESCE(?, status), priority = COALESCE(?, priority),
        assigned_to = COALESCE(?, assigned_to), assigned_name = COALESCE(?, assigned_name),
        category = COALESCE(?, category), resolution = COALESCE(?, resolution),
        resolved_at = CASE WHEN ? IN ('resolved','closed') THEN NOW() ELSE resolved_at END
      WHERE id = ?
    `, [status, priority, assigned_to, assignedName, category, resolution, status, req.params.id]);

    await logAudit(req, 'ticket_updated', 'support_ticket', parseInt(req.params.id), { status, priority });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// Add reply to ticket
router.post('/tickets/:id/reply', verifySuperAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    await execute(
      `INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, sender_name, message) VALUES (?, 'admin', ?, ?, ?)`,
      [req.params.id, req.superAdmin.id, req.superAdmin.full_name, message]
    );

    // Update ticket status to in_progress if it was open
    await execute(`UPDATE support_tickets SET status = 'in_progress' WHERE id = ? AND status = 'open'`, [req.params.id]);

    await logAudit(req, 'ticket_reply_added', 'support_ticket', parseInt(req.params.id));
    res.status(201).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// Delete ticket
router.delete('/tickets/:id', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM support_tickets WHERE id = ?', [req.params.id]);
    await logAudit(req, 'ticket_deleted', 'support_ticket', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete ticket' });
  }
});


// ══════════════════════════════════════════════════════════════
//  12. CUSTOM BRANDING PER WORKSHOP
// ══════════════════════════════════════════════════════════════
router.get('/branding', verifySuperAdmin, async (req, res) => {
  try {
    const brandings = await query(`
      SELECT tb.*, t.name as workshop_name, t.status as workshop_status
      FROM tenant_branding tb
      LEFT JOIN workshops t ON tb.workshop_id = t.id
      ORDER BY t.name ASC
    `);

    // Get workshops without branding
    const unbrandedWorkshops = await query(`
      SELECT t.id, t.name, t.status FROM workshops t
      WHERE t.id NOT IN (SELECT workshop_id FROM tenant_branding)
      ORDER BY t.name ASC
    `);

    res.json({ brandings: brandings || [], unbrandedTenants: unbrandedWorkshops || [] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch branding' });
  }
});

// Get branding for specific workshop
router.get('/branding/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const branding = await query('SELECT * FROM tenant_branding WHERE workshop_id = ?', [req.params.tenantId]);
    if (!branding?.length) {
      return res.json({
        workshop_id: parseInt(req.params.tenantId),
        primary_color: '#f97316',
        secondary_color: '#1e293b',
        accent_color: '#3b82f6',
        sidebar_color: '#1e293b',
        font_family: 'Inter'
      });
    }
    res.json(branding[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch workshop branding' });
  }
});

// Create or update branding
router.put('/branding/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const workshopId = req.params.tenantId;
    const { primary_color, secondary_color, accent_color, sidebar_color, font_family, logo_url, favicon_url, custom_domain, custom_css } = req.body;

    const existing = await query('SELECT id FROM tenant_branding WHERE workshop_id = ?', [workshopId]);

    if (existing?.length) {
      await execute(`
        UPDATE tenant_branding SET
          primary_color = COALESCE(?, primary_color),
          secondary_color = COALESCE(?, secondary_color),
          accent_color = COALESCE(?, accent_color),
          sidebar_color = COALESCE(?, sidebar_color),
          font_family = COALESCE(?, font_family),
          logo_url = COALESCE(?, logo_url),
          favicon_url = COALESCE(?, favicon_url),
          custom_domain = COALESCE(?, custom_domain),
          custom_css = COALESCE(?, custom_css)
        WHERE workshop_id = ?
      `, [primary_color, secondary_color, accent_color, sidebar_color, font_family, logo_url, favicon_url, custom_domain, custom_css, workshopId]);
    } else {
      await execute(
        `INSERT INTO tenant_branding (workshop_id, primary_color, secondary_color, accent_color, sidebar_color, font_family, logo_url, favicon_url, custom_domain, custom_css)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [workshopId, primary_color || '#f97316', secondary_color || '#1e293b', accent_color || '#3b82f6', sidebar_color || '#1e293b', font_family || 'Inter', logo_url, favicon_url, custom_domain, custom_css]
      );
    }

    await logAudit(req, 'branding_updated', 'tenant_branding', parseInt(workshopId), { primary_color });
    res.json({ success: true, message: 'Branding updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update branding' });
  }
});

// Reset branding to defaults
router.delete('/branding/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM tenant_branding WHERE workshop_id = ?', [req.params.tenantId]);
    await logAudit(req, 'branding_reset', 'tenant_branding', parseInt(req.params.tenantId));
    res.json({ success: true, message: 'Branding reset to defaults' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset branding' });
  }
});

// ══════════════════════════════════════════════════════════════
//  LANDING PAGE — CONTACTS & TRIAL REQUESTS MANAGEMENT
// ══════════════════════════════════════════════════════════════

// GET /landing-contacts — list all contact form submissions
router.get('/landing-contacts', verifySuperAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND status = ?'; params.push(status); }

    const [rows] = await Promise.all([
      query(`SELECT * FROM landing_contacts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]),
    ]);
    const countResult = await query(`SELECT COUNT(*) as total FROM landing_contacts WHERE ${where}`, params);
    res.json({ contacts: rows || [], total: countResult?.[0]?.total || 0 });
  } catch (error) {
    console.error('Landing contacts error:', error.message);
    res.status(500).json({ error: 'Failed to fetch landing contacts' });
  }
});

// PUT /landing-contacts/:id — update contact status/notes
router.put('/landing-contacts/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    await execute(
      'UPDATE landing_contacts SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?',
      [status || null, notes || null, req.params.id]
    );
    await logAudit(req, 'landing_contact_updated', 'landing_contact', parseInt(req.params.id), { status });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /landing-contacts/:id
router.delete('/landing-contacts/:id', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM landing_contacts WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// GET /trial-requests — list all trial signup requests
router.get('/trial-requests', verifySuperAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND status = ?'; params.push(status); }

    const rows = await query(
      `SELECT * FROM trial_requests WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const countResult = await query(`SELECT COUNT(*) as total FROM trial_requests WHERE ${where}`, params);
    res.json({ requests: rows || [], total: countResult?.[0]?.total || 0 });
  } catch (error) {
    console.error('Trial requests error:', error.message);
    res.status(500).json({ error: 'Failed to fetch trial requests' });
  }
});

// PUT /trial-requests/:id — update status
router.put('/trial-requests/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    await execute(
      'UPDATE trial_requests SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?',
      [status || null, notes || null, req.params.id]
    );
    await logAudit(req, 'trial_request_updated', 'trial_request', parseInt(req.params.id), { status });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update trial request' });
  }
});

// DELETE /trial-requests/:id
router.delete('/trial-requests/:id', verifySuperAdmin, async (req, res) => {
  try {
    await execute('DELETE FROM trial_requests WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete trial request' });
  }
});

// GET /landing-stats — quick summary of landing page activity
router.get('/landing-stats', verifySuperAdmin, async (req, res) => {
  try {
    const [contacts, trials] = await Promise.all([
      query(`SELECT status, COUNT(*) as count FROM landing_contacts GROUP BY status`),
      query(`SELECT status, COUNT(*) as count FROM trial_requests GROUP BY status`),
    ]);
    res.json({
      contacts: (contacts || []).reduce((acc, r) => { acc[r.status] = r.count; acc.total = (acc.total || 0) + r.count; return acc; }, {}),
      trials: (trials || []).reduce((acc, r) => { acc[r.status] = r.count; acc.total = (acc.total || 0) + r.count; return acc; }, {}),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch landing stats' });
  }
});

export default router;
