import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../middleware/plan-gate.js';
import { sendNotificationEmail } from '../lib/email.js';
import { config } from '../config.js';

const router = express.Router();
router.use(authMiddleware);

// GET /api/settings — get all settings for the workshop
router.get('/', async (req, res) => {
  try {
    const rows = await query('SELECT `key`, `value`, `type` FROM settings WHERE workshop_id = ?', [req.workshopId]);
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = row.type === 'json' ? JSON.parse(row.value)
          : row.type === 'boolean' ? row.value === 'true'
          : row.type === 'number' ? Number(row.value)
          : row.value;
      } catch {
        settings[row.key] = row.value;
      }
    }
    const [workshop] = await query(
      'SELECT name, slug, industry, logo_url, logo_url_white, phone, email, address, building_name, floor, office_number, area, company_lat, company_lng, city, emirate, country, currency, timezone FROM workshops WHERE id = ?',
      [req.workshopId]
    );
    return res.json({ success: true, data: { ...workshop, settings } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
});

// PUT /api/settings — bulk update settings
router.put('/', async (req, res) => {
  try {
    const { settings = {}, workshop = {} } = req.body;

    // ── Plan gate: block custom SMS sender settings for plans below Growth ──
    const smsSenderKeys = ['sms_sender_id', 'twilio_sid', 'twilio_token', 'twilio_phone'];
    const hasSmsSettings = smsSenderKeys.some(k => settings[k] !== undefined && settings[k] !== '');
    if (hasSmsSettings && req.subscription && !req.subscription.bypass) {
      const allowed = req.subscription.features?.custom_sms_sender;
      if (!allowed) {
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          feature: 'custom_sms_sender',
          current_plan: req.subscription.plan,
          required_plan: 'growth',
          message: 'Custom SMS sender requires the Growth plan or higher.',
        });
      }
    }

    // Update workshop fields
    const allowedWorkshopFields = ['name', 'logo_url', 'logo_url_white', 'phone', 'email', 'address', 'building_name', 'floor', 'office_number', 'area', 'company_lat', 'company_lng', 'city', 'emirate', 'country', 'currency', 'timezone'];
    const workshopUpdates = Object.entries(workshop).filter(([k]) => allowedWorkshopFields.includes(k));
    if (workshopUpdates.length) {
      const setClause = workshopUpdates.map(([k]) => `${k} = ?`).join(', ');
      const vals = workshopUpdates.map(([, v]) => v);
      await execute(`UPDATE workshops SET ${setClause} WHERE id = ?`, [...vals, req.workshopId]);
    }

    // Upsert settings
    for (const [key, value] of Object.entries(settings)) {
      const type = typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : typeof value === 'object' ? 'json' : 'string';
      const strValue = type === 'json' ? JSON.stringify(value) : String(value);
      await execute(
        'INSERT INTO settings (workshop_id, `key`, `value`, `type`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE `value` = ?, `type` = ?',
        [req.workshopId, key, strValue, type, strValue, type]
      );
    }
    return res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to save settings' });
  }
});

// GET /api/settings/users — manage team users
router.get('/users', async (req, res) => {
  try {
    const users = await query(
      'SELECT id, full_name, username, email, phone, role, is_active, last_login_at, created_at FROM users WHERE workshop_id = ? ORDER BY full_name',
      [req.workshopId]
    );
    return res.json({ success: true, data: users });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

// POST /api/settings/users — add team member
router.post('/users', async (req, res) => {
  try {
    const bcrypt = await import('bcryptjs');
    const { full_name, username, email, phone, role, role_id, password } = req.body;
    if (!full_name || !username || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, username, email and password required' });
    }
    // Email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    // Password strength: min 8 chars, must have uppercase, lowercase, digit
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ success: false, message: 'Password must contain uppercase, lowercase, and a number' });
    }

    // ── D.2 Max Users Restriction (plan-gate aware) ─────────────
    {
      let maxUsers = 5;
      let currentPlan = 'starter';

      if (req.subscription && !req.subscription.bypass) {
        maxUsers = req.subscription.limits?.max_users || 5;
        currentPlan = req.subscription.plan || 'starter';
      } else {
        // Fallback for when subscription middleware hasn't loaded
        const [sub] = await query('SELECT max_users, plan FROM subscriptions WHERE workshop_id = ? AND status = "active" ORDER BY id DESC LIMIT 1', [req.workshopId]);
        if (sub) {
          maxUsers = sub.max_users || 5;
          currentPlan = sub.plan || 'starter';
        }
      }

      const [countRow] = await query('SELECT COUNT(*) as cnt FROM users WHERE workshop_id = ? AND is_active = 1', [req.workshopId]);
      const currentUsers = countRow?.cnt || 0;

      if (currentUsers >= maxUsers) {
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          limit_type: 'max_users',
          current_usage: currentUsers,
          limit: maxUsers,
          current_plan: currentPlan,
          message: `User limit reached (${currentUsers}/${maxUsers}). Please upgrade your plan or contact support to add more users.`,
          support: {
            email: 'support@pioneercarservice.com',
            info_email: 'info@pioneercarservice.com',
            whatsapp: '+971503920037',
          }
        });
      }
    }

    const hashed = await bcrypt.default.hash(password, 12);
    // Resolve role_id if provided, otherwise look up by slug
    let resolvedRoleId = role_id || null;
    if (!resolvedRoleId && role) {
      const [found] = await query('SELECT id FROM roles WHERE workshop_id = ? AND slug = ?', [req.workshopId, role]);
      if (found) resolvedRoleId = found.id;
    }
    const result = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, role_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, full_name, username, email, phone || null, hashed, role || 'dispatcher', resolvedRoleId]
    );
    const [user] = await query('SELECT id, full_name, username, email, role, role_id, is_active FROM users WHERE id = ?', [result.insertId]);

    // Send welcome email with credentials (fire-and-forget)
    if (email) {
      try {
        const loginUrl = config.frontendUrl + '/login';
        const roleName = role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Team Member';
        const bodyHtml = `
          <p>Hi <strong>${full_name}</strong>,</p>
          <p>Your account has been created. Here are your login credentials:</p>
          <table cellpadding="0" cellspacing="0" style="margin:16px 0 20px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;width:100%;">
            <tr style="background:#f8fafc;">
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0;">Username</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;font-family:'Courier New',monospace;border-bottom:1px solid #e2e8f0;">${username}</td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;">Password</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;font-family:'Courier New',monospace;">${password}</td>
            </tr>
            <tr style="background:#f8fafc;">
              <td style="padding:10px 16px;font-weight:600;color:#475569;font-size:13px;border-top:1px solid #e2e8f0;">Role</td>
              <td style="padding:10px 16px;color:#111827;font-size:14px;border-top:1px solid #e2e8f0;">${roleName}</td>
            </tr>
          </table>
          <p style="color:#ef4444;font-size:13px;">&#9888; Please change your password after your first login for security.</p>
        `;
        sendNotificationEmail({
          to: email,
          subject: 'Welcome — Your Account Has Been Created',
          title: 'Welcome to the Team!',
          body: bodyHtml,
          ctaText: 'Login Now',
          ctaUrl: loginUrl,
          tenantId: req.workshopId,
        }).catch(err => console.error('Welcome email failed:', err.message));
      } catch (emailErr) {
        console.error('Welcome email setup error:', emailErr.message);
      }
    }

    return res.status(201).json({ success: true, data: user, email_sent: !!email });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

// DELETE /api/settings/users/:id
router.delete('/users/:id', async (req, res) => {
  try {
    // Prevent deleting yourself
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'You cannot deactivate your own account' });
    }
    // Prevent deleting the workshop owner
    const [target] = await query('SELECT id, is_owner, role FROM users WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (target.is_owner) {
      return res.status(403).json({ success: false, message: 'The workshop owner account cannot be deactivated' });
    }
    await execute('UPDATE users SET is_active = FALSE WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'User deactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to deactivate user' });
  }
});

// PUT /api/settings/users/:id — update user info / role / password
router.put('/users/:id', async (req, res) => {
  try {
    const [target] = await query('SELECT id, is_owner FROM users WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    const { full_name, email, phone, role, password, is_active } = req.body;

    let passwordClause = '';
    const params = [full_name, email, phone || null, role || 'dispatcher',
                    is_active !== undefined ? Boolean(is_active) : true];

    if (password && password.trim()) {
      const bcrypt = await import('bcryptjs');
      const hashed = await bcrypt.default.hash(password.trim(), 12);
      passwordClause = ', password = ?';
      params.push(hashed);
    }

    params.push(req.params.id, req.workshopId);

    await execute(
      `UPDATE users SET full_name=?, email=?, phone=?, role=?, is_active=?${passwordClause}
       WHERE id = ? AND workshop_id = ?`,
      params
    );

    const [user] = await query(
      'SELECT id, full_name, username, email, phone, role, is_active FROM users WHERE id = ?',
      [req.params.id]
    );
    return res.json({ success: true, data: user });
  } catch (err) {
    console.error('[Settings] Edit user error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

/* ── Work Order Categories ─────────────────────────────────────
   Stored in a dedicated table: work_order_categories
   Slugs are used as the category value stored on work orders.
─────────────────────────────────────────────────────────────── */
const ensureCategoriesTable = async () => {
  await execute(`
    CREATE TABLE IF NOT EXISTS work_order_categories (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT NOT NULL,
      name        VARCHAR(100) NOT NULL,
      name_ar     VARCHAR(100) DEFAULT NULL,
      slug        VARCHAR(100) NOT NULL,
      color       VARCHAR(20)  DEFAULT '#f97316',
      icon        VARCHAR(50)  DEFAULT 'wrench',
      description TEXT,
      is_active   TINYINT(1)   DEFAULT 1,
      sort_order  INT          DEFAULT 0,
      created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_workshop_slug (workshop_id, slug)
    )
  `);
  // Migrate: add slug column if table existed before this migration
  try {
    await execute(`ALTER TABLE work_order_categories ADD COLUMN slug VARCHAR(100) DEFAULT NULL AFTER name_ar`);
    await execute(`UPDATE work_order_categories SET slug = LOWER(REPLACE(REPLACE(name, ' ', '_'), '-', '_')) WHERE slug IS NULL OR slug = ''`);
    await execute(`ALTER TABLE work_order_categories ADD UNIQUE KEY uniq_workshop_slug (workshop_id, slug)`);
  } catch (_) { /* column/key already exists — ignore */ }
};

// NOTE: Categories renamed from delivery parcel-types (Parcel/Document/Food/Grocery/
// Medicine/Electronics/Fragile) to car-workshop service categories (Maintenance,
// Repair, Inspection, Bodywork, Tires, Detailing, Warranty, Other).
const DEFAULT_CATEGORIES = [
  { name:'Maintenance', name_ar:'صيانة',        slug:'maintenance', color:'#f97316' },
  { name:'Repair',      name_ar:'إصلاح',        slug:'repair',      color:'#3b82f6' },
  { name:'Inspection',  name_ar:'فحص',          slug:'inspection',  color:'#16a34a' },
  { name:'Bodywork',    name_ar:'هيكل السيارة',  slug:'bodywork',    color:'#8b5cf6' },
  { name:'Tires',       name_ar:'إطارات',        slug:'tires',       color:'#ec4899' },
  { name:'Detailing',   name_ar:'تلميع',        slug:'detailing',   color:'#0d9488' },
  { name:'Warranty',    name_ar:'ضمان',         slug:'warranty',    color:'#ef4444' },
  { name:'Other',       name_ar:'أخرى',          slug:'other',       color:'#64748b' },
];

// GET /api/settings/categories
router.get('/categories', async (req, res) => {
  try {
    await ensureCategoriesTable();
    let rows = await query(
      'SELECT * FROM work_order_categories WHERE workshop_id = ? ORDER BY sort_order, id',
      [req.workshopId]
    );
    // Auto-seed defaults on first call
    if (rows.length === 0) {
      for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
        const c = DEFAULT_CATEGORIES[i];
        await execute(
          `INSERT IGNORE INTO work_order_categories (workshop_id, name, name_ar, slug, color, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [req.workshopId, c.name, c.name_ar, c.slug, c.color, i]
        );
      }
      rows = await query(
        'SELECT * FROM work_order_categories WHERE workshop_id = ? ORDER BY sort_order, id',
        [req.workshopId]
      );
    }
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[Settings] Categories GET error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

// POST /api/settings/categories
router.post('/categories', async (req, res) => {
  try {
    await ensureCategoriesTable();
    const { name, name_ar, color, icon, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Category name is required' });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const result = await execute(
      `INSERT INTO work_order_categories (workshop_id, name, name_ar, slug, color, icon, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, name, name_ar || null, slug, color || '#f97316', icon || 'wrench', description || null]
    );
    const [cat] = await query('SELECT * FROM work_order_categories WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: cat });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A category with this name already exists' });
    }
    console.error('[Settings] Categories POST error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create category' });
  }
});

// PUT /api/settings/categories/:id
router.put('/categories/:id', async (req, res) => {
  try {
    await ensureCategoriesTable();
    const [existing] = await query(
      'SELECT id FROM work_order_categories WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Category not found' });

    const { name, name_ar, color, icon, description, is_active, sort_order } = req.body;
    await execute(
      `UPDATE work_order_categories SET
         name=?, name_ar=?, color=?, icon=?, description=?, is_active=?, sort_order=?
       WHERE id = ? AND workshop_id = ?`,
      [
        name || existing.name,
        name_ar !== undefined ? name_ar : existing.name_ar,
        color || existing.color,
        icon || existing.icon || 'wrench',
        description !== undefined ? description : existing.description,
        is_active !== undefined ? Boolean(is_active) : existing.is_active,
        sort_order !== undefined ? sort_order : existing.sort_order,
        req.params.id, req.workshopId,
      ]
    );
    const [cat] = await query('SELECT * FROM work_order_categories WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: cat });
  } catch (err) {
    console.error('[Settings] Categories PUT error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update category' });
  }
});

// DELETE /api/settings/categories/:id
router.delete('/categories/:id', async (req, res) => {
  try {
    await ensureCategoriesTable();
    const [existing] = await query(
      'SELECT id FROM work_order_categories WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Category not found' });
    await execute('DELETE FROM work_order_categories WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('[Settings] Categories DELETE error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

/* ══════════════════════════════════════════════════════════════
   Roles & Permissions CRUD
   Each role has a JSON `modules` array — the list of module slugs
   the role can access. Admin can create custom roles or edit
   the default ones (except system slug names).
══════════════════════════════════════════════════════════════ */

// All available modules in the system (for the UI checklist)
const ALL_MODULES = [
  { key: 'dashboard',          section: 'main',        label: 'Dashboard' },
  { key: 'work-orders',        section: 'operations',  label: 'Work Orders' },
  { key: 'job-assignment',     section: 'operations',  label: 'Job Assignment Board' },
  { key: 'mechanics',          section: 'operations',  label: 'Mechanics' },
  { key: 'customers',          section: 'operations',  label: 'Customers' },
  { key: 'vehicles',           section: 'operations',  label: 'Vehicles' },
  { key: 'service-status',     section: 'operations',  label: 'Service Status Tracking' },
  { key: 'bulk-import',        section: 'operations',  label: 'Bulk Import' },
  { key: 'warranty-claims',    section: 'operations',  label: 'Warranty Claims' },
  { key: 'wallet',             section: 'finance',     label: 'Wallet & Cash Payments' },
  { key: 'invoices',           section: 'finance',     label: 'Invoices' },
  { key: 'cash-payment',       section: 'finance',     label: 'Cash Reconciliation' },
  { key: 'reports',            section: 'analytics',   label: 'Reports' },
  { key: 'performance',        section: 'analytics',   label: 'Performance & SLA' },
  { key: 'service-bays',       section: 'config',      label: 'Service Bays' },
  { key: 'pricing',            section: 'config',      label: 'Pricing Rules' },
  { key: 'notifications',      section: 'system',      label: 'Notifications' },
  { key: 'settings',           section: 'system',      label: 'Settings' },
  { key: 'integrations',       section: 'system',      label: 'Integrations / API Keys' },
  // Mechanic-only modules
  { key: 'mechanic-dashboard', section: 'mechanic',    label: 'Mechanic Dashboard' },
  { key: 'my-jobs',            section: 'mechanic',    label: 'My Jobs' },
  { key: 'mechanic-scan',      section: 'mechanic',    label: 'Scan Work Order' },
  { key: 'barcode',            section: 'mechanic',    label: 'Barcode' },
];

// GET /api/settings/modules — returns available module list
router.get('/modules', async (req, res) => {
  return res.json({ success: true, data: ALL_MODULES });
});

// GET /api/settings/roles — list all roles for workshop
router.get('/roles', async (req, res) => {
  try {
    const roles = await query(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.workshop_id = r.workshop_id) as user_count
       FROM roles r WHERE r.workshop_id = ? ORDER BY r.is_system DESC, r.name ASC`,
      [req.workshopId]
    );
    // Ensure modules is an array (MySQL JSON col may already return parsed)
    for (const r of roles) {
      if (typeof r.modules === 'string') { try { r.modules = JSON.parse(r.modules); } catch { r.modules = []; } }
      if (!Array.isArray(r.modules)) r.modules = [];
    }
    return res.json({ success: true, data: roles });
  } catch (err) {
    console.error('[Settings] Roles GET error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch roles' });
  }
});

// GET /api/settings/roles/:id — single role detail
router.get('/roles/:id', async (req, res) => {
  try {
    const [role] = await query(
      'SELECT * FROM roles WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    if (typeof role.modules === 'string') { try { role.modules = JSON.parse(role.modules); } catch { role.modules = []; } }
    if (!Array.isArray(role.modules)) role.modules = [];
    return res.json({ success: true, data: role });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch role' });
  }
});

// POST /api/settings/roles — create new custom role
router.post('/roles', async (req, res) => {
  try {
    const { name, name_ar, slug, description, modules } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ success: false, message: 'Name and slug are required' });
    }
    // Validate slug format
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const result = await execute(
      'INSERT INTO roles (workshop_id, name, name_ar, slug, description, modules, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [req.workshopId, name, name_ar || null, cleanSlug, description || null, JSON.stringify(modules || [])]
    );
    const [role] = await query('SELECT * FROM roles WHERE id = ?', [result.insertId]);
    if (typeof role.modules === 'string') { try { role.modules = JSON.parse(role.modules); } catch { role.modules = []; } }
    if (!Array.isArray(role.modules)) role.modules = [];
    return res.status(201).json({ success: true, data: role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'A role with this slug already exists' });
    }
    console.error('[Settings] Roles POST error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create role' });
  }
});

// PUT /api/settings/roles/:id — update role (name, description, modules)
router.put('/roles/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT * FROM roles WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!existing) return res.status(404).json({ success: false, message: 'Role not found' });

    const { name, name_ar, description, modules, is_active } = req.body;

    await execute(
      `UPDATE roles SET name = ?, name_ar = ?, description = ?, modules = ?, is_active = ?
       WHERE id = ? AND workshop_id = ?`,
      [
        name || existing.name,
        name_ar !== undefined ? name_ar : existing.name_ar,
        description !== undefined ? description : existing.description,
        JSON.stringify(modules || []),
        is_active !== undefined ? Boolean(is_active) : existing.is_active,
        req.params.id, req.workshopId
      ]
    );

    const [role] = await query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (typeof role.modules === 'string') { try { role.modules = JSON.parse(role.modules); } catch { role.modules = []; } }
    if (!Array.isArray(role.modules)) role.modules = [];
    return res.json({ success: true, data: role });
  } catch (err) {
    console.error('[Settings] Roles PUT error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update role' });
  }
});

// DELETE /api/settings/roles/:id — delete custom role (not system roles)
router.delete('/roles/:id', async (req, res) => {
  try {
    const [role] = await query(
      'SELECT * FROM roles WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    if (role.is_system) {
      return res.status(403).json({ success: false, message: 'System roles cannot be deleted' });
    }
    // Check if any users are assigned to this role
    const [usage] = await query('SELECT COUNT(*) as cnt FROM users WHERE role_id = ?', [req.params.id]);
    if (usage.cnt > 0) {
      return res.status(409).json({ success: false, message: `Cannot delete: ${usage.cnt} user(s) are assigned to this role. Reassign them first.` });
    }
    await execute('DELETE FROM roles WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Role deleted' });
  } catch (err) {
    console.error('[Settings] Roles DELETE error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete role' });
  }
});

export default router;
