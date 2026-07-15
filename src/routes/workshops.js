import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { authMiddleware, platformOwnerOnly, workshopOwnerOnly, generateToken } from '../middleware/auth.js';
import crypto from 'crypto';

const router = express.Router();

// =====================================================
// PUBLIC ROUTES - For Registration/Onboarding
// =====================================================

/**
 * Register a new workshop (Sign up)
 * Creates workshop, subscription, and admin user
 */
router.post('/register', async (req, res) => {
  try {
    const {
      company_name,
      email,
      password,
      full_name,
      phone,
      industry,
      plan = 'trial'
    } = req.body;

    if (!company_name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Company name, email, and password are required' });
    }

    // Generate slug from company name
    const slug = company_name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 50);

    // Check if slug/email already exists
    const [existing] = await query('SELECT id FROM workshops WHERE slug = ? OR email = ?', [slug, email]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Company or email already registered' });
    }

    // Create workshop
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 14); // 14-day trial

    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, subdomain, email, phone, industry, status, trial_ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name, slug, slug, email, phone || null, industry || null, 'pending_verification', trialEnds]
    );
    const workshopId = workshopResult.insertId;

    // Create subscription
    const planConfig = getPlanConfig(plan);
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, features, started_at, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
      [workshopId, 'trial', 'active', planConfig.maxUsers, JSON.stringify(planConfig.features), trialEnds]
    );

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

    const userResult = await execute(
      `INSERT INTO users (workshop_id, username, email, password, full_name, role, permissions, is_owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workshopId, username, email, hashedPassword, full_name || company_name, 'admin', JSON.stringify({ all: true }), 1]
    );

    // Create default service bays for the new workshop
    const defaultBays = [
      { name: 'Bay 1', bay_number: '1', bay_type: 'general' },
      { name: 'Bay 2', bay_number: '2', bay_type: 'general' },
      { name: 'Quick Service Lane', bay_number: 'QS1', bay_type: 'quick_service' }
    ];
    for (const bay of defaultBays) {
      await execute(
        'INSERT INTO service_bays (workshop_id, name, bay_number, bay_type, is_active) VALUES (?, ?, ?, ?, 1)',
        [workshopId, bay.name, bay.bay_number, bay.bay_type]
      );
    }

    // Generate token for auto-login
    const token = generateToken({
      id: userResult.insertId,
      workshop_id: workshopId,
      username,
      role: 'admin',
      permissions: { all: true }
    });

    // Log the registration
    await execute(
      'INSERT INTO audit_logs (workshop_id, user_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?, ?)',
      [workshopId, userResult.insertId, 'workshop_registered', 'workshop', workshopId, JSON.stringify({ company_name, email })]
    );

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        workshop: {
          id: workshopId,
          name: company_name,
          slug,
          subdomain: slug,
          trial_ends_at: trialEnds
        },
        user: {
          id: userResult.insertId,
          username,
          email,
          role: 'admin'
        },
        token
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

/**
 * Check if subdomain/slug is available
 */
router.get('/check-availability', async (req, res) => {
  try {
    const { slug, email } = req.query;
    const result = { slug_available: true, email_available: true };

    if (slug) {
      const [existing] = await query('SELECT id FROM workshops WHERE slug = ? OR subdomain = ?', [slug, slug]);
      result.slug_available = !existing;
    }

    if (email) {
      const [existing] = await query('SELECT id FROM workshops WHERE email = ?', [email]);
      result.email_available = !existing;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
});

// =====================================================
// AUTHENTICATED ROUTES - Workshop Management
// =====================================================

/**
 * Get current workshop info
 */
router.get('/current', authMiddleware, async (req, res) => {
  try {
    if (!req.workshopId) {
      return res.status(400).json({ success: false, message: 'No workshop context' });
    }

    const [workshop] = await query(
      `SELECT w.*, s.plan, s.max_users, s.current_users, s.status as subscription_status,
              s.current_period_end, s.features
       FROM workshops w
       LEFT JOIN subscriptions s ON w.id = s.workshop_id
       WHERE w.id = ?`,
      [req.workshopId]
    );

    if (!workshop) {
      return res.status(404).json({ success: false, message: 'Workshop not found' });
    }

    // Get user count
    const [userCount] = await query('SELECT COUNT(*) as count FROM users WHERE workshop_id = ? AND is_active = 1', [req.workshopId]);
    workshop.current_users = userCount?.count || 0;

    res.json({ success: true, data: workshop });
  } catch (error) {
    console.error('Get workshop error:', error);
    res.status(500).json({ success: false, message: 'Failed to get workshop info' });
  }
});

/**
 * Update current workshop
 */
router.patch('/current', authMiddleware, workshopOwnerOnly, async (req, res) => {
  try {
    const {
      name, email, phone, logo_url, logo_url_white, address, city, country,
      timezone, currency, language, settings
    } = req.body;

    await execute(
      `UPDATE workshops SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        logo_url = COALESCE(?, logo_url),
        logo_url_white = COALESCE(?, logo_url_white),
        address = COALESCE(?, address),
        city = COALESCE(?, city),
        country = COALESCE(?, country),
        timezone = COALESCE(?, timezone),
        currency = COALESCE(?, currency),
        language = COALESCE(?, language),
        settings = COALESCE(?, settings)
       WHERE id = ?`,
      [name, email, phone, logo_url, logo_url_white, address, city, country, timezone, currency, language,
       settings ? JSON.stringify(settings) : null, req.workshopId]
    );

    res.json({ success: true, message: 'Workshop updated successfully' });
  } catch (error) {
    console.error('Update workshop error:', error);
    res.status(500).json({ success: false, message: 'Failed to update workshop' });
  }
});

/**
 * Get subscription info
 */
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const [subscription] = await query(
      `SELECT s.*, w.trial_ends_at, w.status as workshop_status
       FROM subscriptions s
       JOIN workshops w ON s.workshop_id = w.id
       WHERE s.workshop_id = ?`,
      [req.workshopId]
    );

    if (!subscription) {
      return res.status(404).json({ success: false, message: 'No subscription found' });
    }

    // Parse features
    if (typeof subscription.features === 'string') {
      subscription.features = JSON.parse(subscription.features);
    }

    res.json({ success: true, data: subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get subscription' });
  }
});

/**
 * Get usage statistics
 */
router.get('/usage', authMiddleware, async (req, res) => {
  try {
    const workshopId = req.workshopId;

    const [users] = await query('SELECT COUNT(*) as count FROM users WHERE workshop_id = ? AND is_active = 1', [workshopId]);
    const [workOrders] = await query('SELECT COUNT(*) as count FROM work_orders WHERE workshop_id = ?', [workshopId]);
    const [mechanics] = await query('SELECT COUNT(*) as count FROM mechanics WHERE workshop_id = ?', [workshopId]);
    const [customers] = await query('SELECT COUNT(*) as count FROM customers WHERE workshop_id = ?', [workshopId]);
    const [subscription] = await query('SELECT max_users FROM subscriptions WHERE workshop_id = ?', [workshopId]);

    res.json({
      success: true,
      data: {
        users: { current: users?.count || 0, max: subscription?.max_users || 5 },
        work_orders: workOrders?.count || 0,
        mechanics: mechanics?.count || 0,
        customers: customers?.count || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get usage stats' });
  }
});

// =====================================================
// PLATFORM ADMIN ROUTES - Manage All Workshops
// =====================================================

/**
 * List all workshops (Platform admin only)
 */
router.get('/', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 20;
    const offset = (pg - 1) * lim;

    let sql = `
      SELECT w.*, s.plan, s.max_users, s.current_users, s.status as subscription_status,
             (SELECT COUNT(*) FROM users WHERE workshop_id = w.id) as user_count
      FROM workshops w
      LEFT JOIN subscriptions s ON w.id = s.workshop_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ' AND w.status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (w.name LIKE ? OR w.email LIKE ? OR w.slug LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY w.created_at DESC LIMIT ${lim} OFFSET ${offset}`;

    const workshops = await query(sql, params);

    // Get total count
    const [countResult] = await query('SELECT COUNT(*) as total FROM workshops');

    res.json({
      success: true,
      data: workshops,
      pagination: {
        page: pg,
        limit: lim,
        total: countResult?.total || 0
      }
    });
  } catch (error) {
    console.error('List workshops error:', error);
    res.status(500).json({ success: false, message: 'Failed to list workshops' });
  }
});

/**
 * Get single workshop (Platform admin only)
 */
router.get('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const [workshop] = await query(
      `SELECT w.*, s.plan, s.max_users, s.features, s.status as subscription_status,
              s.current_period_start, s.current_period_end
       FROM workshops w
       LEFT JOIN subscriptions s ON w.id = s.workshop_id
       WHERE w.id = ?`,
      [req.params.id]
    );

    if (!workshop) {
      return res.status(404).json({ success: false, message: 'Workshop not found' });
    }

    // Get users
    const users = await query('SELECT id, username, email, full_name, role, is_active FROM users WHERE workshop_id = ?', [workshop.id]);
    workshop.users = users;

    res.json({ success: true, data: workshop });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get workshop' });
  }
});

/**
 * Update workshop (Platform admin only)
 */
router.patch('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { status, plan, max_users } = req.body;

    if (status) {
      await execute('UPDATE workshops SET status = ? WHERE id = ?', [status, req.params.id]);
    }

    if (plan || max_users) {
      const planConfig = plan ? getPlanConfig(plan) : {};
      await execute(
        `UPDATE subscriptions SET
          plan = COALESCE(?, plan),
          max_users = COALESCE(?, max_users),
          features = COALESCE(?, features)
         WHERE workshop_id = ?`,
        [plan, max_users || planConfig.maxUsers, plan ? JSON.stringify(planConfig.features) : null, req.params.id]
      );
    }

    res.json({ success: true, message: 'Workshop updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update workshop' });
  }
});

/**
 * Suspend workshop (Platform admin only)
 */
router.post('/:id/suspend', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    await execute('UPDATE workshops SET status = "suspended" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Workshop suspended' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to suspend workshop' });
  }
});

/**
 * Activate workshop (Platform admin only)
 */
router.post('/:id/activate', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    await execute('UPDATE workshops SET status = "active" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Workshop activated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to activate workshop' });
  }
});

/**
 * Delete workshop (Platform admin only)
 */
router.delete('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const workshopId = req.params.id;

    // Delete in order due to foreign keys
    await execute('DELETE FROM subscriptions WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM users WHERE workshop_id = ?', [workshopId]);
    await execute('DELETE FROM workshops WHERE id = ?', [workshopId]);

    res.json({ success: true, message: 'Workshop deleted' });
  } catch (error) {
    console.error('Delete workshop error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete workshop' });
  }
});

// =====================================================
// LICENSE KEY ROUTES
// =====================================================

/**
 * Generate license key (Platform admin only)
 */
router.post('/licenses/generate', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { workshop_id, license_type, max_users, expires_in_days, features } = req.body;

    // Generate unique license key
    const licenseKey = `TRAS-${license_type.toUpperCase().substring(0, 3)}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expires_in_days || 365));

    const result = await execute(
      `INSERT INTO license_keys (workshop_id, license_key, license_type, max_users, features, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [workshop_id || null, licenseKey, license_type, max_users || 5, JSON.stringify(features || {}), expiresAt]
    );

    res.json({
      success: true,
      data: {
        id: result.insertId,
        license_key: licenseKey,
        license_type,
        max_users,
        expires_at: expiresAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate license' });
  }
});

/**
 * Validate license key
 */
router.post('/licenses/validate', async (req, res) => {
  try {
    const { license_key } = req.body;

    const [license] = await query(
      'SELECT * FROM license_keys WHERE license_key = ?',
      [license_key]
    );

    if (!license) {
      return res.status(404).json({ success: false, message: 'Invalid license key' });
    }

    if (!license.is_active) {
      return res.status(403).json({ success: false, message: 'License is deactivated' });
    }

    if (new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'License has expired' });
    }

    // Update validation count
    await execute(
      'UPDATE license_keys SET last_validated_at = NOW(), validation_count = validation_count + 1 WHERE id = ?',
      [license.id]
    );

    res.json({
      success: true,
      data: {
        valid: true,
        license_type: license.license_type,
        max_users: license.max_users,
        expires_at: license.expires_at,
        features: license.features
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'License validation failed' });
  }
});

/**
 * Activate license for a workshop
 */
router.post('/licenses/activate', async (req, res) => {
  try {
    const { license_key, company_name, email, password, full_name } = req.body;

    // Validate license
    const [license] = await query(
      'SELECT * FROM license_keys WHERE license_key = ? AND is_active = 1 AND workshop_id IS NULL',
      [license_key]
    );

    if (!license) {
      return res.status(404).json({ success: false, message: 'Invalid or already used license key' });
    }

    if (new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'License has expired' });
    }

    // Create workshop with this license
    const slug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 50);

    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, subdomain, email, status) VALUES (?, ?, ?, ?, ?)`,
      [company_name, slug, slug, email, 'active']
    );
    const workshopId = workshopResult.insertId;

    // Create subscription based on license
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, features, started_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [workshopId, license.license_type, 'active', license.max_users, license.features]
    );

    // Link license to workshop
    await execute(
      'UPDATE license_keys SET workshop_id = ?, activated_at = NOW() WHERE id = ?',
      [workshopId, license.id]
    );

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');

    const userResult = await execute(
      `INSERT INTO users (workshop_id, username, email, password, full_name, role, permissions, is_owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workshopId, username, email, hashedPassword, full_name || company_name, 'admin', JSON.stringify({ all: true }), 1]
    );

    // Generate token
    const token = generateToken({
      id: userResult.insertId,
      workshop_id: workshopId,
      username,
      role: 'admin',
      permissions: { all: true }
    });

    res.json({
      success: true,
      message: 'License activated successfully',
      data: {
        workshop: { id: workshopId, name: company_name, slug },
        user: { id: userResult.insertId, username, email },
        token
      }
    });
  } catch (error) {
    console.error('License activation error:', error);
    res.status(500).json({ success: false, message: 'License activation failed' });
  }
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function getPlanConfig(plan) {
  const plans = {
    trial: { maxUsers: 20, features: { core_crm: true, basic_reports: true, reports: true, workflows: true, campaigns: true, integrations: true, pipelines: 5 } },
    starter: { maxUsers: 999999, features: { core_crm: true, basic_reports: true, pipelines: 1 } },
    professional: { maxUsers: 999999, features: { core_crm: true, reports: true, workflows: true, campaigns: true, integrations: true, pipelines: 5 } },
    enterprise: { maxUsers: 999999, features: { all: true } },
    self_hosted: { maxUsers: 999999, features: { all: true } }
  };

  return plans[plan] || plans.trial;
}

/**
 * Get industry-specific pipeline configuration
 */
function getIndustryPipeline(industry) {
  const pipelines = {
    Technology: {
      name: 'Tech Sales Pipeline',
      description: 'Optimized for software and technology sales',
      stages: [
        { name: 'Lead Qualified', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Demo Scheduled', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Demo Completed', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Technical Evaluation', color: '#ec4899', probability: 55, order: 4 },
        { name: 'Proposal Sent', color: '#14b8a6', probability: 70, order: 5 },
        { name: 'Negotiation', color: '#ef4444', probability: 85, order: 6 },
        { name: 'Closed Won', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Healthcare: {
      name: 'Healthcare Sales Pipeline',
      description: 'For medical and healthcare services',
      stages: [
        { name: 'Initial Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Assessment', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Compliance Review', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Contract Review', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Closed Won', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    'Real Estate': {
      name: 'Real Estate Pipeline',
      description: 'For property sales and leasing',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Property Viewing', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Interest Confirmed', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Offer Made', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Contract Signed', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Finance: {
      name: 'Financial Services Pipeline',
      description: 'For banking and financial services',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Credit Assessment', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 55, order: 4 },
        { name: 'Documentation', color: '#ec4899', probability: 70, order: 5 },
        { name: 'Final Approval', color: '#ef4444', probability: 85, order: 6 },
        { name: 'Disbursed', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Rejected', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Retail: {
      name: 'Retail Sales Pipeline',
      description: 'For retail and wholesale businesses',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Product Interest', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Quote Sent', color: '#f59e0b', probability: 55, order: 3 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 4 },
        { name: 'Order Placed', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Manufacturing: {
      name: 'Manufacturing Pipeline',
      description: 'For B2B manufacturing sales',
      stages: [
        { name: 'RFQ Received', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Specifications', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Quotation', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Sample/Prototype', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 5 },
        { name: 'Purchase Order', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Education: {
      name: 'Education Enrollment Pipeline',
      description: 'For educational institutions',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Application', color: '#8b5cf6', probability: 30, order: 2 },
        { name: 'Assessment', color: '#f59e0b', probability: 50, order: 3 },
        { name: 'Offer Made', color: '#14b8a6', probability: 70, order: 4 },
        { name: 'Enrolled', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Not Enrolled', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Consulting: {
      name: 'Consulting Pipeline',
      description: 'For consulting and professional services',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Discovery Call', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Needs Assessment', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Presentation', color: '#ec4899', probability: 75, order: 5 },
        { name: 'Contract', color: '#ef4444', probability: 90, order: 6 },
        { name: 'Won', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Hospitality: {
      name: 'Hospitality Pipeline',
      description: 'For hotels and hospitality',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Quote Sent', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Site Visit', color: '#f59e0b', probability: 55, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 75, order: 4 },
        { name: 'Booked', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Automotive: {
      name: 'Automotive Sales Pipeline',
      description: 'For car dealerships and automotive',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Showroom Visit', color: '#8b5cf6', probability: 30, order: 2 },
        { name: 'Test Drive', color: '#f59e0b', probability: 50, order: 3 },
        { name: 'Financing', color: '#14b8a6', probability: 70, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 85, order: 5 },
        { name: 'Sold', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Construction: {
      name: 'Construction Pipeline',
      description: 'For construction and contracting',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Site Survey', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Estimation', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 5 },
        { name: 'Contract Signed', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Legal: {
      name: 'Legal Services Pipeline',
      description: 'For law firms and legal services',
      stages: [
        { name: 'Initial Consultation', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Case Evaluation', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Engagement Letter', color: '#f59e0b', probability: 60, order: 3 },
        { name: 'Retainer', color: '#14b8a6', probability: 80, order: 4 },
        { name: 'Engaged', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Not Retained', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Insurance: {
      name: 'Insurance Pipeline',
      description: 'For insurance sales',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Quote Provided', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Underwriting', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Policy Issued', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Declined', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Marketing: {
      name: 'Agency Pipeline',
      description: 'For marketing agencies',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Discovery', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Strategy Proposal', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Pitch/Presentation', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Won', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    }
  };

  // Default generic pipeline if industry not found
  const defaultPipeline = {
    name: 'Sales Pipeline',
    description: 'Standard sales pipeline',
    stages: [
      { name: 'Qualification', color: '#3b82f6', probability: 10, order: 1 },
      { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
      { name: 'Proposal', color: '#f59e0b', probability: 50, order: 3 },
      { name: 'Negotiation', color: '#ef4444', probability: 75, order: 4 },
      { name: 'Closed Won', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
      { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
    ]
  };

  return pipelines[industry] || defaultPipeline;
}

export default router;
