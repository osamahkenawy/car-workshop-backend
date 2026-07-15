import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { sendNotificationEmail } from '../lib/email.js';
import { config } from '../config.js';

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password, subdomain } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }

    let sql = `
      SELECT u.id, u.workshop_id, u.username, u.email, u.password, u.full_name,
             u.role, u.is_active, u.is_owner, u.avatar_url, u.email_verified,
             w.name as workshop_name, w.slug as workshop_slug, w.status as workshop_status,
             w.logo_url as workshop_logo, w.logo_url_white as workshop_logo_white,
             w.industry as workshop_type, w.currency as workshop_currency,
             w.country as workshop_country, w.company_lat, w.company_lng, m.id as mechanic_id
      FROM users u
      LEFT JOIN workshops w ON u.workshop_id = w.id
      LEFT JOIN mechanics m ON m.user_id = u.id
      WHERE (u.username = ? OR u.email = ? OR m.email = ?)
    `;
    const params = [username, username, username];

    if (subdomain) {
      sql += ' AND w.slug = ?';
      params.push(subdomain);
    }

    const users = await query(sql, params);
    if (!users.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = users[0];
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is inactive' });
    }
    // Allow suspended/trial_expired workshops to log in so they can reach Stripe to reactivate.
    // The frontend will read the warning flags and show an upgrade/reactivation wall.
    let subscription_warning = null;
    if (user.workshop_status === 'suspended') {
      subscription_warning = { suspended: true, message: 'Your account has been suspended. Please upgrade or update billing to restore access.' };
    }
    if (user.workshop_status === 'pending_verification') {
      return res.status(403).json({ success: false, message: 'Please verify your email before logging in. Check your inbox for the verification link.', code: 'EMAIL_NOT_VERIFIED' });
    }
    if (!user.email_verified && user.is_owner) {
      return res.status(403).json({ success: false, message: 'Please verify your email before logging in. Check your inbox for the verification link.', code: 'EMAIL_NOT_VERIFIED' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user);
    await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    // Load permitted modules from role
    let permitted_modules = null;
    let role_name = null;
    if (user.role) {
      const [roleRow] = await query(
        'SELECT id, name, name_ar, slug, modules FROM roles WHERE workshop_id = ? AND slug = ?',
        [user.workshop_id, user.role]
      );
      if (roleRow) {
        role_name = roleRow.name;
        permitted_modules = Array.isArray(roleRow.modules) ? roleRow.modules
          : typeof roleRow.modules === 'string' ? (()=>{ try { return JSON.parse(roleRow.modules); } catch { return []; } })()
          : [];
      }
    }

    // Mechanics always get a restricted default set if no explicit role row was found
    if (user.role === 'mechanic' && !Array.isArray(permitted_modules)) {
      permitted_modules = ['mechanic-dashboard', 'my-work-orders', 'mechanic-scan', 'barcode'];
    }

    // Apply workshop-level module restrictions from settings.allowed_modules
    const [workshopRow] = await query('SELECT settings FROM workshops WHERE id = ?', [user.workshop_id]);
    if (workshopRow) {
      let workshopSettings = workshopRow.settings || {};
      if (typeof workshopSettings === 'string') try { workshopSettings = JSON.parse(workshopSettings); } catch { workshopSettings = {}; }
      if (Array.isArray(workshopSettings.allowed_modules) && workshopSettings.allowed_modules.length > 0) {
        const workshopModules = workshopSettings.allowed_modules;
        if (Array.isArray(permitted_modules)) {
          // Intersect role modules with workshop modules
          permitted_modules = permitted_modules.filter(m => workshopModules.includes(m));
        } else {
          // Admin/owner with unrestricted role → restrict to workshop modules
          permitted_modules = workshopModules;
        }
      }
    }

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const { password: _p, ...userData } = user;
    // Build nested workshop object for frontend caching
    const workshop = {
      id: userData.workshop_id,
      name: userData.workshop_name,
      slug: userData.workshop_slug,
      logo_url: userData.workshop_logo,
      logo_url_white: userData.workshop_logo_white,
      industry: userData.workshop_type,
      status: userData.workshop_status,
      currency: userData.workshop_currency || 'AED',
      country: userData.workshop_country || 'UAE',
      company_lat: userData.company_lat || null,
      company_lng: userData.company_lng || null,
    };
    const response = { success: true, data: { ...userData, workshop, token, role_name, permitted_modules } };
    if (subscription_warning) response.subscription_warning = subscription_warning;
    return res.json(response);
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// POST /api/auth/mechanic-login  — Mobile app mechanic-only login
router.post('/mechanic-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username/email/phone and password are required' });
    }

    // Find user with mechanic role, matching by username, email, or mechanic phone/email
    const users = await query(
      `SELECT u.id, u.workshop_id, u.username, u.email, u.password, u.full_name,
              u.role, u.is_active, u.avatar_url,
              w.name as workshop_name, w.slug as workshop_slug, w.status as workshop_status,
              w.logo_url as workshop_logo, w.logo_url_white as workshop_logo_white,              w.company_lat, w.company_lng,              m.id as mechanic_id
       FROM users u
       LEFT JOIN workshops w ON u.workshop_id = w.id
       LEFT JOIN mechanics m ON m.user_id = u.id
       WHERE u.role = 'mechanic'
         AND (u.username = ? OR u.email = ? OR m.phone = ? OR m.email = ?)`,
      [username, username, username, username]
    );

    if (!users.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = users[0];
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account is inactive. Contact your administrator.' });
    }
    // Allow suspended workshop mechanics to log in with a warning (admin can reactivate via Stripe)
    let subscription_warning = null;
    if (user.workshop_status === 'suspended') {
      subscription_warning = { suspended: true, message: 'Your company account has been suspended. Contact your administrator.' };
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Generate token
    const token = generateToken(user);
    await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    // Load full mechanic profile
    const [mechanic] = await query(
      `SELECT m.*, b.name as service_bay_name,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'in_progress') as active_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id) as total_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as completed_work_orders,
              (SELECT COUNT(*) FROM work_orders o WHERE o.mechanic_id = m.id AND DATE(o.created_at) = CURDATE()) as work_orders_today,
              (SELECT COALESCE(SUM(o.service_fee),0) FROM work_orders o WHERE o.mechanic_id = m.id AND o.status = 'completed') as total_earned
       FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       WHERE m.user_id = ? AND m.workshop_id = ?`,
      [user.id, user.workshop_id]
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: 'mechanic',
        workshop_id: user.workshop_id,
        avatar_url: user.avatar_url,
        workshop: {
          id: user.workshop_id,
          name: user.workshop_name,
          slug: user.workshop_slug,
          logo_url: user.workshop_logo,
          logo_url_white: user.workshop_logo_white,
          company_lat: user.company_lat || null,
          company_lng: user.company_lng || null,
        },
      },
      mechanic: mechanic ? {
        id: mechanic.id,
        full_name: mechanic.full_name,
        phone: mechanic.phone,
        email: mechanic.email,
        photo_url: mechanic.photo_url || mechanic.avatar_url,
        status: mechanic.status,
        rating: mechanic.rating,
        service_bay_id: mechanic.service_bay_id,
        service_bay_name: mechanic.service_bay_name,
        total_jobs_completed: mechanic.total_jobs_completed,
        active_work_orders: mechanic.active_work_orders,
        total_work_orders: mechanic.total_work_orders,
        completed_work_orders: mechanic.completed_work_orders,
        work_orders_today: mechanic.work_orders_today,
        total_earned: mechanic.total_earned,
      } : null,
      ...(subscription_warning ? { subscription_warning } : {}),
    });
  } catch (err) {
    console.error('Mechanic login error:', err);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// GET /api/auth/session
router.get('/session', authMiddleware, async (req, res) => {
  try {
    const [user] = await query(
      `SELECT u.id, u.workshop_id, u.username, u.email, u.full_name, u.role, u.role_id,
              u.is_active, u.is_owner, u.avatar_url,
              w.name as workshop_name, w.slug as workshop_slug, w.industry as workshop_type,
              w.status as workshop_status, w.logo_url as workshop_logo,
              w.logo_url_white as workshop_logo_white, w.currency as workshop_currency,
              w.country as workshop_country, w.company_lat, w.company_lng, m.id as mechanic_id
       FROM users u
       LEFT JOIN workshops w ON u.workshop_id = w.id
       LEFT JOIN mechanics m ON m.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );

    // Load permitted modules from role
    let permitted_modules = null;
    let role_name = null;
    if (user.role_id) {
      const [roleRow] = await query('SELECT name, name_ar, slug, modules FROM roles WHERE id = ?', [user.role_id]);
      if (roleRow) {
        role_name = roleRow.name;
        permitted_modules = Array.isArray(roleRow.modules) ? roleRow.modules
          : typeof roleRow.modules === 'string' ? (()=>{ try { return JSON.parse(roleRow.modules); } catch { return []; } })()
          : [];
      }
    } else if (user.role) {
      // Fallback: match by slug
      const [roleRow] = await query('SELECT name, name_ar, slug, modules FROM roles WHERE workshop_id = ? AND slug = ?', [user.workshop_id, user.role]);
      if (roleRow) {
        role_name = roleRow.name;
        permitted_modules = Array.isArray(roleRow.modules) ? roleRow.modules
          : typeof roleRow.modules === 'string' ? (()=>{ try { return JSON.parse(roleRow.modules); } catch { return []; } })()
          : [];
      }
    }

    // Admin/owner gets all modules by default
    if (user.is_owner && (!permitted_modules || permitted_modules.length === 0)) {
      permitted_modules = null; // null = unrestricted
    }

    // Mechanics always get a restricted default set if no explicit role row was found
    if (user.role === 'mechanic' && !Array.isArray(permitted_modules)) {
      permitted_modules = ['mechanic-dashboard', 'my-work-orders', 'mechanic-scan', 'barcode'];
    }

    // Apply workshop-level module restrictions from settings.allowed_modules
    const workshopData = await query('SELECT settings FROM workshops WHERE id = ?', [user.workshop_id]);
    if (workshopData && workshopData[0]) {
      let workshopSettings = workshopData[0].settings || {};
      if (typeof workshopSettings === 'string') try { workshopSettings = JSON.parse(workshopSettings); } catch { workshopSettings = {}; }
      if (Array.isArray(workshopSettings.allowed_modules) && workshopSettings.allowed_modules.length > 0) {
        const workshopModules = workshopSettings.allowed_modules;
        if (Array.isArray(permitted_modules)) {
          permitted_modules = permitted_modules.filter(m => workshopModules.includes(m));
        } else {
          permitted_modules = workshopModules;
        }
      }
    }

    // Build nested workshop object for frontend caching
    const workshop = {
      id: user.workshop_id,
      name: user.workshop_name,
      slug: user.workshop_slug,
      logo_url: user.workshop_logo,
      logo_url_white: user.workshop_logo_white,
      industry: user.workshop_type,
      status: user.workshop_status,
      currency: user.workshop_currency || 'AED',
      country: user.workshop_country || 'UAE',
      company_lat: user.company_lat || null,
      company_lng: user.company_lng || null,
    };
    return res.json({ success: true, data: { ...user, workshop, role_name, permitted_modules } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Session check failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  return res.json({ success: true, message: 'Logged out' });
});

// GET /api/auth/branding?slug=xxx — public endpoint, no auth needed
// Returns workshop logos for login/public pages
router.get('/branding', async (req, res) => {
  try {
    const { slug } = req.query;
    let workshopRow;
    if (slug) {
      [workshopRow] = await query(
        'SELECT name, logo_url, logo_url_white FROM workshops WHERE slug = ? AND status != ?',
        [slug, 'cancelled']
      );
    } else {
      // No slug — return first active workshop (single-workshop / localhost fallback)
      [workshopRow] = await query(
        'SELECT name, logo_url, logo_url_white FROM workshops WHERE status != ? ORDER BY id ASC LIMIT 1',
        ['cancelled']
      );
    }
    if (!workshopRow) {
      return res.json({ success: true, data: { name: 'Trasealla Solutions', logo_url: null, logo_url_white: null } });
    }
    return res.json({ success: true, data: { name: workshopRow.name, logo_url: workshopRow.logo_url, logo_url_white: workshopRow.logo_url_white } });
  } catch (err) {
    return res.json({ success: true, data: { name: 'Trasealla Solutions', logo_url: null, logo_url_white: null } });
  }
});

// POST /api/auth/register-workshop
router.post('/register-workshop', async (req, res) => {
  try {
    const { workshop_name, workshop_type, full_name, email, username, password, phone } = req.body;
    if (!workshop_name || !email || !username || !password || !full_name) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }

    const exists = await query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (exists.length) {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }

    const slug = workshop_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const hashed = await bcrypt.hash(password, 12);

    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, email, industry, status, trial_ends_at) VALUES (?, ?, ?, ?, 'trial', DATE_ADD(NOW(), INTERVAL 14 DAY))`,
      [workshop_name, slug, email, workshop_type || 'automotive']
    );
    const workshopId = workshopResult.insertId;

    await execute('INSERT INTO wallets (workshop_id) VALUES (?)', [workshopId]);

    const userResult = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, is_owner, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', TRUE, TRUE)`,
      [workshopId, full_name, username, email, phone || null, hashed]
    );

    const [newUser] = await query(
      `SELECT u.*, w.name as workshop_name, w.slug as workshop_slug, w.industry as workshop_type
       FROM users u JOIN workshops w ON u.workshop_id = w.id WHERE u.id = ?`,
      [userResult.insertId]
    );
    const token = generateToken(newUser);

    res.cookie('auth_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    const { password: _p, ...safe } = newUser;
    return res.status(201).json({ success: true, data: { ...safe, token } });
  } catch (err) {
    console.error('Register workshop error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// POST /api/auth/forgot-password  (PUBLIC — no auth required)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    // Always respond with success to prevent email enumeration
    // Also check mechanics.email so mechanics whose users.email is an internal address
    // can still receive a password reset via their real email.
    // Also check workshops.email so workshop owner can reset using the company contact email.
    const users = await query(
      `SELECT u.id, u.full_name, u.email, u.workshop_id,
              COALESCE(m.email, u.email) AS contact_email
       FROM users u
       LEFT JOIN mechanics m ON m.user_id = u.id
       LEFT JOIN workshops w ON w.id = u.workshop_id
       WHERE (u.email = ? OR m.email = ? OR (w.email = ? AND u.is_owner = 1))
             AND u.is_active = 1
       LIMIT 1`,
      [email, email, email]
    );

    if (users.length) {
      const user = users[0];
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await execute(
        'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?',
        [token, expires, user.id]
      );

      const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;

      // Fire-and-forget (don't block response on email delivery)
      sendNotificationEmail({
        to: user.contact_email || user.email,
        workshopId: user.workshop_id,
        subject: 'Reset your password',
        title: 'Reset Your Password',
        body: `
          <p>Hi <strong>${user.full_name || 'there'}</strong>,</p>
          <p>We received a request to reset the password for your account.</p>
          <p>Click the button below to set a new password. This link will expire in <strong>1 hour</strong>.</p>
          <p>If you didn't request this, you can safely ignore this email — your password will not change.</p>
        `,
        ctaText: 'Reset Password',
        ctaUrl: resetUrl,
        copyLink: resetUrl,
        expiryNote: '1 hour',
      }).catch(err => console.error('[ForgotPassword] Email error:', err.message));
    }

    return res.json({
      success: true,
      message: "If that email is registered, you'll receive a reset link shortly.",
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ success: false, message: 'Request failed' });
  }
});

// POST /api/auth/reset-password  (PUBLIC — no auth required)
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: 'Token and new password required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const users = await query(
      'SELECT id FROM users WHERE password_reset_token = ? AND password_reset_expires > NOW() AND is_active = 1',
      [token]
    );
    if (!users.length) {
      return res.status(400).json({ success: false, message: 'This link is invalid or has expired.' });
    }

    const hashed = await bcrypt.hash(new_password, 12);
    await execute(
      'UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?',
      [hashed, users[0].id]
    );

    return res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Reset failed' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }
    const [user] = await query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) return res.status(400).json({ success: false, message: 'Current password incorrect' });
    const hashed = await bcrypt.hash(new_password, 12);
    await execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    return res.json({ success: true, message: 'Password changed' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Password change failed' });
  }
});

export default router;
