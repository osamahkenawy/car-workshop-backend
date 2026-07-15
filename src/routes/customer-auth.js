/**
 * Customer Portal — Authentication Routes
 *
 * Customer self-registration, login, password reset.
 * Customers are stored in the `customers` table with a linked `users` row (role='customer').
 *
 * Endpoints:
 *   POST /api/customer-portal/auth/register      — customer self-registration
 *   POST /api/customer-portal/auth/login          — customer login → JWT
 *   POST /api/customer-portal/auth/forgot-password — password reset email
 *   POST /api/customer-portal/auth/reset-password  — set new password via token
 *   GET  /api/customer-portal/auth/session         — validate session
 *   PUT  /api/customer-portal/auth/change-password  — change password (authed)
 *   POST /api/customer-portal/auth/verify-email     — email verification
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { sendNotificationEmail } from '../lib/email.js';
import { config } from '../config.js';

const router = express.Router();

/* ──────────────────────────────────────────────────────────────
 * DB schema migration — ensure customers table has auth columns
 * Runs once on first import (idempotent).
 * ────────────────────────────────────────────────────────────── */
async function ensureCustomerAuthSchema() {
  const cols = [
    { col: 'password_hash',       def: "ALTER TABLE customers ADD COLUMN password_hash VARCHAR(255) DEFAULT NULL" },
    { col: 'is_verified',         def: "ALTER TABLE customers ADD COLUMN is_verified TINYINT(1) DEFAULT 0" },
    { col: 'verification_token',  def: "ALTER TABLE customers ADD COLUMN verification_token VARCHAR(255) DEFAULT NULL" },
    { col: 'verification_expires', def: "ALTER TABLE customers ADD COLUMN verification_expires DATETIME DEFAULT NULL" },
    { col: 'reset_token',         def: "ALTER TABLE customers ADD COLUMN reset_token VARCHAR(255) DEFAULT NULL" },
    { col: 'reset_token_expires', def: "ALTER TABLE customers ADD COLUMN reset_token_expires DATETIME DEFAULT NULL" },
    { col: 'last_login_at',       def: "ALTER TABLE customers ADD COLUMN last_login_at DATETIME DEFAULT NULL" },
  ];

  for (const { col, def } of cols) {
    try {
      await execute(def);
      console.log(`  ✅ customers.${col} added`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') continue; // already exists
      // Check for "Duplicate column name" in message
      if (err.message?.includes('Duplicate column')) continue;
      console.error(`  ⚠️  Failed to add customers.${col}:`, err.message);
    }
  }

  // Ensure index on email for login lookups
  try {
    await execute('ALTER TABLE customers ADD INDEX idx_customer_email (email)');
  } catch { /* already exists */ }
  try {
    await execute('ALTER TABLE customers ADD INDEX idx_customer_phone (phone)');
  } catch { /* already exists */ }
}

// Run migration on import
ensureCustomerAuthSchema().catch(err => console.error('Customer auth schema error:', err.message));

/* ──────────────────────────────────────────────────────────────
 * Helper: resolve workshop from slug or pick the first active one
 * ────────────────────────────────────────────────────────────── */
async function resolveWorkshop(slug) {
  if (slug) {
    const [w] = await query(
      "SELECT id, name, slug, logo_url, logo_url_white, industry, status FROM workshops WHERE slug = ? AND status != 'cancelled'",
      [slug]
    );
    return w || null;
  }
  // Fallback: first active workshop
  const [w] = await query(
    "SELECT id, name, slug, logo_url, logo_url_white, industry, status FROM workshops WHERE status != 'cancelled' ORDER BY id ASC LIMIT 1"
  );
  return w || null;
}

/* ══════════════════════════════════════════════════════════════
 * POST /register — Customer self-registration
 * ══════════════════════════════════════════════════════════════ */
router.post('/register', async (req, res) => {
  try {
    const {
      full_name, company_name, email, phone, password,
      address_line1, address_line2, city, emirate = 'Dubai',
      type = 'individual', workshop_slug
    } = req.body;

    if (!full_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, phone, and password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // Resolve workshop
    const workshop = await resolveWorkshop(workshop_slug);
    if (!workshop) {
      return res.status(400).json({ success: false, message: 'Invalid platform domain' });
    }
    if (workshop.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'This platform is currently suspended' });
    }

    // Check duplicate email/phone within workshop
    const [existing] = await query(
      'SELECT id FROM customers WHERE workshop_id = ? AND (email = ? OR phone = ?)',
      [workshop.id, email, phone]
    );
    if (existing) {
      return res.status(409).json({ success: false, message: 'A customer with this email or phone already exists' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Create customer record
    const customerResult = await execute(
      `INSERT INTO customers (
        workshop_id, full_name, company_name, email, phone,
        type, address_line1, address_line2, city, emirate,
        password_hash, is_verified, verification_token, verification_expires,
        is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)`,
      [
        workshop.id, full_name, company_name || null, email, phone,
        type, address_line1 || null, address_line2 || null, city || null, emirate,
        password_hash, verificationToken, verificationExpires,
      ]
    );

    const customerId = customerResult.insertId;

    // Also create a user record with role='customer' for JWT auth middleware compatibility
    const username = `customer_${customerId}`;
    const userResult = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, is_active, is_owner)
       VALUES (?, ?, ?, ?, ?, ?, 'customer', 1, 0)`,
      [workshop.id, full_name, username, email, phone, password_hash]
    );
    const userId = userResult.insertId;

    // Link customer to user
    await execute('UPDATE customers SET user_id = ? WHERE id = ?', [userId, customerId]);

    // Send verification email
    const verifyUrl = `${config.frontendUrl}/customer/verify-email?token=${verificationToken}`;
    sendNotificationEmail({
      to: email,
      tenantId: workshop.id,
      subject: 'Verify your customer account',
      title: 'Welcome to ' + (workshop.name || 'the workshop'),
      body: `
        <p>Hi <strong>${full_name}</strong>,</p>
        <p>Thank you for registering as a customer. Please verify your email address to activate your account.</p>
        <p>Click the button below to verify your email.</p>
      `,
      ctaText: 'Verify Email',
      ctaUrl: verifyUrl,
    }).catch(err => console.error('[CustomerAuth] Verification email error:', err.message));

    // Generate token so customer can login immediately (but limited until verified)
    const token = generateToken({ id: userId, username, role: 'customer', workshop_id: workshop.id });

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      success: true,
      data: {
        id: userId,
        customer_id: customerId,
        full_name,
        company_name: company_name || null,
        email,
        phone,
        role: 'customer',
        is_verified: false,
        workshop: {
          id: workshop.id,
          name: workshop.name,
          slug: workshop.slug,
          logo_url: workshop.logo_url,
          logo_url_white: workshop.logo_url_white,
        },
        token,
      },
    });
  } catch (err) {
    console.error('[CustomerAuth] Register error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * POST /verify-email — Verify email with token
 * ══════════════════════════════════════════════════════════════ */
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Verification token required' });

    const [customer] = await query(
      'SELECT id, user_id FROM customers WHERE verification_token = ? AND verification_expires > NOW()',
      [token]
    );
    if (!customer) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification link' });
    }

    await execute(
      'UPDATE customers SET is_verified = 1, verification_token = NULL, verification_expires = NULL WHERE id = ?',
      [customer.id]
    );

    return res.json({ success: true, message: 'Email verified successfully. You can now log in.' });
  } catch (err) {
    console.error('[CustomerAuth] Verify error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * POST /login — Customer login
 * ══════════════════════════════════════════════════════════════ */
router.post('/login', async (req, res) => {
  try {
    const { email, password, workshop_slug } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password required' });
    }

    let customer, workshop;

    if (workshop_slug) {
      // Specific workshop login
      workshop = await resolveWorkshop(workshop_slug);
      if (!workshop) {
        return res.status(400).json({ success: false, message: 'Platform not found' });
      }
      [customer] = await query(
        `SELECT c.*, u.id as user_id, u.username, u.is_active as user_active
         FROM customers c
         LEFT JOIN users u ON c.user_id = u.id
         WHERE c.workshop_id = ? AND (c.email = ? OR c.phone = ?) AND c.password_hash IS NOT NULL`,
        [workshop.id, email, email]
      );
    } else {
      // No workshop specified — search across all active workshops by email/phone
      [customer] = await query(
        `SELECT c.*, u.id as user_id, u.username, u.is_active as user_active
         FROM customers c
         LEFT JOIN users u ON c.user_id = u.id
         JOIN workshops w ON c.workshop_id = w.id AND w.status NOT IN ('cancelled','suspended')
         WHERE (c.email = ? OR c.phone = ?) AND c.password_hash IS NOT NULL
         ORDER BY c.last_login_at DESC
         LIMIT 1`,
        [email, email]
      );
      if (customer) {
        [workshop] = await query(
          "SELECT id, name, slug, logo_url, logo_url_white, industry, status FROM workshops WHERE id = ?",
          [customer.workshop_id]
        );
      }
    }

    if (!customer || !workshop) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!customer.is_active) {
      return res.status(403).json({ success: false, message: 'Account is deactivated. Contact support.' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!customer.is_verified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email first. Check your inbox.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    // Update last login
    await execute('UPDATE customers SET last_login_at = NOW() WHERE id = ?', [customer.id]);
    if (customer.user_id) {
      await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [customer.user_id]);
    }

    // Generate JWT
    const token = generateToken({
      id: customer.user_id,
      username: customer.username || `customer_${customer.id}`,
      role: 'customer',
      workshop_id: workshop.id,
    });

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      data: {
        id: customer.user_id,
        customer_id: customer.id,
        full_name: customer.full_name,
        company_name: customer.company_name,
        email: customer.email,
        phone: customer.phone,
        role: 'customer',
        is_verified: !!customer.is_verified,
        workshop: {
          id: workshop.id,
          name: workshop.name,
          slug: workshop.slug,
          logo_url: workshop.logo_url,
          logo_url_white: workshop.logo_url_white,
          industry: workshop.industry,
        },
        token,
      },
    });
  } catch (err) {
    console.error('[CustomerAuth] Login error:', err);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * POST /forgot-password — Send reset email
 * ══════════════════════════════════════════════════════════════ */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    // Always respond success to prevent enumeration
    const [customer] = await query(
      'SELECT id, full_name, email, workshop_id FROM customers WHERE email = ? AND password_hash IS NOT NULL',
      [email]
    );

    if (customer) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await execute(
        'UPDATE customers SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
        [resetToken, resetExpires, customer.id]
      );

      const resetUrl = `${config.frontendUrl}/customer/reset-password?token=${resetToken}`;

      sendNotificationEmail({
        to: customer.email,
        tenantId: customer.workshop_id,
        subject: 'Reset your customer password',
        title: 'Reset Your Password',
        body: `
          <p>Hi <strong>${customer.full_name || 'there'}</strong>,</p>
          <p>We received a request to reset your customer account password.</p>
          <p>Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
        ctaText: 'Reset Password',
        ctaUrl: resetUrl,
      }).catch(err => console.error('[CustomerAuth] Reset email error:', err.message));
    }

    return res.json({
      success: true,
      message: "If that email is registered, you'll receive a reset link shortly.",
    });
  } catch (err) {
    console.error('[CustomerAuth] Forgot password error:', err);
    return res.status(500).json({ success: false, message: 'Request failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * POST /reset-password — Set new password via token
 * ══════════════════════════════════════════════════════════════ */
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: 'Token and new password required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [customer] = await query(
      'SELECT id, user_id FROM customers WHERE reset_token = ? AND reset_token_expires > NOW()',
      [token]
    );
    if (!customer) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset link' });
    }

    const hashed = await bcrypt.hash(new_password, 12);

    // Update customer password
    await execute(
      'UPDATE customers SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
      [hashed, customer.id]
    );

    // Also update the linked user
    if (customer.user_id) {
      await execute('UPDATE users SET password = ? WHERE id = ?', [hashed, customer.user_id]);
    }

    return res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('[CustomerAuth] Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Reset failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * GET /session — Validate customer session
 * ══════════════════════════════════════════════════════════════ */
router.get('/session', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Not a customer account' });
    }

    const [customer] = await query(
      `SELECT c.*, w.name as workshop_name, w.slug as workshop_slug, w.logo_url as workshop_logo,
              w.logo_url_white as workshop_logo_white, w.industry as workshop_type, w.status as workshop_status
       FROM customers c
       LEFT JOIN workshops w ON c.workshop_id = w.id
       WHERE c.user_id = ? AND c.workshop_id = ?`,
      [req.user.id, req.workshopId]
    );

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer profile not found' });
    }

    return res.json({
      success: true,
      data: {
        id: req.user.id,
        customer_id: customer.id,
        full_name: customer.full_name,
        company_name: customer.company_name,
        email: customer.email,
        phone: customer.phone,
        role: 'customer',
        is_verified: !!customer.is_verified,
        address_line1: customer.address_line1,
        address_line2: customer.address_line2,
        city: customer.city,
        emirate: customer.emirate,
        workshop: {
          id: customer.workshop_id,
          name: customer.workshop_name,
          slug: customer.workshop_slug,
          logo_url: customer.workshop_logo,
          logo_url_white: customer.workshop_logo_white,
          industry: customer.workshop_type,
          status: customer.workshop_status,
        },
      },
    });
  } catch (err) {
    console.error('[CustomerAuth] Session error:', err);
    return res.status(500).json({ success: false, message: 'Session check failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * PUT /change-password — Change password (authenticated)
 * ══════════════════════════════════════════════════════════════ */
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ success: false, message: 'Not a customer account' });
    }

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Both passwords required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [customer] = await query(
      'SELECT id, password_hash FROM customers WHERE user_id = ? AND workshop_id = ?',
      [req.user.id, req.workshopId]
    );
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    const valid = await bcrypt.compare(current_password, customer.password_hash);
    if (!valid) return res.status(400).json({ success: false, message: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(new_password, 12);
    await execute('UPDATE customers SET password_hash = ? WHERE id = ?', [hashed, customer.id]);
    if (req.user.id) {
      await execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);
    }

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('[CustomerAuth] Change password error:', err);
    return res.status(500).json({ success: false, message: 'Password change failed' });
  }
});

/* ══════════════════════════════════════════════════════════════
 * POST /logout — Clear session cookie
 * ══════════════════════════════════════════════════════════════ */
router.post('/logout', (_req, res) => {
  res.clearCookie('auth_token');
  return res.json({ success: true, message: 'Logged out' });
});

export default router;
