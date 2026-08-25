/**
 * ═══════════════════════════════════════════════════════════════════════
 *  MECHANIC APP — Comprehensive Mobile API
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Ported from driver-app.js (delivery driver mobile API) to the car-workshop
 *  domain: this is now the API consumed by the mechanic's mobile app.
 *
 *  Mounted at: /api/mechanic-app
 *
 *  Sections:
 *    A. Auth & Profile
 *    B. Dashboard
 *    C. Assigned Work Orders
 *    D. Vehicle Pickup Flow
 *    F. VIN/Plate Check-In Scan  (repurposed from barcode scanning)
 *    G. Proof of Service / Completion Sign-off
 *    H. Cash Payment Handling  (was: COD)
 *    I. Work Order Outcome Actions
 *    J. Progress
 *    K. Live Location Tracking (kept — used while en route to a vehicle pickup)
 *    L. Notifications & Communication
 *    M. Work Order History
 *    N. Mechanic Wallet / Earnings
 *    O. Settings & Device
 *    P. Shift & Availability
 *    Q. Support & Help
 *
 *  Flow: Login → Dashboard → Work Order Card → (optional) Pickup → Work →
 *        Complete (photo/signature) → Cash Collection (if applicable) → Done
 *  Tab Navigation: Dashboard | My Jobs | Cash | Profile
 *
 *  ── DROP / REPURPOSE DECISIONS (auditable — see rename-map.md) ──────────
 *  DROPPED — "E. DELIVERY STOPS" section (multi-stop delivery route stops:
 *    GET /orders/:id/stops, POST /stops/:id/arrived|complete|fail|skip, and
 *    the per-stop photo/signature/photos endpoints). A work order is a single
 *    vehicle in the shop, not a multi-stop delivery route, so the "stops"
 *    concept doesn't apply. Proof-photo/signature upload endpoints for
 *    *work order completion* are KEPT (see section G) — they now attach to
 *    the work order directly instead of to a stop.
 *  DROPPED — "K. Route Progress" as a distinct multi-stop route summary was
 *    folded into a simpler per-day J. Progress endpoint (no stops totals).
 *  REPURPOSED — "F. Barcode Scanning" (scan/scan-batch/verify-delivery, used
 *    to scan package barcodes during a delivery route) is repurposed as a
 *    VIN/plate check-in scan: a mechanic scans/enters a vehicle's plate or
 *    VIN at drop-off to pull up the matching work order. scan/batch (scanning
 *    many packages at once) is dropped — there's no batch-of-packages concept
 *    in a workshop; scan/verify-delivery is dropped for the same reason
 *    (no per-package delivery verification). The single-item scan endpoint
 *    is kept and repointed at VIN/plate lookup.
 *  KEPT — Vehicle pickup flow (en-route/arrived/proof-photo/signature/
 *    confirm/fail) maps directly onto a real workshop concept: a mobile
 *    mechanic or tow truck picking up a customer's vehicle for service.
 *  KEPT — Live GPS location endpoints: still useful while a mechanic is
 *    travelling to pick up a vehicle (or doing a mobile/on-site repair).
 *    Continuous route/geofence tracking against multiple delivery stops was
 *    simplified since there's only ever one destination (the pickup point)
 *    per work order, not a multi-stop route.
 * ═══════════════════════════════════════════════════════════════════════
 */
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { recordMechanicEarning, getFinancialConfig, computeMechanicEarning } from '../lib/financial.js';
import { uploadToS3 } from '../lib/s3.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding, getLogoCidAttachment } from '../lib/email.js';
import { detectZone, haversineMeters } from '../lib/zone-detect.js';
import { getIO } from '../lib/socket.js';
import { mechanicLoginLimiter, mechanicOtpLimiter, mechanicPasswordResetLimiter } from '../lib/rate-limits.js';
import jwt from 'jsonwebtoken';
import { config as authConfig } from '../config.js';
import { fileSuffix } from '../lib/tokens.js';

const router = express.Router();

/* ── Upload Setup ───────────────────────────────────────────── */
const UPLOADS_DIR = path.resolve('uploads');
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
ensureDir(path.join(UPLOADS_DIR, 'proofs'));
ensureDir(path.join(UPLOADS_DIR, 'signatures'));
ensureDir(path.join(UPLOADS_DIR, 'mechanics'));

const ALLOWED_IMAGE = /\.(jpg|jpeg|png|webp)$/i;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MB = 1024 * 1024;
function makeStorage(subfolder) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(UPLOADS_DIR, subfolder)),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${fileSuffix()}${ext}`);
    },
  });
}
function makeUpload(subfolder, maxSizeMB = 5) {
  return multer({
    storage: makeStorage(subfolder),
    limits: { fileSize: maxSizeMB * MB },
    // S6 — check both extension AND mimetype to block disguised payloads.
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE.test(file.originalname)) return cb(new Error('Only JPG, PNG, WEBP allowed'));
      if (file.mimetype && !ALLOWED_MIME.has(file.mimetype.toLowerCase())) {
        return cb(new Error('Only JPG, PNG, WEBP allowed'));
      }
      cb(null, true);
    },
  });
}
const proofUpload     = makeUpload('proofs', 10);
const signatureUpload = makeUpload('signatures', 5);
const avatarUpload    = makeUpload('mechanics', 5);

/* ── Helper: check if S3 is configured ─────────────────────── */
const isS3Configured = () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

/* ── Helper: ensure delivery_photos table exists (service completion photos) ── */
let deliveryPhotosTableReady = false;
async function ensureDeliveryPhotosTable() {
  if (deliveryPhotosTableReady) return;
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS delivery_photos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id   INT NOT NULL,
        work_order_id INT NOT NULL,
        stop_id       INT DEFAULT NULL,
        mechanic_id   INT NOT NULL,
        photo_url     VARCHAR(500) NOT NULL,
        photo_type    ENUM('proof_of_delivery','pickup_proof','damage','other') DEFAULT 'proof_of_delivery',
        caption       VARCHAR(255) DEFAULT NULL,
        lat           DECIMAL(10,7) DEFAULT NULL,
        lng           DECIMAL(10,7) DEFAULT NULL,
        uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dp_workshop_order (workshop_id, work_order_id),
        INDEX idx_dp_stop (stop_id),
        INDEX idx_dp_mechanic (mechanic_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    deliveryPhotosTableReady = true;
  } catch (e) {
    // Table might already exist — that's fine
    if (e.code === 'ER_TABLE_EXISTS_ERROR' || e.errno === 1050) {
      deliveryPhotosTableReady = true;
    } else {
      console.error('[MechanicApp] Failed to create delivery_photos table:', e.message);
    }
  }
}

/* ── Helper: save base64 signature (S3 with local fallback) ── */
async function saveBase64Signature(base64DataUrl, id) {
  if (!base64DataUrl || typeof base64DataUrl !== 'string') return null;
  // B13 — reject before decoding if the encoded string is suspiciously large
  // (raw base64 inflates ~33%, so 5MB image ≈ 6.7MB base64). Cap input length first.
  if (base64DataUrl.length > 8 * 1024 * 1024) {
    console.warn('[MechanicApp] saveBase64Signature: payload too large, rejected');
    return null;
  }
  try {
    const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 100) return null; // too small to be a valid image
    if (buf.length > 5 * 1024 * 1024) throw new Error('Signature too large (max 5MB)');
  const filename = `sig_${id}_${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;

  // Try S3 first; fall back to local disk if credentials are missing
  if (isS3Configured()) {
    try {
      const { url } = await uploadToS3(buf, 'signatures', filename, 'image/png');
      return url;
    } catch (s3Err) {
      console.warn('[MechanicApp] S3 signature upload failed, falling back to local:', s3Err.message);
    }
  }
  // Local fallback: save to uploads/signatures/
  const sigDir = path.join(UPLOADS_DIR, 'signatures');
  if (!fs.existsSync(sigDir)) fs.mkdirSync(sigDir, { recursive: true });
  const localPath = path.join(sigDir, filename);
  // B5/B13 — enforce max size on local fallback path too (defence in depth)
  if (buf.length > 5 * 1024 * 1024) {
    console.warn('[MechanicApp] signature too large for local fallback');
    return null;
  }
  fs.writeFileSync(localPath, buf);
  return `/uploads/signatures/${filename}`;
  } catch (err) {
    console.error('[MechanicApp] saveBase64Signature error:', err.message);
    return null;
  }
}

/* ── Helper: sanitize a media URL coming from the mobile client ──
   Accepts strings only. Returns null for empty / dangerous values.
   Allows: https://…, http://… (origin host), and /uploads/… relative paths.
   Rejects: javascript:, data:, file:, vbscript:, and anything else. */
function sanitizeMediaUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Hard cap — URLs longer than 2KB are almost certainly junk or an attempted DoS
  if (trimmed.length > 2048) return null;
  // Relative path under /uploads/ (our local fallback storage)
  if (trimmed.startsWith('/uploads/') && !trimmed.includes('..')) return trimmed;
  // Absolute http(s) URL
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }
  return null;
}

/* ── Helper: resolve mechanic record from JWT user ──────────── */
async function getMechanic(req) {
  const [mechanic] = await query(
    'SELECT * FROM mechanics WHERE user_id = ? AND workshop_id = ?',
    [req.user.id, req.workshopId]
  );
  return mechanic || null;
}

/* ╔═══════════════════════════════════════════════════════════════╗
   ║  A. AUTHENTICATION & PROFILE                                 ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/login
 * Mechanic-only login (username, email, or phone)
 * B2/S1 — rate-limited to 5 failed attempts / 15 min per IP+username.
 */
router.post('/login', mechanicLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username/email/phone and password are required' });
    }

    const users = await query(
      `SELECT u.id, u.workshop_id, u.username, u.email, u.password, u.full_name,
              u.role, u.is_active, u.avatar_url,
              w.name as workshop_name, w.slug as workshop_slug, w.status as workshop_status,
              w.logo_url as workshop_logo, w.logo_url_white as workshop_logo_white,
              m.id as mechanic_id
       FROM users u
       LEFT JOIN workshops w ON u.workshop_id = w.id
       LEFT JOIN mechanics m ON m.user_id = u.id
       WHERE u.role = 'mechanic'
         AND (u.username = ? OR u.email = ? OR m.phone = ? OR m.email = ?)`,
      [username, username, username, username]
    );

    if (!users.length) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const user = users[0];
    if (!user.is_active) return res.status(403).json({ success: false, message: 'Account is inactive' });
    if (user.workshop_status === 'suspended') return res.status(403).json({ success: false, message: 'Account suspended. Your workshop account has been suspended. Please contact your administrator.' });

    // Check subscription status for trial expired / payment issues
    const [workshopSub] = await query(
      'SELECT status, trial_end, plan FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
      [user.workshop_id]
    );
    if (workshopSub) {
      if (workshopSub.status === 'trial_expired') {
        return res.status(403).json({
          success: false,
          subscription_blocked: true,
          message: 'Your workshop\'s free trial has expired. Please ask your administrator to upgrade the plan.',
        });
      }
      if (workshopSub.status === 'suspended') {
        return res.status(403).json({
          success: false,
          subscription_blocked: true,
          message: 'Your workshop\'s subscription is suspended due to a billing issue. Please contact your administrator.',
        });
      }
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const token = generateToken(user);
    await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    // Load full mechanic profile
    const [mechanic] = await query(
      `SELECT m.*, b.name as service_bay_name FROM mechanics m
       LEFT JOIN service_bays b ON m.service_bay_id = b.id
       WHERE m.user_id = ? AND m.workshop_id = ?`,
      [user.id, user.workshop_id]
    );

    // B12 — only flip OFFLINE mechanics to AVAILABLE on login.
    // Mechanics who logged out as 'on_break' or 'busy' should stay in that state.
    if (mechanic && mechanic.status === 'offline') {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [mechanic.id]);
      mechanic.status = 'available';
    }

    return res.json({
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
        national_id: mechanic.national_id,
        license_number: mechanic.license_number,
      } : null,
    });
  } catch (err) {
    console.error('[MechanicApp] login error:', err);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

/**
 * POST /api/mechanic-app/forgot-password
 * Request password reset — sends OTP to mechanic's phone/email
 * B2/S1 — rate-limited to 6 OTP requests / 10 min per IP+identifier.
 */
router.post('/forgot-password', mechanicOtpLimiter, async (req, res) => {
  try {
    const { identifier } = req.body; // username, email, or phone
    if (!identifier) return res.status(400).json({ success: false, message: 'Email, phone, or username is required' });

    const users = await query(
      `SELECT u.id, u.email, u.username, u.full_name, m.phone
       FROM users u
       LEFT JOIN mechanics m ON m.user_id = u.id
       WHERE u.role = 'mechanic'
         AND (u.username = ? OR u.email = ? OR m.phone = ? OR m.email = ?)`,
      [identifier, identifier, identifier, identifier]
    );

    if (!users.length) {
      // Don't reveal if user exists — always return success
      return res.json({ success: true, message: 'If the account exists, a reset code has been sent' });
    }

    const user = users[0];
    // Generate 6-digit OTP
    // crypto.randomInt, not Math.random: Math.random is a predictable PRNG and
    // this value is a single-factor credential.
    const otp = String(crypto.randomInt(100000, 1000000));
    // B8 — OTP expiry is configurable per workshop via workshops.settings.otp_expiry_minutes (default 15)
    let otpMinutes = 15;
    try {
      const mechanicRows0 = await query('SELECT m.workshop_id FROM mechanics m WHERE m.user_id = ?', [user.id]);
      const wid = mechanicRows0[0]?.workshop_id;
      if (wid) {
        const [wrow] = await query('SELECT settings FROM workshops WHERE id = ?', [wid]);
        if (wrow?.settings) {
          const s = typeof wrow.settings === 'string' ? JSON.parse(wrow.settings) : wrow.settings;
          const m = parseInt(s?.otp_expiry_minutes, 10);
          if (m && m >= 1 && m <= 60) otpMinutes = m;
        }
      }
    } catch (_) { /* fall back to default */ }
    const expires = new Date(Date.now() + otpMinutes * 60 * 1000);

    await execute(
      'UPDATE users SET password_reset_token = ?, password_reset_expires = ? WHERE id = ?',
      [otp, expires, user.id]
    );

    // Send OTP via email
    const mechanicEmail = user.email;
    if (mechanicEmail) {
      // Get mechanic's workshop for branding
      const mechanicRows = await query(
        `SELECT m.workshop_id FROM mechanics m WHERE m.user_id = ?`,
        [user.id]
      );
      const workshopId = mechanicRows[0]?.workshop_id || null;
      const branding = await getWorkshopBranding(workshopId);
      const cidLogo = getLogoCidAttachment();

      const emailHtml = buildEmailTemplate({
        logoUrl: branding.isSystem ? cidLogo.src : branding.logoUrl,
        logoAlt: branding.name,
        accentColor: '#0d9488',
        title: 'Password Reset Code',
        bodyHtml: `
          <p style="color:#6b7280;line-height:1.75;margin-bottom:16px;">
            Hi ${user.full_name || user.username},
          </p>
          <p style="color:#6b7280;line-height:1.75;margin-bottom:16px;">
            You requested to reset your password. Use the following code in the Mechanic App:
          </p>
          <div style="background:#f0fdfa;border-radius:8px;padding:24px;text-align:center;margin:24px 0;">
            <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0d9488;">${otp}</span>
          </div>
          <p style="color:#6b7280;line-height:1.75;margin-bottom:16px;">
            This code will expire in <strong>${otpMinutes} minutes</strong>.
          </p>
          <p style="color:#9ca3af;font-size:14px;margin-top:24px;">
            If you didn't request this, please ignore this email.
          </p>
        `,
        footerName: branding.name,
        isSystem: branding.isSystem,
      });

      sendEmail({
        to: mechanicEmail,
        subject: `Your Password Reset Code: ${otp}`,
        html: emailHtml,
        tenantId: workshopId,
        attachments: branding.isSystem ? [cidLogo.attachment] : [],
      }).then(result => {
        if (result.success) {
          console.log(`[MechanicApp] Password reset OTP email sent to ${mechanicEmail}`);
        } else {
          console.error(`[MechanicApp] Failed to send OTP email to ${mechanicEmail}:`, result.error);
        }
      }).catch(err => {
        console.error(`[MechanicApp] Error sending OTP email:`, err.message);
      });
    } else {
      console.log(`[MechanicApp] No email for mechanic ${user.username}, cannot send OTP`);
    }

    // Also log in dev mode
    if (process.env.LOG_OTP_SECRET === 'true') {
      console.log(`[MechanicApp] Password reset OTP for ${user.username}: ${otp}`);
    }

    return res.json({
      success: true,
      message: 'If the account exists, a reset code has been sent',
      // B14 — only echo OTP when explicitly enabled. Hides OTPs from logs/responses
      // even if NODE_ENV is misconfigured in a staging/prod environment.
      _dev_otp: process.env.LOG_OTP_SECRET === 'true' ? otp : undefined,
    });
  } catch (err) {
    console.error('[MechanicApp] forgot-password error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process request' });
  }
});

/**
 * POST /api/mechanic-app/reset-password
 * Reset password using OTP
 * B2/S1 — rate-limited to 10 attempts / 15 min per IP+identifier.
 */
router.post('/reset-password', mechanicPasswordResetLimiter, async (req, res) => {
  try {
    const { identifier, otp, new_password } = req.body;
    if (!identifier || !otp || !new_password) {
      return res.status(400).json({ success: false, message: 'identifier, otp, and new_password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const users = await query(
      `SELECT u.id, u.password_reset_token, u.password_reset_expires
       FROM users u
       LEFT JOIN mechanics m ON m.user_id = u.id
       WHERE u.role = 'mechanic'
         AND (u.username = ? OR u.email = ? OR m.phone = ? OR m.email = ?)`,
      [identifier, identifier, identifier, identifier]
    );

    if (!users.length) return res.status(400).json({ success: false, message: 'Invalid request' });

    const user = users[0];
    if (!user.password_reset_token || user.password_reset_token !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code' });
    }
    if (new Date(user.password_reset_expires) < new Date()) {
      return res.status(400).json({ success: false, message: 'Reset code has expired' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await execute(
      'UPDATE users SET password = ?, password_reset_token = NULL, password_reset_expires = NULL WHERE id = ?',
      [hash, user.id]
    );

    return res.json({ success: true, message: 'Password reset successfully. Please login with your new password.' });
  } catch (err) {
    console.error('[MechanicApp] reset-password error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
});

// ── All routes below require authentication ──────────────────
router.use(authMiddleware);

// ── Subscription enforcement for mechanic app (Scenario 9) ───
router.use(async (req, res, next) => {
  try {
    const workshopId = req.workshopId;
    if (!workshopId) return next(); // no workshop context

    const [sub] = await query(
      'SELECT status, plan FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
      [workshopId]
    );

    if (sub && (sub.status === 'trial_expired' || sub.status === 'suspended')) {
      return res.status(403).json({
        success: false,
        subscription_blocked: true,
        message: sub.status === 'trial_expired'
          ? 'Your workshop\'s free trial has expired. The mechanic app is temporarily unavailable. Please ask your administrator to upgrade.'
          : 'Your workshop\'s subscription is suspended. The mechanic app is temporarily unavailable. Please contact your administrator.',
      });
    }
    next();
  } catch (err) {
    console.error('[MechanicApp] Subscription check error:', err.message);
    next(); // don't block on errors
  }
});

/**
 * GET /api/mechanic-app/profile
 * Get mechanic profile with stats
 */
router.get('/profile', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [stats] = await query(
      `SELECT
         COUNT(*) as total_orders,
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) as returned,
         SUM(CASE WHEN status IN ('assigned','accepted','picked_up','in_transit') THEN 1 ELSE 0 END) as active,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN service_fee ELSE 0 END), 0) as total_earned,
         COALESCE(SUM(CASE WHEN status = 'delivered' AND DATE(delivered_at) = CURDATE() THEN service_fee ELSE 0 END), 0) as earned_today
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );

    const [serviceBay] = mechanic.service_bay_id
      ? await query('SELECT id, name, city FROM service_bays WHERE id = ?', [mechanic.service_bay_id])
      : [null];

    return res.json({
      success: true,
      data: {
        id: mechanic.id,
        user_id: mechanic.user_id,
        full_name: mechanic.full_name,
        phone: mechanic.phone,
        email: mechanic.email,
        photo_url: mechanic.photo_url || mechanic.avatar_url,
        national_id: mechanic.national_id,
        license_number: mechanic.license_number,
        status: mechanic.status,
        is_active: mechanic.is_active,
        rating: mechanic.rating,
        service_bay: serviceBay || null,
        stats,
        joined_at: mechanic.joined_at,
        created_at: mechanic.created_at,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] profile error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
});

/**
 * PUT /api/mechanic-app/profile
 * Update mechanic profile
 * NOTE: the original driver profile update also accepted vehicle_type/plate/
 * model/color (the driver's OWN delivery vehicle). Those columns don't make
 * sense for a mechanic (a mechanic doesn't have a "delivery vehicle") and are
 * dropped here per the rename-map judgment call — see rename-map.md.
 */
router.put('/profile', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { full_name, phone, email } = req.body;

    const updates = [];
    const params = [];
    if (full_name)     { updates.push('full_name = ?');     params.push(full_name); }
    if (phone)         { updates.push('phone = ?');         params.push(phone); }
    if (email)         { updates.push('email = ?');         params.push(email); }

    if (updates.length) {
      params.push(mechanic.id, req.workshopId);
      await execute(`UPDATE mechanics SET ${updates.join(', ')} WHERE id = ? AND workshop_id = ?`, params);
    }

    return res.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    console.error('[MechanicApp] update profile error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

/**
 * POST /api/mechanic-app/profile/avatar
 * Upload/update mechanic avatar photo
 */
router.post('/profile/avatar', avatarUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const url = `/uploads/mechanics/${req.file.filename}`;
    // Update both columns if photo_url exists, fall back to avatar_url only
    try {
      await execute('UPDATE mechanics SET photo_url = ?, avatar_url = ? WHERE id = ? AND workshop_id = ?',
        [url, url, mechanic.id, req.workshopId]);
    } catch (_colErr) {
      await execute('UPDATE mechanics SET avatar_url = ? WHERE id = ? AND workshop_id = ?',
        [url, mechanic.id, req.workshopId]);
    }

    return res.json({ success: true, url, message: 'Avatar updated' });
  } catch (err) {
    console.error('[MechanicApp] avatar upload error:', err);
    return res.status(500).json({ success: false, message: 'Avatar upload failed' });
  }
});

/**
 * POST /api/mechanic-app/change-password
 */
router.post('/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'current_password and new_password required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [user] = await query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    const hashed = await bcrypt.hash(new_password, 12);
    await execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('[MechanicApp] change-password error:', err);
    return res.status(500).json({ success: false, message: 'Failed to change password' });
  }
});

/**
 * GET /api/mechanic-app/ratings
 * Full ratings data for the mechanic's Ratings screen
 */
router.get('/ratings', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    // Star distribution (GROUP BY)
    const distRows = await query(
      `SELECT mechanic_rating AS stars, COUNT(*) AS count
       FROM work_orders
       WHERE mechanic_id = ? AND workshop_id = ? AND mechanic_rating IS NOT NULL
       GROUP BY mechanic_rating`,
      [mechanic.id, req.workshopId]
    );
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    let totalRatings = 0;
    for (const row of distRows) {
      distribution[row.stars] = row.count;
      totalRatings += row.count;
    }

    // Performance stats (completed count + on-time rate)
    const [perf] = await query(
      `SELECT
         COUNT(*) AS total_orders,
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'delivered' AND TIMESTAMPDIFF(HOUR, created_at, delivered_at) <= 8 THEN 1 ELSE 0 END) AS on_time
       FROM work_orders
       WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );
    const completed = parseInt(perf?.completed) || 0;
    const onTime = parseInt(perf?.on_time) || 0;
    const onTimeRate = completed > 0 ? Math.round((onTime / completed) * 100 * 10) / 10 : 0;

    // Positive rating percentage (4-5 stars out of total ratings)
    const positiveCount = (distribution[5] || 0) + (distribution[4] || 0);
    const positiveRate = totalRatings > 0 ? Math.round((positiveCount / totalRatings) * 100 * 10) / 10 : 0;

    // Recent reviews (latest 50 rated work orders)
    const reviews = await query(
      `SELECT o.id, o.work_order_number, o.mechanic_rating AS rating, o.review_comment AS comment,
              o.customer_name AS customer_name, o.mechanic_rated_at AS created_at
       FROM work_orders o
       WHERE o.mechanic_id = ? AND o.workshop_id = ? AND o.mechanic_rating IS NOT NULL
       ORDER BY o.mechanic_rated_at DESC
       LIMIT 50`,
      [mechanic.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        rating: parseFloat(mechanic.rating) || 0,
        total_ratings: totalRatings,
        distribution,
        stats: {
          total_orders: parseInt(perf?.total_orders) || 0,
          completed,
          on_time_rate: onTimeRate,
          positive_rate: positiveRate,
        },
        reviews,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] ratings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load ratings' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  B. DASHBOARD                                                ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/dashboard
 * Full dashboard data for the mechanic's home screen
 */
router.get('/dashboard', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    // Today's stats
    const [today] = await query(
      `SELECT
         COUNT(CASE WHEN status IN ('assigned','accepted','picked_up','in_transit') THEN 1 END) as active_orders,
         COUNT(CASE WHEN status = 'delivered' AND DATE(delivered_at) = CURDATE() THEN 1 END) as completed_today,
         COUNT(CASE WHEN status = 'failed' AND DATE(failed_at) = CURDATE() THEN 1 END) as failed_today,
         COUNT(CASE WHEN status = 'returned' AND DATE(returned_at) = CURDATE() THEN 1 END) as returned_today,
         COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status NOT IN ('cancelled') THEN 1 END) as assigned_today,
         COALESCE(SUM(CASE WHEN status = 'delivered' AND DATE(delivered_at) = CURDATE() THEN service_fee ELSE 0 END), 0) as earned_today,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status = 'delivered' AND DATE(delivered_at) = CURDATE() THEN cash_amount ELSE 0 END), 0) as cash_collected_today,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status IN ('assigned','accepted','picked_up','in_transit') THEN cash_amount ELSE 0 END), 0) as cash_pending
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?`,
      [mechanic.id, req.workshopId]
    );

    // Use mechanic_earnings for accurate earned_today if available
    try {
      const [earnRow] = await query(
        `SELECT COALESCE(SUM(net_amount), 0) as total FROM mechanic_earnings WHERE mechanic_id = ? AND workshop_id = ? AND DATE(created_at) = CURDATE()`,
        [mechanic.id, req.workshopId]
      );
      if (parseFloat(earnRow?.total) > 0) {
        today.earned_today = parseFloat(earnRow.total);
      } else if (parseFloat(today.completed_today) > 0) {
        // No mechanic_earnings yet — compute from settings on-the-fly
        try {
          const { getFinancialConfig, computeMechanicEarning } = await import('../lib/financial.js');
          const config = await getFinancialConfig(req.workshopId);
          const rate = parseFloat(config.mechanicEarningRate) || 0;
          if (rate > 0) {
            const todaysOrders = await query(
              `SELECT service_fee, cash_amount, payment_method FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND status = 'delivered' AND DATE(delivered_at) = CURDATE()`,
              [mechanic.id, req.workshopId]
            );
            let totalEarned = 0;
            for (const o of todaysOrders) {
              const cashAmt = o.payment_method === 'cash' ? (parseFloat(o.cash_amount) || 0) : 0;
              const { netEarning } = computeMechanicEarning({ serviceFee: parseFloat(o.service_fee) || 0, cashAmount: cashAmt, config });
              totalEarned += netEarning;
            }
            if (totalEarned > 0) today.earned_today = Math.round(totalEarned * 100) / 100;
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Pending vehicle pickup count
    const [pickups] = await query(
      `SELECT COUNT(*) as pending_pickups
       FROM work_orders WHERE workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)
         AND pickup_status IN ('none','pending_pickup','pickup_scheduled','en_route_to_pickup')
         AND status NOT IN ('cancelled','delivered','returned')`,
      [req.workshopId, mechanic.id, mechanic.id]
    );

    // Next active work order (for "Continue job" button) — replaces the
    // original "next pending delivery stop" concept, which doesn't apply here.
    const nextOrders = await query(
      `SELECT o.id, o.work_order_number, o.customer_name, o.customer_phone, o.tracking_token, o.status
       FROM work_orders o
       WHERE o.mechanic_id = ? AND o.workshop_id = ?
         AND o.status IN ('picked_up','in_transit')
       ORDER BY o.created_at ASC
       LIMIT 3`,
      [mechanic.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        mechanic: {
          id: mechanic.id,
          full_name: mechanic.full_name,
          status: mechanic.status,
          rating: mechanic.rating,
          photo_url: mechanic.photo_url || mechanic.avatar_url,
        },
        today: {
          ...today,
          pending_pickups: pickups.pending_pickups,
        },
        next_orders: nextOrders,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] dashboard error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load dashboard' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  C. ASSIGNED WORK ORDERS                                     ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/orders/:id/accept
 * Accept an assigned work order
 */
router.post('/orders/:id/accept', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT * FROM work_orders WHERE id = ? AND mechanic_id = ? AND workshop_id = ?',
      [req.params.id, mechanic.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found or not assigned to you' });
    if (order.status !== 'assigned') {
      return res.status(400).json({ success: false, message: `Cannot accept work order in '${order.status}' status` });
    }

    await execute(
      `UPDATE work_orders SET status = 'accepted', accepted_at = NOW() WHERE id = ?`,
      [order.id]
    );

    // Mark mechanic as busy now that they explicitly accepted
    await execute(
      "UPDATE mechanics SET status = 'busy' WHERE id = ? AND status = 'available'",
      [mechanic.id]
    );

    // Log status
    await execute(
      `INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note)
       VALUES (?, 'accepted', ?, 'Mechanic accepted work order')`,
      [order.id, req.user.id]
    );

    return res.json({ success: true, message: 'Work order accepted', work_order_id: order.id });
  } catch (err) {
    console.error('[MechanicApp] accept order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to accept work order' });
  }
});

/**
 * POST /api/mechanic-app/orders/:id/reject
 * Reject an assigned work order — returns it to the job-assignment pool
 */
router.post('/orders/:id/reject', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });

    const [order] = await query(
      'SELECT * FROM work_orders WHERE id = ? AND mechanic_id = ? AND workshop_id = ?',
      [req.params.id, mechanic.id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found or not assigned to you' });
    if (!['assigned', 'accepted'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot reject work order in '${order.status}' status` });
    }

    // Un-assign mechanic, set back to pending
    await execute(
      `UPDATE work_orders SET mechanic_id = NULL, status = 'pending' WHERE id = ?`,
      [order.id]
    );

    // Release mechanic back to available if they have no other active work orders
    const [activeCount] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','picked_up','in_transit')",
      [mechanic.id]
    );
    if (!activeCount?.cnt || activeCount.cnt === 0) {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ? AND status = 'busy'", [mechanic.id]);
    }

    // Log rejection
    await execute(
      `INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note)
       VALUES (?, 'pending', ?, ?)`,
      [order.id, req.user.id, `Mechanic rejected: ${reason}`]
    );

    return res.json({ success: true, message: 'Work order rejected and returned to the job pool', work_order_id: order.id });
  } catch (err) {
    console.error('[MechanicApp] reject order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reject work order' });
  }
});

/**
 * GET /api/mechanic-app/orders
 * All work orders assigned to this mechanic (filterable by status)
 */
router.get('/orders', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { status, date, page = 1, limit = 50, search, sort, payment_method, has_cash, priority, order_type } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'o.mechanic_id = ? AND o.workshop_id = ?';
    const params = [mechanic.id, req.workshopId];

    if (status) {
      if (status === 'active') {
        where += " AND o.status IN ('assigned','accepted','picked_up','in_transit')";
      } else if (status === 'completed') {
        where += " AND o.status IN ('delivered','returned')";
      } else {
        where += ' AND o.status = ?';
        params.push(status);
      }
    }
    if (date) {
      where += ' AND DATE(o.created_at) = ?';
      params.push(date);
    }

    // Search by work order number, customer name, phone, address, area
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      where += ` AND (o.work_order_number LIKE ? OR o.tracking_token LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_address LIKE ? OR o.customer_area LIKE ? OR o.sender_name LIKE ?)`;
      params.push(term, term, term, term, term, term, term);
    }

    // Filter by payment method
    if (payment_method) {
      where += ' AND o.payment_method = ?';
      params.push(payment_method);
    }

    // Filter cash-payment work orders only
    if (has_cash === 'true') {
      where += ' AND o.cash_amount > 0';
    }

    // Filter by priority
    if (priority) {
      where += ' AND o.priority = ?';
      params.push(priority);
    }

    // Filter by order type
    if (order_type) {
      where += ' AND o.order_type = ?';
      params.push(order_type);
    }

    // Determine sort order
    let orderBy;
    switch (sort) {
      case 'oldest':
        orderBy = 'o.created_at ASC';
        break;
      case 'newest':
        orderBy = 'o.created_at DESC';
        break;
      case 'cash_amount':
        orderBy = 'o.cash_amount DESC, o.created_at DESC';
        break;
      case 'distance':
        orderBy = 'o.calculated_distance_km ASC, o.created_at DESC';
        break;
      case 'service_fee':
        orderBy = 'o.service_fee DESC, o.created_at DESC';
        break;
      default:
        // Default: status priority then newest
        orderBy = `CASE o.status
           WHEN 'in_transit' THEN 1
           WHEN 'picked_up' THEN 2
           WHEN 'accepted' THEN 3
           WHEN 'assigned' THEN 4
           ELSE 5
         END, o.created_at DESC`;
        break;
    }

    const orders = await query(
      `SELECT o.id, o.work_order_number, o.tracking_token, o.status,
              o.sender_name, o.sender_phone, o.sender_address, o.sender_lat, o.sender_lng,
              o.customer_name, o.customer_phone, o.customer_address,
              o.customer_area, o.customer_emirate, o.customer_lat, o.customer_lng,
              o.pickup_status, o.pickup_scheduled_at, o.pickup_confirmed_at,
              o.order_type, o.category, o.payment_method, o.cash_amount, o.service_fee,
              o.weight_kg, o.description, o.special_instructions,
              o.vehicle_id,
              o.signature_url, o.proof_of_delivery_url,
              o.calculated_distance_km, o.priority, o.estimated_delivery_at,
              o.created_at, o.picked_up_at, o.delivered_at, o.failed_at,
              DATE_ADD(COALESCE(oa.assigned_at, osl.created_at, o.created_at), INTERVAL 4 HOUR) AS assigned_at,
              c.full_name AS customer_full_name, c.phone AS customer_full_phone,
              b.name AS service_bay_name
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN service_bays b ON o.service_bay_id = b.id
       LEFT JOIN work_order_assignments oa ON oa.work_order_id = o.id AND oa.mechanic_id = o.mechanic_id AND oa.is_current = TRUE
       LEFT JOIN (
         SELECT work_order_id, MIN(created_at) AS created_at
         FROM work_order_status_logs
         WHERE status = 'assigned'
         GROUP BY work_order_id
       ) osl ON osl.work_order_id = o.id
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM work_orders o WHERE ${where}`, params
    );

    return res.json({ success: true, data: orders, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (err) {
    console.error('[MechanicApp] orders error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load work orders' });
  }
});

/**
 * GET /api/mechanic-app/orders/:id
 * Full work order detail with parts used, status logs, and vehicle info
 */
router.get('/orders/:id', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      `SELECT o.*, c.full_name AS customer_full_name, c.phone AS customer_full_phone,
              b.name AS service_bay_name,
              DATE_ADD(COALESCE(oa.assigned_at, osl.assigned_log_time, o.created_at), INTERVAL 4 HOUR) AS assigned_at
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN service_bays b ON o.service_bay_id = b.id
       LEFT JOIN work_order_assignments oa ON oa.work_order_id = o.id AND oa.mechanic_id = o.mechanic_id AND oa.is_current = TRUE
       LEFT JOIN (
         SELECT work_order_id, MIN(created_at) AS assigned_log_time
         FROM work_order_status_logs
         WHERE status = 'assigned'
         GROUP BY work_order_id
       ) osl ON osl.work_order_id = o.id
       WHERE o.id = ? AND o.workshop_id = ? AND (o.mechanic_id = ? OR o.pickup_mechanic_id = ?)`,
      [req.params.id, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Parts used on this work order (was: packages within an order)
    let parts = [];
    try {
      parts = await query(
        'SELECT id, part_number, name, quantity_used, unit_cost, status, description FROM parts WHERE work_order_id = ? AND workshop_id = ?',
        [order.id, req.workshopId]
      );
    } catch (_) {}

    // Vehicle
    let vehicle = null;
    if (order.vehicle_id) {
      try {
        const [v] = await query('SELECT * FROM vehicles WHERE id = ?', [order.vehicle_id]);
        vehicle = v || null;
      } catch (_) {}
    }

    // Status logs
    const statusLogs = await query(
      `SELECT sl.*, u.full_name AS changed_by_name
       FROM work_order_status_logs sl
       LEFT JOIN users u ON sl.changed_by = u.id
       WHERE sl.work_order_id = ? ORDER BY sl.created_at ASC`,
      [order.id]
    );

    return res.json({
      success: true,
      data: {
        ...order,
        parts,
        vehicle,
        status_logs: statusLogs,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] order detail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load work order' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  D. VEHICLE PICKUP FLOW                                      ║
   ║  (customer's vehicle pickup/tow-in — mobile mechanic or tow) ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/pickups
 * List my pending vehicle pickups
 */
router.get('/pickups', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const rows = await query(
      `SELECT o.id, o.work_order_number, o.tracking_token, o.status,
              o.sender_name, o.sender_phone, o.sender_address, o.sender_lat, o.sender_lng,
              o.customer_name, o.customer_address, o.customer_area, o.customer_emirate,
              o.pickup_status, o.pickup_scheduled_at, o.pickup_scheduled_end,
              o.pickup_notes, o.pickup_confirmed_at,
              o.order_type, o.category, o.payment_method, o.cash_amount,
              o.weight_kg, o.description, o.special_instructions,
              o.vehicle_id,
              c.full_name AS customer_full_name, c.phone AS customer_full_phone,
              b.name AS service_bay_name
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN service_bays b ON o.service_bay_id = b.id
       WHERE o.workshop_id = ?
         AND (o.pickup_mechanic_id = ? OR o.mechanic_id = ?)
         AND o.pickup_status IN ('none', 'pending_pickup', 'pickup_scheduled', 'en_route_to_pickup', 'mechanic_arrived')
         AND o.status NOT IN ('cancelled', 'delivered', 'returned')
       ORDER BY o.pickup_scheduled_at ASC, o.created_at ASC`,
      [req.workshopId, mechanic.id, mechanic.id]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[MechanicApp] pickups error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load pickups' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/en-route
 * Mechanic is heading to the vehicle pickup location
 */
router.post('/pickups/:workOrderId/en-route', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { lat, lng } = req.body;
    const [order] = await query(
      'SELECT id, pickup_status, status FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found or not assigned to you' });

    await execute(
      "UPDATE work_orders SET pickup_status = 'en_route_to_pickup' WHERE id = ? AND workshop_id = ?",
      [order.id, req.workshopId]
    );

    // Log pickup sub-step (don't duplicate the main work order status)
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'accepted', req.user.id, 'Mechanic en route to vehicle pickup', lat || null, lng || null]
    );

    return res.json({ success: true, message: 'En route to vehicle pickup' });
  } catch (err) {
    console.error('[MechanicApp] en-route error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/arrived
 * Mechanic arrived at the vehicle pickup location
 */
router.post('/pickups/:workOrderId/arrived', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { lat, lng } = req.body;
    const [order] = await query(
      'SELECT id, pickup_status, status FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Update pickup_request
    const [existingReq] = await query(
      `SELECT id FROM pickup_requests WHERE work_order_id = ? AND workshop_id = ? AND status NOT IN ('picked_up','failed','cancelled') ORDER BY id DESC LIMIT 1`,
      [order.id, req.workshopId]
    );
    if (existingReq) {
      await execute(
        "UPDATE pickup_requests SET status = 'arrived', arrived_at = NOW(), lat = ?, lng = ? WHERE id = ?",
        [lat || null, lng || null, existingReq.id]
      );
    }

    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'accepted', req.user.id, 'Mechanic arrived at vehicle pickup location', lat || null, lng || null]
    );

    return res.json({ success: true, message: 'Arrived at vehicle pickup location' });
  } catch (err) {
    console.error('[MechanicApp] pickup arrived error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/proof-photo
 * Upload vehicle pickup proof photo — saves to pickup_proof_url (NOT proof_of_delivery_url)
 */
router.post('/pickups/:workOrderId/proof-photo', proofUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    await ensureDeliveryPhotosTable();

    const url = `/uploads/proofs/${req.file.filename}`;
    const { caption, lat, lng } = req.body;

    // Insert into delivery_photos as pickup_proof type
    await execute(
      `INSERT INTO delivery_photos (workshop_id, work_order_id, stop_id, mechanic_id, photo_url, photo_type, caption, lat, lng)
       VALUES (?, ?, NULL, ?, ?, 'pickup_proof', ?, ?, ?)`,
      [req.workshopId, order.id, mechanic.id, url, caption || null, lat || null, lng || null]
    );

    // Update pickup_proof_url (NOT proof_of_delivery_url)
    await execute('UPDATE work_orders SET pickup_proof_url = ? WHERE id = ?', [url, order.id]);

    return res.json({ success: true, url, message: 'Vehicle pickup proof photo uploaded' });
  } catch (err) {
    console.error('[MechanicApp] pickup proof-photo upload error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Photo upload failed' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/signature
 * Upload vehicle pickup / customer signature — saves to pickup_signature_url (NOT signature_url)
 */
router.post('/pickups/:workOrderId/signature', signatureUpload.single('file'), async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    let url;
    if (!req.file && req.body?.signature) {
      url = await saveBase64Signature(req.body.signature, `pickup_${order.id}`);
    } else if (req.file) {
      url = `/uploads/signatures/${req.file.filename}`;
    } else {
      return res.status(400).json({ success: false, message: 'No file or signature data provided' });
    }

    // Update pickup_signature_url (NOT signature_url which is for the completion sign-off)
    await execute('UPDATE work_orders SET pickup_signature_url = ? WHERE id = ?', [url, order.id]);

    return res.json({ success: true, url, message: 'Vehicle pickup signature uploaded' });
  } catch (err) {
    console.error('[MechanicApp] pickup signature upload error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Signature upload failed' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/confirm
 * Confirm vehicle pickup — vehicle collected from customer
 * Body: { notes, lat, lng, signature, signature_url, proof_photo_url }
 * NOTE: original also accepted barcode_scanned/scanned_packages (parcel
 * barcodes at pickup) — dropped, since a work order isn't a set of scannable
 * packages. VIN/plate check-in is handled separately (see section F).
 */
router.post('/pickups/:workOrderId/confirm', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { notes, lat, lng, signature, signature_url, proof_photo_url } = req.body;
    const [order] = await query(
      'SELECT id, pickup_status, status, tracking_token FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (order.pickup_status === 'picked_up') {
      return res.status(400).json({ success: false, message: 'Vehicle already picked up' });
    }

    const now = new Date();

    // Handle signature (pre-uploaded URL or raw base64)
    const resolvedSignatureUrl = sanitizeMediaUrl(signature_url) || (signature ? await saveBase64Signature(signature, order.id) : null);
    const safeProofUrl = sanitizeMediaUrl(proof_photo_url);

    // Mark work order as picked up (pickup signature goes to pickup_signature_url, NOT
    // signature_url which is the completion/customer sign-off signature)
    await execute(
      `UPDATE work_orders SET
         pickup_status = 'picked_up', pickup_confirmed_at = ?,
         pickup_notes = COALESCE(?, pickup_notes),
         pickup_signature_url = COALESCE(?, pickup_signature_url),
         pickup_proof_url = COALESCE(?, pickup_proof_url),
         status = CASE WHEN status IN ('pending','confirmed','assigned','accepted') THEN 'picked_up' ELSE status END,
         picked_up_at = CASE WHEN status IN ('pending','confirmed','assigned','accepted') THEN ? ELSE picked_up_at END
       WHERE id = ? AND workshop_id = ?`,
      [now, notes || null, resolvedSignatureUrl || null, safeProofUrl || null, now, order.id, req.workshopId]
    );

    // Log
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'picked_up', req.user.id, `Vehicle pickup confirmed by mechanic. ${notes || ''}`.trim(), lat || null, lng || null]
    );

    // Update pickup_request
    const [existingReq] = await query(
      `SELECT id FROM pickup_requests WHERE work_order_id = ? AND workshop_id = ? AND status NOT IN ('picked_up','failed','cancelled') ORDER BY id DESC LIMIT 1`,
      [order.id, req.workshopId]
    );
    if (existingReq) {
      await execute(
        "UPDATE pickup_requests SET status = 'picked_up', picked_up_at = ?, proof_photo_url = COALESCE(?, proof_photo_url), lat = ?, lng = ? WHERE id = ?",
        [now, safeProofUrl || null, lat || null, lng || null, existingReq.id]
      );
    }

    return res.json({ success: true, message: 'Vehicle pickup confirmed successfully' });
  } catch (err) {
    console.error('[MechanicApp] pickup confirm error:', err);
    return res.status(500).json({ success: false, message: 'Failed to confirm vehicle pickup' });
  }
});

/**
 * POST /api/mechanic-app/pickups/:workOrderId/fail
 * Report vehicle pickup failure
 */
router.post('/pickups/:workOrderId/fail', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { reason, lat, lng } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'reason is required' });

    const [order] = await query(
      'SELECT id, pickup_status FROM work_orders WHERE id = ? AND workshop_id = ? AND (pickup_mechanic_id = ? OR mechanic_id = ?)',
      [req.params.workOrderId, req.workshopId, mechanic.id, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    await execute(
      "UPDATE work_orders SET pickup_status = 'pickup_failed', pickup_notes = ?, pickup_mechanic_id = NULL WHERE id = ? AND workshop_id = ?",
      [reason, order.id, req.workshopId]
    );

    // Log — keep current status (accepted), don't regress to 'assigned'
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'accepted', req.user.id, `Vehicle pickup failed: ${reason}`, lat || null, lng || null]
    );

    // Update pickup_request
    const [existingReq] = await query(
      `SELECT id FROM pickup_requests WHERE work_order_id = ? AND workshop_id = ? AND status NOT IN ('picked_up','failed','cancelled') ORDER BY id DESC LIMIT 1`,
      [order.id, req.workshopId]
    );
    if (existingReq) {
      await execute(
        "UPDATE pickup_requests SET status = 'failed', failed_at = NOW(), failure_reason = ?, lat = ?, lng = ? WHERE id = ?",
        [reason, lat || null, lng || null, existingReq.id]
      );
    }

    return res.json({ success: true, message: 'Vehicle pickup failure reported' });
  } catch (err) {
    console.error('[MechanicApp] pickup fail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to report vehicle pickup failure' });
  }
});

/**
 * POST /api/mechanic-app/orders/:workOrderId/start-service
 * Transition work order from picked_up → in_transit (now: "in progress / being worked on")
 * (renamed concept from "start-delivery" / out-for-delivery)
 */
router.post('/orders/:workOrderId/start-service', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { lat, lng } = req.body;
    const [order] = await query(
      "SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?",
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (!['picked_up'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot start service from status '${order.status}'. Vehicle pickup must be completed first.` });
    }

    await execute(
      "UPDATE work_orders SET status = 'in_transit', in_transit_at = NOW() WHERE id = ? AND workshop_id = ?",
      [order.id, req.workshopId]
    );
    await execute(
      "UPDATE mechanics SET status = 'busy' WHERE id = ?", [mechanic.id]
    );
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'in_transit', req.user.id, 'Service started — work in progress', lat || null, lng || null]
    );

    return res.json({ success: true, message: 'Service started — work in progress' });
  } catch (err) {
    console.error('[MechanicApp] start-service error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start service' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  F. VIN / PLATE CHECK-IN SCAN                                ║
   ║  (repurposed from barcode scanning during a delivery route)  ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/scan
 * Look up a work order by scanned/entered VIN or plate number at drop-off.
 * Repurposed from package-barcode scanning — a workshop doesn't scan
 * per-package barcodes mid-delivery, but checking in a vehicle by its
 * VIN/plate at drop-off is a natural equivalent.
 * Body: { code }  — VIN or plate number
 *
 * DROPPED (not ported): POST /scan/batch (used to scan a batch of package
 * barcodes at pickup — no batch-of-packages concept in a workshop) and
 * POST /scan/verify-delivery (verified a scanned package belonged to the
 * correct delivery stop — no stops concept here; see file header notes).
 */
router.post('/scan', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'code (VIN or plate) is required' });

    // Try vehicles table first (VIN or plate)
    let vehicle = null;
    try {
      [vehicle] = await query(
        `SELECT * FROM vehicles WHERE (vin = ? OR plate = ?) AND workshop_id = ?`,
        [code, code, req.workshopId]
      );
    } catch (_) {}

    if (vehicle) {
      const [order] = await query(
        `SELECT id, work_order_number, tracking_token, status, mechanic_id, pickup_mechanic_id,
                customer_name, customer_phone, customer_address, cash_amount, payment_method
         FROM work_orders
         WHERE vehicle_id = ? AND workshop_id = ?
         ORDER BY created_at DESC LIMIT 1`,
        [vehicle.id, req.workshopId]
      );
      const isAssigned = order && (order.mechanic_id === mechanic.id || order.pickup_mechanic_id === mechanic.id);
      return res.json({
        success: true,
        type: 'vehicle',
        is_assigned: !!isAssigned,
        data: { vehicle, work_order: order || null },
      });
    }

    // Fall back to work order tracking token / work order number
    const [order] = await query(
      `SELECT id, work_order_number, tracking_token, status, mechanic_id, pickup_mechanic_id,
              customer_name, customer_phone, customer_address, cash_amount, payment_method
       FROM work_orders
       WHERE (tracking_token = ? OR work_order_number = ?) AND workshop_id = ?`,
      [code, code, req.workshopId]
    );
    if (!order) {
      return res.status(404).json({ success: false, message: 'No matching vehicle or work order found', code });
    }
    const isAssigned = order.mechanic_id === mechanic.id || order.pickup_mechanic_id === mechanic.id;
    return res.json({
      success: true,
      type: 'work_order',
      is_assigned: isAssigned,
      data: order,
    });
  } catch (err) {
    console.error('[MechanicApp] scan error:', err);
    return res.status(500).json({ success: false, message: 'Scan failed' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  G. PROOF OF SERVICE / COMPLETION SIGN-OFF                   ║
   ║  (was: Proof of Delivery. Now attaches to the work order      ║
   ║  itself since the "stop" concept was dropped.)                ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/orders/:workOrderId/proof-photo
 * Upload proof-of-service photo (multi-photo, plan-limited)
 * (was: proof-of-delivery photo; now covers e.g. photo of the completed
 * repair). The "stop-proof" variant from the original was dropped along
 * with the stops concept — this single endpoint now covers what the
 * original split between order-level and stop-level proof photos.
 */
router.post('/orders/:workOrderId/proof-photo', proofUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?',
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    await ensureDeliveryPhotosTable();

    // Plan-based photo limit
    const photoLimit = req.subscription?.features?.photo_capture_limit || 5;
    const [countRow] = await query(
      'SELECT COUNT(*) as cnt FROM delivery_photos WHERE work_order_id = ? AND stop_id IS NULL',
      [order.id]
    );
    if (countRow.cnt >= photoLimit) {
      // Clean up uploaded file
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ success: false, message: `Photo limit reached (${photoLimit} per work order on your plan)`, limit: photoLimit, current: countRow.cnt });
    }

    const url = `/uploads/proofs/${req.file.filename}`;
    const { photo_type, caption, lat, lng } = req.body;

    // Insert into delivery_photos
    await execute(
      `INSERT INTO delivery_photos (workshop_id, work_order_id, stop_id, mechanic_id, photo_url, photo_type, caption, lat, lng)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, order.id, mechanic.id, url, photo_type || 'proof_of_delivery', caption || null, lat || null, lng || null]
    );

    // Also update legacy single-photo column with latest
    await execute('UPDATE work_orders SET proof_of_delivery_url = ? WHERE id = ?', [url, order.id]);

    // Return all photos for this work order
    const photos = await query(
      'SELECT id, photo_url, photo_type, caption, lat, lng, uploaded_at FROM delivery_photos WHERE work_order_id = ? AND stop_id IS NULL ORDER BY uploaded_at ASC',
      [order.id]
    );

    return res.json({ success: true, url, photos, limit: photoLimit, count: photos.length, message: 'Proof photo uploaded' });
  } catch (err) {
    console.error('[MechanicApp] proof-photo upload error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Photo upload failed' });
  }
});

/**
 * POST /api/mechanic-app/orders/:workOrderId/signature
 * Upload customer completion sign-off signature
 */
router.post('/orders/:workOrderId/signature', signatureUpload.single('file'), async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?',
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    let url;
    // Handle base64 signature sent as JSON (from mobile mechanic app)
    if (!req.file && req.body?.signature) {
      url = await saveBase64Signature(req.body.signature, req.params.workOrderId);
    } else if (req.file) {
      // Try S3 first, fall back to local
      if (isS3Configured()) {
        try {
          const { url: s3Url } = await uploadToS3(
            fs.readFileSync(req.file.path), 'signatures', req.file.filename, req.file.mimetype || 'image/png'
          );
          url = s3Url;
          fs.unlink(req.file.path, () => {});
        } catch (s3Err) {
          console.warn('[MechanicApp] S3 signature file upload failed, using local:', s3Err.message);
          url = `/uploads/signatures/${req.file.filename}`;
        }
      } else {
        url = `/uploads/signatures/${req.file.filename}`;
      }
    } else {
      return res.status(400).json({ success: false, message: 'No file or signature data provided' });
    }

    await execute('UPDATE work_orders SET signature_url = ? WHERE id = ?', [url, order.id]);

    return res.json({ success: true, url, message: 'Signature uploaded' });
  } catch (err) {
    console.error('[MechanicApp] order signature upload error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Signature upload failed' });
  }
});

/**
 * GET /api/mechanic-app/orders/:workOrderId/photos
 * Get all photos for a work order
 */
router.get('/orders/:workOrderId/photos', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [order] = await query(
      'SELECT id FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?',
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    await ensureDeliveryPhotosTable();

    const photos = await query(
      'SELECT id, photo_url, photo_type, caption, stop_id, lat, lng, uploaded_at FROM delivery_photos WHERE work_order_id = ? ORDER BY uploaded_at ASC',
      [order.id]
    );
    const photoLimit = req.subscription?.features?.photo_capture_limit || 5;

    return res.json({ success: true, data: photos, limit: photoLimit, count: photos.length });
  } catch (err) {
    console.error('[MechanicApp] get photos error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load photos' });
  }
});

/**
 * DELETE /api/mechanic-app/photos/:photoId
 * Delete a specific photo (mechanic can only delete own photos)
 */
router.delete('/photos/:photoId', async (req, res) => {
  try {
    await ensureDeliveryPhotosTable();
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [photo] = await query(
      'SELECT id, photo_url FROM delivery_photos WHERE id = ? AND mechanic_id = ? AND workshop_id = ?',
      [req.params.photoId, mechanic.id, req.workshopId]
    );
    if (!photo) return res.status(404).json({ success: false, message: 'Photo not found' });

    await execute('DELETE FROM delivery_photos WHERE id = ?', [photo.id]);

    // Clean up file
    const filePath = path.join(UPLOADS_DIR, '..', photo.photo_url);
    fs.unlink(filePath, () => {});

    return res.json({ success: true, message: 'Photo deleted' });
  } catch (err) {
    console.error('[MechanicApp] delete photo error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete photo' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  H. CASH PAYMENT HANDLING (was: COD)                         ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/cash/pending
 * List all pending cash-payment work orders for this mechanic
 */
router.get('/cash/pending', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const rows = await query(
      `SELECT o.id, o.work_order_number, o.tracking_token, o.status,
              o.customer_name, o.customer_phone, o.customer_address,
              o.cash_amount, o.cash_collected, o.payment_method,
              o.delivered_at, o.created_at
       FROM work_orders o
       WHERE o.mechanic_id = ? AND o.workshop_id = ?
         AND o.payment_method = 'cash'
         AND o.status IN ('in_transit','picked_up','assigned','accepted','delivered')
         AND (o.cash_collected = 0 OR o.cash_collected IS NULL OR o.cash_collected < 2)
       ORDER BY o.created_at DESC`,
      [mechanic.id, req.workshopId]
    );

    const totalPending = rows.reduce((sum, r) => sum + parseFloat(r.cash_amount || 0), 0);

    return res.json({ success: true, data: rows, total_pending: totalPending });
  } catch (err) {
    console.error('[MechanicApp] cash pending error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load cash-payment work orders' });
  }
});

/**
 * POST /api/mechanic-app/cash/:workOrderId/collect
 * Mark cash payment as collected from the customer
 * Body: { amount_collected, payment_method_detail: 'cash'|'card' }
 */
router.post('/cash/:workOrderId/collect', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { amount_collected, payment_method_detail, notes } = req.body;
    const [order] = await query(
      `SELECT id, cash_amount, cash_collected, payment_method
       FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ? AND payment_method = 'cash'`,
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Cash-payment work order not found' });

    const amount = parseFloat(amount_collected) || parseFloat(order.cash_amount) || 0;
    const [_w] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
    const currency = _w?.currency || 'AED';

    if (amount_collected && parseFloat(amount_collected) > parseFloat(order.cash_amount)) {
      return res.status(400).json({ success: false, message: `Cannot collect more than the cash amount due (${order.cash_amount})` });
    }

    // cash_collected: 0=not collected, 1=collected by mechanic, 2=settled with admin
    await execute(
      'UPDATE work_orders SET cash_collected = 1, cash_collected_at = NOW() WHERE id = ? AND workshop_id = ?',
      [order.id, req.workshopId]
    );

    // Log
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)',
      [order.id, 'in_transit', req.user.id, `Cash ${amount} ${currency} collected via ${payment_method_detail || 'cash'}. ${notes || ''}`.trim()]
    );

    return res.json({ success: true, message: `Cash ${amount} ${currency} collected`, amount });
  } catch (err) {
    console.error('[MechanicApp] cash collect error:', err);
    return res.status(500).json({ success: false, message: 'Failed to collect cash payment' });
  }
});

/**
 * GET /api/mechanic-app/cash/summary
 * Daily cash-payment summary for the mechanic
 */
router.get('/cash/summary', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Today's cash summary
    const [daySummary] = await query(
      `SELECT
         COUNT(*) as total_cash_orders,
         COALESCE(SUM(CASE WHEN status = 'delivered' AND cash_collected >= 1 THEN cash_amount ELSE 0 END), 0) as collected,
         COALESCE(SUM(CASE WHEN status IN ('in_transit','picked_up','assigned','accepted') THEN cash_amount ELSE 0 END), 0) as pending,
         COALESCE(SUM(CASE WHEN cash_collected >= 2 THEN cash_amount ELSE 0 END), 0) as settled,
         COALESCE(SUM(cash_amount), 0) as total_cash_amount
       FROM work_orders
       WHERE mechanic_id = ? AND workshop_id = ? AND payment_method = 'cash'
         AND DATE(created_at) = ?`,
      [mechanic.id, req.workshopId, targetDate]
    );

    // All-time cash totals (for earnings screen cards)
    const [allTime] = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'delivered' AND cash_collected >= 1 THEN cash_amount ELSE 0 END), 0) as total_collected,
         COALESCE(SUM(CASE WHEN status IN ('in_transit','picked_up','assigned','accepted') AND cash_amount > 0 THEN cash_amount ELSE 0 END), 0) as total_pending
       FROM work_orders
       WHERE mechanic_id = ? AND workshop_id = ? AND payment_method = 'cash'`,
      [mechanic.id, req.workshopId]
    );

    // Unsettled carried over from previous days
    const [unsettled] = await query(
      `SELECT COALESCE(SUM(cash_amount), 0) as unsettled_total
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ? AND payment_method = 'cash'
         AND status = 'delivered' AND cash_collected < 2`,
      [mechanic.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        date: targetDate,
        ...daySummary,
        total_collected: allTime.total_collected,
        total_pending: allTime.total_pending,
        unsettled_carry_over: unsettled.unsettled_total,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] cash summary error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load cash summary' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  I. WORK ORDER OUTCOME — COMPLETE / FAIL / RETURN            ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/orders/:workOrderId/deliver
 * Mark a work order as completed (service done, vehicle ready).
 * Endpoint path kept as "/deliver" for backward client compatibility with
 * the original mobile app build; the semantics are "service completed".
 * Body: { signature_url?, proof_photo_url?, cash_collected?, notes?, lat, lng }
 */
router.post('/orders/:workOrderId/deliver', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { signature_url, proof_photo_url, cash_collected, notes, lat, lng, signature } = req.body;

    const [order] = await query(
      "SELECT id, status, payment_method, cash_amount, service_fee FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?",
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Already completed — return success (idempotent)
    if (order.status === 'delivered') {
      return res.json({ success: true, message: 'Work order already completed' });
    }

    // Auto-transition: accepted → picked_up → in_transit if needed
    if (order.status === 'accepted') {
      await execute("UPDATE work_orders SET status = 'picked_up', picked_up_at = NOW() WHERE id = ?", [order.id]);
      await execute('INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
        [order.id, 'picked_up', req.user.id, 'Auto-transitioned during completion', lat || null, lng || null]);
      order.status = 'picked_up';
    }
    if (order.status === 'picked_up') {
      await execute("UPDATE work_orders SET status = 'in_transit', in_transit_at = NOW() WHERE id = ?", [order.id]);
      await execute('INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
        [order.id, 'in_transit', req.user.id, 'Auto-transitioned during completion', lat || null, lng || null]);
      order.status = 'in_transit';
    }

    if (!['in_transit'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot complete from status '${order.status}'. Vehicle pickup must be completed first.` });
    }

    // If cash payment, mark as collected
    const cashVal = (order.payment_method === 'cash' && cash_collected !== false) ? 1 : 0;
    const resolvedSignatureUrl = sanitizeMediaUrl(signature_url) || (signature ? await saveBase64Signature(signature, order.id) : null);
    const safeProofUrl = sanitizeMediaUrl(proof_photo_url);

    await execute(
      `UPDATE work_orders SET
         status = 'delivered', delivered_at = NOW(),
         signature_url = COALESCE(?, signature_url),
         proof_of_delivery_url = COALESCE(?, proof_of_delivery_url),
         cash_collected = CASE WHEN payment_method = 'cash' THEN ? ELSE cash_collected END,
         cash_collected_at = CASE WHEN payment_method = 'cash' AND ? = 1 THEN NOW() ELSE cash_collected_at END,
         notes = COALESCE(?, notes)
       WHERE id = ? AND workshop_id = ?`,
      [resolvedSignatureUrl || null, safeProofUrl || null, cashVal, cashVal, notes || null, order.id, req.workshopId]
    );

    // Log status
    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'delivered', req.user.id, `Completed by mechanic. ${notes || ''}`.trim(), lat || null, lng || null]
    );

    // Update mechanic stats
    await execute('UPDATE mechanics SET total_jobs_completed = total_jobs_completed + 1 WHERE id = ?', [mechanic.id]);

    // #201 — Auto-record mechanic earning
    recordMechanicEarning({
      workshopId: req.workshopId, mechanicId: mechanic.id, workOrderId: order.id,
      serviceFee: parseFloat(order.service_fee) || 0,
      cashAmount: parseFloat(order.cash_amount) || 0,
    }).catch(e => console.error('[MechanicApp] earning record error:', e.message));

    // Release mechanic if no more active work orders
    const [activeCount] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_transit','picked_up') AND id != ?",
      [mechanic.id, order.id]
    );
    if (activeCount.cnt === 0) {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [mechanic.id]);
    }

    return res.json({ success: true, message: 'Work order completed successfully' });
  } catch (err) {
    console.error('[MechanicApp] deliver error:', err);
    return res.status(500).json({ success: false, message: 'Failed to complete work order' });
  }
});

/**
 * POST /api/mechanic-app/orders/:workOrderId/fail
 * Mark work order as failed
 * Body: { reason, lat, lng }
 */
router.post('/orders/:workOrderId/fail', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { reason, lat, lng } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'reason is required' });

    const [order] = await query(
      "SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?",
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (!['assigned', 'accepted', 'picked_up', 'in_transit'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot fail work order in '${order.status}' status` });
    }

    await execute(
      "UPDATE work_orders SET status = 'failed', failed_at = NOW(), failure_reason = ? WHERE id = ? AND workshop_id = ?",
      [reason, order.id, req.workshopId]
    );

    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'failed', req.user.id, `Job failed: ${reason}`, lat || null, lng || null]
    );

    // Release mechanic
    const [activeCount] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_transit','picked_up') AND id != ?",
      [mechanic.id, order.id]
    );
    if (activeCount.cnt === 0) {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [mechanic.id]);
    }

    return res.json({ success: true, message: 'Work order marked as failed' });
  } catch (err) {
    console.error('[MechanicApp] fail order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update work order' });
  }
});

/**
 * POST /api/mechanic-app/orders/:workOrderId/return
 * Mark work order for return (was: return package to sender; now: e.g.
 * vehicle needs to go back for warranty/rework)
 * Body: { reason, lat, lng }
 */
router.post('/orders/:workOrderId/return', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { reason, lat, lng } = req.body;

    const [order] = await query(
      "SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ? AND mechanic_id = ?",
      [req.params.workOrderId, req.workshopId, mechanic.id]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Work order not found' });
    if (!['picked_up', 'in_transit'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot return work order in '${order.status}' status. Vehicle pickup must be completed first.` });
    }

    await execute(
      "UPDATE work_orders SET status = 'returned', returned_at = NOW(), failure_reason = ? WHERE id = ? AND workshop_id = ?",
      [reason || 'Returned by mechanic', order.id, req.workshopId]
    );

    await execute(
      'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      [order.id, 'returned', req.user.id, `Return: ${reason || 'No reason'}`, lat || null, lng || null]
    );

    // Release mechanic
    const [activeCount] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_transit','picked_up') AND id != ?",
      [mechanic.id, order.id]
    );
    if (activeCount.cnt === 0) {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [mechanic.id]);
    }

    return res.json({ success: true, message: 'Work order marked for return' });
  } catch (err) {
    console.error('[MechanicApp] return order error:', err);
    return res.status(500).json({ success: false, message: 'Failed to return work order' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  J. PROGRESS                                                 ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/progress
 * Overall work progress for the mechanic today.
 * (was: "Route Progress" including multi-stop totals — the stops totals
 * were dropped since work orders no longer have stops; the rest is
 * unchanged.)
 */
router.get('/progress', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const [progress] = await query(
      `SELECT
         COUNT(*) as total_orders,
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
         SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) as returned,
         SUM(CASE WHEN status IN ('assigned','accepted','picked_up','in_transit') THEN 1 ELSE 0 END) as remaining,
         COALESCE(SUM(CASE WHEN status = 'delivered' THEN service_fee ELSE 0 END), 0) as earned,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status = 'delivered' THEN cash_amount ELSE 0 END), 0) as cash_collected
       FROM work_orders WHERE mechanic_id = ? AND workshop_id = ?
         AND DATE(created_at) = CURDATE()`,
      [mechanic.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        ...progress,
        completion_pct: progress.total_orders > 0
          ? Math.round(((progress.completed + progress.failed + progress.returned) / progress.total_orders) * 100)
          : 0,
      },
    });
  } catch (err) {
    console.error('[MechanicApp] progress error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load progress' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  K. LIVE LOCATION TRACKING                                   ║
   ║  (kept — used while a mechanic travels to a vehicle pickup)  ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/location
 * Update mechanic GPS location (called every 10-30 seconds while en route
 * to a vehicle pickup or doing a mobile/on-site job)
 * Body: { lat, lng, speed?, heading?, accuracy?, work_order_id? }
 *
 * NOTE: the original also auto-detected in-progress "delivery stop" arrival
 * across a multi-stop route. That multi-stop geofence branch was dropped
 * since work orders don't have a stops concept; the pickup-arrival geofence
 * (mechanic approaching the customer's vehicle for pickup) is kept since it
 * maps onto the real vehicle-pickup flow.
 */
router.post('/location', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { lat, lng, speed, heading, accuracy, work_order_id } = req.body;
    if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng are required' });

    await execute(
      'INSERT INTO mechanic_locations (mechanic_id, work_order_id, lat, lng, speed, heading, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [mechanic.id, work_order_id || null, lat, lng, speed || null, heading || null, accuracy || null]
    );

    // Auto-detect service bay from GPS if mechanic has none assigned
    try {
      if (!mechanic.service_bay_id) {
        const bayId = await detectZone(req.workshopId, parseFloat(lat), parseFloat(lng));
        if (bayId) {
          await execute('UPDATE mechanics SET service_bay_id = ? WHERE id = ?', [bayId, mechanic.id]);
        }
      }
    } catch (_) { /* service bay detection not critical */ }

    // ── Vehicle-pickup geofence auto-detection ──────────────────
    // Check if mechanic is within radius of the vehicle pickup point.
    try {
      const dLat = parseFloat(lat), dLng = parseFloat(lng);
      if (Number.isFinite(dLat) && Number.isFinite(dLng)) {
        // Read configurable radius (default 200 meters)
        const [radiusSetting] = await query(
          "SELECT value FROM settings WHERE workshop_id = ? AND `key` = 'geofence_radius_meters'",
          [req.workshopId]
        );
        const RADIUS = parseInt(radiusSetting?.value, 10) || 200;

        // Get all active work orders for this mechanic
        const activeOrders = await query(
          `SELECT id, work_order_number, status, pickup_status,
                  sender_lat, sender_lng
           FROM work_orders
           WHERE mechanic_id = ? AND workshop_id = ?
             AND status IN ('accepted','picked_up','in_transit')`,
          [mechanic.id, req.workshopId]
        );

        for (const ord of activeOrders) {
          // ── Pickup geofence: auto-mark "mechanic_arrived" at vehicle pickup ──
          if (ord.status === 'accepted' && ord.sender_lat && ord.sender_lng &&
              (!ord.pickup_status || ord.pickup_status === 'en_route_to_pickup' || ord.pickup_status === 'pending_pickup')) {
            const distPickup = haversineMeters(dLat, dLng, parseFloat(ord.sender_lat), parseFloat(ord.sender_lng));
            if (distPickup <= RADIUS) {
              await execute(
                "UPDATE work_orders SET pickup_status = 'mechanic_arrived' WHERE id = ? AND pickup_status != 'mechanic_arrived' AND pickup_status != 'picked_up'",
                [ord.id]
              );
              await execute(
                'INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
                [ord.id, ord.status, mechanic.user_id || mechanic.id, `Geofence: arrived at vehicle pickup (${Math.round(distPickup)}m)`, dLat, dLng]
              );
              // Update pickup_requests if exists
              await execute(
                `UPDATE pickup_requests SET status = 'arrived', arrived_at = NOW(), lat = ?, lng = ?
                 WHERE work_order_id = ? AND workshop_id = ? AND status NOT IN ('picked_up','failed','cancelled','arrived')
                 ORDER BY id DESC LIMIT 1`,
                [dLat, dLng, ord.id, req.workshopId]
              );
              try {
                const io = getIO();
                io.to(`workshop:${req.workshopId}`).emit('work-order:geofence-arrival', {
                  workOrderId: ord.id, workOrderNumber: ord.work_order_number,
                  type: 'pickup', distance: Math.round(distPickup),
                  mechanicId: mechanic.id, timestamp: new Date().toISOString(),
                });
              } catch (_) {}
            }
          }
        }
      }
    } catch (geoErr) {
      console.error('[MechanicApp] geofence check error:', geoErr.message);
      /* geofence is non-critical — don't fail the location update */
    }

    return res.json({ success: true, message: 'Location updated' });
  } catch (err) {
    console.error('[MechanicApp] location error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update location' });
  }
});

/**
 * POST /api/mechanic-app/location/batch
 * Submit multiple GPS points (offline buffer flush)
 * Body: { points: [{ lat, lng, speed?, heading?, accuracy?, recorded_at }] }
 */
router.post('/location/batch', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { points } = req.body;
    if (!Array.isArray(points) || !points.length) {
      return res.status(400).json({ success: false, message: 'points array is required' });
    }

    let inserted = 0;
    for (const pt of points) {
      if (pt.lat && pt.lng) {
        await execute(
          'INSERT INTO mechanic_locations (mechanic_id, lat, lng, speed, heading, accuracy, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [mechanic.id, pt.lat, pt.lng, pt.speed || null, pt.heading || null, pt.accuracy || null, pt.recorded_at || new Date()]
        );
        inserted++;
      }
    }

    return res.json({ success: true, message: `${inserted} points recorded`, inserted });
  } catch (err) {
    console.error('[MechanicApp] location batch error:', err);
    return res.status(500).json({ success: false, message: 'Failed to record locations' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  L. NOTIFICATIONS & COMMUNICATION                            ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/notifications
 * Get mechanic's notifications
 */
router.get('/notifications', async (req, res) => {
  try {
    const { page = 1, limit = 30, unread_only } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'user_id = ?';
    const params = [req.user.id];
    if (unread_only === 'true') {
      where += ' AND is_read = 0';
    }

    const rows = await query(
      `SELECT * FROM user_notifications WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM user_notifications WHERE ${where}`, params);
    const [{ unread }] = await query('SELECT COUNT(*) as unread FROM user_notifications WHERE user_id = ? AND is_read = 0', [req.user.id]);

    return res.json({ success: true, data: rows, unread, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (err) {
    console.error('[MechanicApp] notifications error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load notifications' });
  }
});

/**
 * PATCH /api/mechanic-app/notifications/:id/read
 * Mark a notification as read
 */
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    await execute('UPDATE user_notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    return res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update' });
  }
});

/**
 * POST /api/mechanic-app/notifications/read-all
 * Mark all notifications as read
 */
router.post('/notifications/read-all', async (req, res) => {
  try {
    await execute('UPDATE user_notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.user.id]);
    return res.json({ success: true, message: 'All marked as read' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update' });
  }
});

/**
 * POST /api/mechanic-app/device-token
 * Register push notification device token
 * Body: { device_token, platform: 'ios'|'android', device_info? }
 */
router.post('/device-token', async (req, res) => {
  try {
    const { device_token, platform, device_info } = req.body;
    if (!device_token) return res.status(400).json({ success: false, message: 'device_token is required' });

    // Upsert — deactivate old tokens for this user, insert new one
    await execute('UPDATE device_tokens SET is_active = 0 WHERE user_id = ? AND workshop_id = ?', [req.user.id, req.workshopId]);
    await execute(
      `INSERT INTO device_tokens (workshop_id, user_id, device_token, platform, device_info, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE device_token = VALUES(device_token), platform = VALUES(platform), device_info = VALUES(device_info), is_active = 1`,
      [req.workshopId, req.user.id, device_token, platform || 'android', device_info || null]
    );

    return res.json({ success: true, message: 'Device token registered' });
  } catch (err) {
    console.error('[MechanicApp] device-token error:', err);
    return res.status(500).json({ success: false, message: 'Failed to register device token' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  M. WORK ORDER HISTORY                                       ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/history
 * Completed work orders with filters
 */
router.get('/history', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { status, date_from, date_to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = "o.mechanic_id = ? AND o.workshop_id = ? AND o.status IN ('delivered','failed','returned')";
    const params = [mechanic.id, req.workshopId];

    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (date_from) { where += ' AND DATE(o.delivered_at) >= ?'; params.push(date_from); }
    if (date_to) { where += ' AND DATE(o.delivered_at) <= ?'; params.push(date_to); }

    const orders = await query(
      `SELECT o.id, o.work_order_number, o.tracking_token, o.status,
              o.customer_name, o.customer_address, o.customer_emirate,
              o.payment_method, o.cash_amount, o.service_fee,
              o.delivered_at, o.failed_at, o.returned_at, o.failure_reason,
              o.signature_url, o.proof_of_delivery_url,
              c.full_name AS customer_full_name
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE ${where}
       ORDER BY COALESCE(o.delivered_at, o.failed_at, o.returned_at) DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM work_orders o WHERE ${where}`, params);

    return res.json({ success: true, data: orders, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (err) {
    console.error('[MechanicApp] history error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load history' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  N. MECHANIC WALLET / EARNINGS                               ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/earnings
 * Mechanic's earnings summary and list (labor commission)
 */
router.get('/earnings', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { date_from, date_to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const config = await getFinancialConfig(req.workshopId);

    // 1. Get stored mechanic_earnings (bonuses, admin entries)
    let storedEarnings = [];
    let storedSummary = { total_earned: 0, total_paid: 0, total_pending: 0 };
    try {
      let where = 'me.workshop_id = ? AND me.mechanic_id = ?';
      const params = [req.workshopId, mechanic.id];
      if (date_from) { where += ' AND me.created_at >= ?'; params.push(date_from); }
      if (date_to) { where += ' AND me.created_at <= ?'; params.push(date_to + ' 23:59:59'); }

      storedEarnings = await query(
        `SELECT me.*, o.work_order_number FROM mechanic_earnings me
         LEFT JOIN work_orders o ON me.work_order_id = o.id
         WHERE ${where}
         ORDER BY me.created_at DESC`,
        params
      );
      const [sumRow] = await query(
        `SELECT COALESCE(SUM(net_amount), 0) as total_earned,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN net_amount ELSE 0 END), 0) as total_paid,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN net_amount ELSE 0 END), 0) as total_pending
         FROM mechanic_earnings WHERE workshop_id = ? AND mechanic_id = ?`,
        [req.workshopId, mechanic.id]
      );
      storedSummary = sumRow;
    } catch { /* mechanic_earnings table may not exist */ }

    // Collect work_order_ids already in mechanic_earnings to avoid duplicates
    const storedOrderIds = new Set(storedEarnings.filter(e => e.work_order_id).map(e => e.work_order_id));

    // 2. Compute earnings for completed work orders NOT already in mechanic_earnings
    let orderWhere = 'mechanic_id = ? AND workshop_id = ? AND status = ?';
    const orderParams = [mechanic.id, req.workshopId, 'delivered'];
    if (date_from) { orderWhere += ' AND delivered_at >= ?'; orderParams.push(date_from); }
    if (date_to) { orderWhere += ' AND delivered_at <= ?'; orderParams.push(date_to + ' 23:59:59'); }

    const completed = await query(
      `SELECT id, work_order_number, service_fee, cash_amount, delivered_at, created_at
       FROM work_orders WHERE ${orderWhere} ORDER BY delivered_at DESC`,
      orderParams
    );

    let computedEarned = 0;
    const computedEarnings = completed
      .filter(o => !storedOrderIds.has(o.id))
      .map(o => {
        const { netEarning, baseAmount, cashBonus } = computeMechanicEarning({
          serviceFee: parseFloat(o.service_fee) || 0,
          cashAmount: parseFloat(o.cash_amount) || 0,
          config,
        });
        const net = netEarning > 0 ? netEarning : (parseFloat(o.service_fee) || 0);
        computedEarned += net;
        return {
          id: `computed-${o.id}`, work_order_id: o.id, work_order_number: o.work_order_number,
          earning_type: 'service', base_amount: baseAmount || net, bonus: cashBonus || 0,
          deductions: 0, net_amount: net, status: 'pending',
          created_at: o.delivered_at || o.created_at,
        };
      });

    // 3. Merge stored + computed, sort by date
    const allEarnings = [...storedEarnings, ...computedEarnings]
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const total = allEarnings.length;
    const earnings = allEarnings.slice(offset, offset + parseInt(limit));
    const summary = {
      total_earned: Number(storedSummary.total_earned) + computedEarned,
      total_paid: Number(storedSummary.total_paid),
      total_pending: Number(storedSummary.total_pending) + computedEarned,
    };

    return res.json({ success: true, data: earnings, summary, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (err) {
    console.error('[MechanicApp] earnings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load earnings' });
  }
});

/**
 * GET /api/mechanic-app/earnings/daily
 * Daily earnings breakdown — merges work-order-based earnings + standalone bonuses.
 * For each completed work order, uses stored mechanic_earnings if available,
 * otherwise computes on-the-fly from workshop config / service_fee.
 */
router.get('/earnings/daily', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    const { days = 30 } = req.query;
    const config = await getFinancialConfig(req.workshopId);

    // 1. Get completed work orders with optional stored earnings
    const orderRows = await query(
      `SELECT DATE(o.delivered_at) as date,
              o.id as work_order_id,
              o.service_fee,
              o.cash_amount,
              o.payment_method,
              me.net_amount as me_amount
       FROM work_orders o
       LEFT JOIN mechanic_earnings me ON me.work_order_id = o.id AND me.mechanic_id = ? AND me.workshop_id = ?
       WHERE o.mechanic_id = ? AND o.workshop_id = ? AND o.status = 'delivered'
         AND o.delivered_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY o.delivered_at DESC`,
      [mechanic.id, req.workshopId, mechanic.id, req.workshopId, parseInt(days)]
    );

    // 2. Get standalone earnings (bonuses / extras with no work_order_id)
    let bonusRows = [];
    try {
      bonusRows = await query(
        `SELECT DATE(created_at) as date, COALESCE(net_amount, 0) as earned
         FROM mechanic_earnings
         WHERE mechanic_id = ? AND workshop_id = ? AND work_order_id IS NULL
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [mechanic.id, req.workshopId, parseInt(days)]
      );
    } catch { /* mechanic_earnings table may not exist */ }

    // 3. Aggregate by date
    const dateMap = {};

    for (const row of orderRows) {
      const d = row.date;
      if (!d) continue;
      if (!dateMap[d]) dateMap[d] = { date: d, jobs_completed: 0, earned: 0, cash_collected: 0 };
      dateMap[d].jobs_completed += 1;

      // Use stored earning if available, otherwise compute on-the-fly
      let earning = Number(row.me_amount) || 0;
      if (earning <= 0) {
        const computed = computeMechanicEarning({
          serviceFee: parseFloat(row.service_fee) || 0,
          cashAmount: parseFloat(row.cash_amount) || 0,
          config,
        });
        earning = computed.netEarning > 0 ? computed.netEarning : (parseFloat(row.service_fee) || 0);
      }
      dateMap[d].earned += earning;

      if (row.payment_method === 'cash') {
        dateMap[d].cash_collected += parseFloat(row.cash_amount) || 0;
      }
    }

    // Add standalone bonuses / extras
    for (const row of bonusRows) {
      const d = row.date;
      if (!d) continue;
      if (!dateMap[d]) dateMap[d] = { date: d, jobs_completed: 0, earned: 0, cash_collected: 0 };
      dateMap[d].earned += Number(row.earned) || 0;
    }

    // Round earned values
    const rows = Object.values(dateMap)
      .map(r => ({ ...r, earned: Math.round(r.earned * 100) / 100 }))
      .sort((a, b) => (b.date > a.date ? 1 : -1));

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[MechanicApp] daily earnings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load daily earnings' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  O. SETTINGS & DEVICE                                        ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * GET /api/mechanic-app/settings
 * Get workshop-level settings relevant to the mechanic (branding, cash rules, etc.)
 */
router.get('/settings', async (req, res) => {
  try {
    const [workshop] = await query(
      'SELECT id, name, slug, logo_url, logo_url_white, currency, settings FROM workshops WHERE id = ?',
      [req.workshopId]
    );
    if (!workshop) return res.status(404).json({ success: false, message: 'Workshop not found' });

    let settings = workshop.settings || {};
    if (typeof settings === 'string') try { settings = JSON.parse(settings); } catch { settings = {}; }

    // Get plan-based photo limit
    const photoLimit = req.subscription?.features?.photo_capture_limit || 5;

    return res.json({
      success: true,
      data: {
        workshop: { id: workshop.id, name: workshop.name, slug: workshop.slug, logo_url: workshop.logo_url, logo_url_white: workshop.logo_url_white },
        settings: {
          require_signature: settings.require_signature || false,
          require_photo_proof: settings.require_photo_proof || false,
          require_vin_scan: settings.require_barcode_scan || false,
          auto_cash_collect: settings.auto_cod_collect !== false,
          navigation_provider: settings.navigation_provider || 'google_maps',
          language: settings.mechanic_app_language || 'en',
          currency: workshop.currency || settings.currency || 'AED',
          photo_capture_limit: photoLimit,
          max_photo_size_mb: 10,
          allowed_photo_types: ['jpg', 'jpeg', 'png', 'webp'],
        },
      },
    });
  } catch (err) {
    console.error('[MechanicApp] settings error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  P. SHIFT & AVAILABILITY                                     ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/go-online
 * Toggle mechanic to available
 */
router.post('/go-online', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    await execute("UPDATE mechanics SET status = 'available' WHERE id = ?", [mechanic.id]);
    return res.json({ success: true, message: 'You are now online', status: 'available' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to go online' });
  }
});

/**
 * POST /api/mechanic-app/go-offline
 * Toggle mechanic to offline
 */
router.post('/go-offline', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    // Check for active work orders
    const [active] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_transit','picked_up')",
      [mechanic.id]
    );
    if (active.cnt > 0) {
      return res.status(400).json({ success: false, message: `Cannot go offline — ${active.cnt} active job(s)` });
    }

    await execute("UPDATE mechanics SET status = 'offline' WHERE id = ?", [mechanic.id]);
    return res.json({ success: true, message: 'You are now offline', status: 'offline' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to go offline' });
  }
});

/**
 * POST /api/mechanic-app/on-break
 * Toggle mechanic to on_break
 */
router.post('/on-break', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic profile not found' });

    await execute("UPDATE mechanics SET status = 'on_break' WHERE id = ?", [mechanic.id]);
    return res.json({ success: true, message: 'You are on break', status: 'on_break' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /api/mechanic-app/logout
 * Logout — set mechanic offline, invalidate device token
 */
router.post('/logout', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    if (mechanic) {
      await execute("UPDATE mechanics SET status = 'offline' WHERE id = ?", [mechanic.id]);
    }
    // Deactivate device tokens
    await execute('UPDATE device_tokens SET is_active = 0 WHERE user_id = ? AND workshop_id = ?', [req.user.id, req.workshopId]);

    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Logout failed' });
  }
});


/* ╔═══════════════════════════════════════════════════════════════╗
   ║  Q. SUPPORT & HELP                                            ║
   ╚═══════════════════════════════════════════════════════════════╝ */

/**
 * POST /api/mechanic-app/support/ticket
 * Create a support ticket
 */
router.post('/support/ticket', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    const { subject, description, priority, order_id } = req.body;
    // Accept both 'category' and 'type' (mobile app sends 'type')
    const category = req.body.category || req.body.type;
    if (!subject) return res.status(400).json({ success: false, message: 'Subject is required' });

    const validCategories = ['bug', 'feature_request', 'billing', 'account', 'technical', 'other',
                             'order_issue', 'app_bug', 'payment', 'navigation'];
    const validPriorities = ['low', 'medium', 'high', 'critical'];

    const finalCategory = validCategories.includes(category) ? category : 'other';
    const finalPriority = validPriorities.includes(priority) ? priority : 'medium';

    const result = await execute(
      `INSERT INTO support_tickets (workshop_id, tenant_name, user_id, user_name, subject, description, category, priority)
       VALUES (?, (SELECT name FROM workshops WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
      [
        req.workshopId, req.workshopId,
        req.user.id,
        mechanic ? mechanic.full_name : req.user.username,
        subject,
        description || `${subject}${order_id ? ` (Work Order #${order_id})` : ''}`,
        finalCategory,
        finalPriority,
      ]
    );

    return res.json({
      success: true,
      message: 'Support ticket created',
      data: {
        id: result.insertId,
        subject,
        description: description || `${subject}${order_id ? ` (Work Order #${order_id})` : ''}`,
        category: finalCategory,
        priority: finalPriority,
        status: 'open',
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[MechanicApp] support ticket error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create ticket' });
  }
});

/**
 * POST /api/mechanic-app/support/report-issue
 * Quick issue report (tool/equipment issue, safety concern, wrong part, etc.)
 */
router.post('/support/report-issue', async (req, res) => {
  try {
    const mechanic = await getMechanic(req);
    const { issue_type, description, order_id, lat, lng } = req.body;
    if (!issue_type) return res.status(400).json({ success: false, message: 'issue_type is required' });

    const validTypes = ['equipment_issue', 'accident', 'wrong_part', 'app_bug', 'safety_concern', 'other'];
    const type = validTypes.includes(issue_type) ? issue_type : 'other';

    const subject = `[Mechanic Issue] ${type.replace(/_/g, ' ').toUpperCase()}${order_id ? ` — Work Order #${order_id}` : ''}`;
    const fullDesc = [
      description || 'No details provided',
      order_id ? `Work Order ID: ${order_id}` : null,
      lat && lng ? `Location: ${lat}, ${lng}` : null,
      `Mechanic: ${mechanic ? mechanic.full_name : req.user.username} (ID: ${mechanic ? mechanic.id : 'N/A'})`,
    ].filter(Boolean).join('\n');

    const result = await execute(
      `INSERT INTO support_tickets (workshop_id, tenant_name, user_id, user_name, subject, description, category, priority)
       VALUES (?, (SELECT name FROM workshops WHERE id = ?), ?, ?, ?, ?, 'technical', 'high')`,
      [
        req.workshopId, req.workshopId,
        req.user.id,
        mechanic ? mechanic.full_name : req.user.username,
        subject,
        fullDesc,
      ]
    );

    // Update mechanic location if provided
    if (mechanic && lat && lng) {
      await execute(
        `INSERT INTO mechanic_locations (mechanic_id, lat, lng) VALUES (?, ?, ?)`,
        [mechanic.id, lat, lng]
      );
    }

    return res.json({
      success: true,
      message: 'Issue reported to the workshop',
      ticket_id: result.insertId,
      issue_type: type,
    });
  } catch (err) {
    console.error('[MechanicApp] report issue error:', err);
    return res.status(500).json({ success: false, message: 'Failed to report issue' });
  }
});

/**
 * GET /api/mechanic-app/support/tickets
 * List mechanic's own support tickets
 */
router.get('/support/tickets', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE st.user_id = ? AND st.workshop_id = ?';
    const params = [req.user.id, req.workshopId];

    if (status) {
      where += ' AND st.status = ?';
      params.push(status);
    }

    const tickets = await query(
      `SELECT st.id, st.subject, st.category, st.priority, st.status, st.created_at, st.updated_at,
              st.resolution, st.resolved_at
       FROM support_tickets st
       ${where}
       ORDER BY st.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM support_tickets st ${where}`, params
    );

    return res.json({
      success: true,
      data: tickets,
      pagination: { page: Number(page), limit: Number(limit), total },
    });
  } catch (err) {
    console.error('[MechanicApp] list tickets error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch tickets' });
  }
});

/**
 * GET /api/mechanic-app/support/tickets/:id
 * Get single ticket detail with replies
 */
router.get('/support/tickets/:id', async (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const [ticket] = await query(
      `SELECT st.id, st.subject, st.description, st.category, st.priority, st.status,
              st.resolution, st.resolved_at, st.created_at, st.updated_at
       FROM support_tickets st
       WHERE st.id = ? AND st.user_id = ? AND st.workshop_id = ?`,
      [ticketId, req.user.id, req.workshopId]
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const replies = await query(
      `SELECT id, sender_type, sender_name, message, created_at
       FROM ticket_replies
       WHERE ticket_id = ?
       ORDER BY created_at ASC`,
      [ticketId]
    );

    return res.json({
      success: true,
      data: { ...ticket, replies },
    });
  } catch (err) {
    console.error('[MechanicApp] ticket detail error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch ticket' });
  }
});

/**
 * POST /api/mechanic-app/support/tickets/:id/reply
 * Mechanic replies to a ticket
 */
router.post('/support/tickets/:id/reply', async (req, res) => {
  try {
    const ticketId = Number(req.params.id);
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message is required' });

    // Verify ticket belongs to this mechanic
    const [ticket] = await query(
      'SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ? AND workshop_id = ?',
      [ticketId, req.user.id, req.workshopId]
    );
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (ticket.status === 'closed') return res.status(400).json({ success: false, message: 'Cannot reply to a closed ticket' });

    const mechanic = await getMechanic(req);
    const senderName = mechanic ? mechanic.full_name : req.user.username;

    const result = await execute(
      `INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, sender_name, message)
       VALUES (?, 'mechanic', ?, ?, ?)`,
      [ticketId, req.user.id, senderName, message.trim()]
    );

    // Reopen ticket if it was resolved/waiting
    if (['resolved', 'waiting'].includes(ticket.status)) {
      await execute('UPDATE support_tickets SET status = "open" WHERE id = ?', [ticketId]);
    }

    return res.json({
      success: true,
      message: 'Reply sent',
      data: {
        id: result.insertId,
        sender_type: 'mechanic',
        sender_name: senderName,
        message: message.trim(),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[MechanicApp] ticket reply error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send reply' });
  }
});

/**
 * GET /api/mechanic-app/help
 * Return FAQ/help content for the mechanic app
 */
router.get('/help', async (req, res) => {
  try {
    const faqs = [
      {
        category: 'Getting Started',
        items: [
          { q: 'How do I go online?', a: 'From the Dashboard, tap the status toggle to switch to "Available". This tells the workshop you are ready for job assignments.' },
          { q: 'How do I view my assigned work orders?', a: 'Tap the "My Jobs" tab at the bottom. You can filter by status (Assigned, In Progress, etc.).' },
          { q: 'How do I navigate to a vehicle pickup address?', a: 'Open a work order detail, then tap the "Navigate" button. It will open Google Maps or Waze with directions.' },
        ],
      },
      {
        category: 'Vehicle Pickup',
        items: [
          { q: 'What is the vehicle pickup flow?', a: 'Tap "En Route" when heading to the customer\'s vehicle → "Arrived" when you get there → "Confirm Pickup" once the vehicle is collected.' },
          { q: 'What if the customer is not available?', a: 'Tap "Failed Pickup" and select the reason. The work order will return to the job pool for rescheduling.' },
          { q: 'Do I need to check in the vehicle at pickup?', a: 'If your workshop requires it (check Settings), scan or enter the vehicle\'s VIN/plate using the Scan screen.' },
        ],
      },
      {
        category: 'Service & Completion',
        items: [
          { q: 'How do I start work on a vehicle?', a: 'From the work order detail, tap "Start Service". This changes the status to "In Progress" and notifies the customer.' },
          { q: 'What if the customer declines the estimate?', a: 'Tap "Fail" on the work order, select the appropriate reason.' },
          { q: 'Do I need to take photos?', a: 'Check Settings → "Require Photo Proof". If enabled, you must upload a proof photo before marking the job complete.' },
        ],
      },
      {
        category: 'Cash Payments',
        items: [
          { q: 'How do I collect a cash payment?', a: 'After completing a cash-payment work order, tap "Collect Cash" and confirm the amount. Keep the cash safe until end-of-day settlement.' },
          { q: 'What if the customer pays a different amount?', a: 'You can edit the collected amount, but note the discrepancy. Contact the workshop office if needed.' },
          { q: 'How do I see my total cash collected?', a: 'Go to "Cash" tab → "Daily Summary" to see collected, pending, and settled amounts.' },
        ],
      },
      {
        category: 'Account & Support',
        items: [
          { q: 'How do I change my password?', a: 'Go to Profile → Change Password. You need your current password to set a new one.' },
          { q: 'I forgot my password', a: 'On the login screen, tap "Forgot Password", enter your phone/email, and follow the reset instructions.' },
          { q: 'How do I report an issue?', a: 'Tap the "Help" icon on any screen → "Report Issue" → select the type and describe the problem.' },
          { q: 'My app is not syncing', a: 'Check your internet connection. The app queues actions offline and syncs automatically when back online.' },
        ],
      },
    ];

    return res.json({ success: true, faqs });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch help content' });
  }
});


/* ── Multer error handler ──────────────────────────────────── */
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large' });
  }
  return res.status(400).json({ success: false, message: err.message || 'Upload error' });
});

/* ════════════════════════════════════════════════════════════════════
   N. Refresh tokens (S5)  +  Phone-verify (S4)  +  App config (DM11)
   Added 2026-04-22.  Refresh-token flow is OPT-IN: the legacy /login
   continues to issue long-lived JWTs, /login-v2 issues a short-lived
   access token + a long-lived refresh token.  Clients can migrate
   incrementally without breaking existing builds.
   ═══════════════════════════════════════════════════════════════════ */

const REFRESH_TTL_DAYS  = parseInt(process.env.MECHANIC_REFRESH_TTL_DAYS  || '30', 10);
const ACCESS_TTL_SHORT  = process.env.MECHANIC_ACCESS_TTL_SHORT || '1h';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function issueRefreshToken({ workshopId, mechanicId, userId, ua, ip }) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = sha256(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000);
  await execute(
    `INSERT INTO mechanic_refresh_tokens (workshop_id, mechanic_id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workshopId, mechanicId, userId, hash, ua?.slice(0,255) || null, ip || null, expiresAt]
  );
  return { refresh_token: raw, expires_at: expiresAt.toISOString() };
}

/* ── POST /api/mechanic-app/refresh — exchange refresh for new access token ── */
router.post('/refresh', mechanicLoginLimiter, async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ success: false, message: 'refresh_token required' });
    const hash = sha256(refresh_token);
    const [row] = await query(
      `SELECT rt.*, u.id AS uid, u.username, u.role, u.workshop_id, u.is_active, u.permissions
         FROM mechanic_refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = ? LIMIT 1`,
      [hash]
    );
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }
    if (!row.is_active) return res.status(403).json({ success: false, message: 'Account inactive' });

    // Rotate: revoke the old token and issue a fresh pair.
    await execute('UPDATE mechanic_refresh_tokens SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const newAccess = jwt.sign(
      { id: row.uid, username: row.username, role: row.role, workshop_id: row.workshop_id, permissions: row.permissions },
      authConfig.jwt.secret,
      { expiresIn: ACCESS_TTL_SHORT }
    );
    const newRefresh = await issueRefreshToken({
      workshopId: row.workshop_id, mechanicId: row.mechanic_id, userId: row.uid,
      ua: req.headers['user-agent'], ip: req.ip,
    });
    res.json({ success: true, token: newAccess, ...newRefresh });
  } catch (err) {
    console.error('[MechanicApp] /refresh error:', err);
    res.status(500).json({ success: false, message: 'Refresh failed' });
  }
});

/* ── POST /api/mechanic-app/logout — revoke a refresh token ── */
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};
    if (refresh_token) {
      await execute('UPDATE mechanic_refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL',
        [sha256(refresh_token)]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── POST /api/mechanic-app/login-v2 — opt-in short-lived access + refresh ── */
router.post('/login-v2', mechanicLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const users = await query(
      `SELECT u.id, u.workshop_id, u.username, u.email, u.password, u.role, u.is_active, u.permissions,
              m.id AS mechanic_id
         FROM users u
         LEFT JOIN mechanics m ON m.user_id = u.id
        WHERE u.role = 'mechanic'
          AND (u.username = ? OR u.email = ? OR m.phone = ? OR m.email = ?) LIMIT 1`,
      [username, username, username, username]
    );
    if (!users.length) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const u = users[0];
    if (!u.is_active) return res.status(403).json({ success: false, message: 'Account inactive' });
    if (!await bcrypt.compare(password, u.password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const access = jwt.sign(
      { id: u.id, username: u.username, role: u.role, workshop_id: u.workshop_id, permissions: u.permissions },
      authConfig.jwt.secret,
      { expiresIn: ACCESS_TTL_SHORT }
    );
    const refresh = await issueRefreshToken({
      workshopId: u.workshop_id, mechanicId: u.mechanic_id, userId: u.id,
      ua: req.headers['user-agent'], ip: req.ip,
    });
    await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
    res.json({ success: true, token: access, ...refresh });
  } catch (err) {
    console.error('[MechanicApp] /login-v2 error:', err);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

/* ── S4 — Phone verification (lightweight, opt-in) ──
   POST /api/mechanic-app/verify-phone/send  { mechanic_id }
   POST /api/mechanic-app/verify-phone/check { mechanic_id, code } */
const phoneVerifyOtps = new Map(); // mechanicId → { code, expires }
router.post('/verify-phone/send', mechanicOtpLimiter, async (req, res) => {
  try {
    const { mechanic_id } = req.body || {};
    if (!mechanic_id) return res.status(400).json({ success: false, message: 'mechanic_id required' });
    const [m] = await query(
      'SELECT id, phone FROM mechanics WHERE id = ? AND workshop_id = ? LIMIT 1',
      [mechanic_id, req.workshopId]
    );
    if (!m) return res.status(404).json({ success: false, message: 'Mechanic not found' });
    const code = crypto.randomInt(100000, 999999).toString();
    phoneVerifyOtps.set(m.id, { code, expires: Date.now() + 10 * 60 * 1000 });
    if (process.env.LOG_OTP_SECRET === 'true') console.log(`[VerifyPhone] mechanic ${m.id}: ${code}`);
    // TODO: wire SMS provider; until then return 200 with a hint flag for dev
    res.json({ success: true, sent: true, ...(process.env.LOG_OTP_SECRET === 'true' ? { _dev_otp: code } : {}) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.post('/verify-phone/check', async (req, res) => {
  try {
    const { mechanic_id, code } = req.body || {};
    if (!mechanic_id || !code) return res.status(400).json({ success: false, message: 'mechanic_id and code required' });
    const entry = phoneVerifyOtps.get(Number(mechanic_id));
    if (!entry || entry.expires < Date.now() || entry.code !== String(code)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired code' });
    }
    await execute(
      'UPDATE mechanics SET phone_verified = 1, phone_verified_at = NOW() WHERE id = ? AND workshop_id = ?',
      [mechanic_id, req.workshopId]
    );
    phoneVerifyOtps.delete(Number(mechanic_id));
    res.json({ success: true, verified: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ── DM11 — App version / force-update endpoint ──
   GET /api/mechanic-app/config?platform=android&version=1.2.3
   Public-ish: requires auth (no workshop gating) so app can call before login
   if we ever decouple, but currently mounted under mechanicApp router. */
function semverGte(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}
router.get('/config', async (req, res) => {
  try {
    const platform = req.query.platform === 'ios' ? 'ios' : 'android';
    const clientVersion = req.query.version || '0.0.0';
    // Prefer workshop-specific row, fall back to global (workshop_id IS NULL).
    const rows = await query(
      `SELECT * FROM mechanic_app_versions
        WHERE platform = ? AND (workshop_id = ? OR workshop_id IS NULL)
        ORDER BY workshop_id IS NULL ASC LIMIT 1`,
      [platform, req.workshopId || 0]
    );
    const cfg = rows[0] || null;
    if (!cfg) {
      return res.json({ success: true, data: { platform, min_version: null, latest_version: null, force_update: false, up_to_date: true } });
    }
    const upToDate = semverGte(clientVersion, cfg.latest_version || cfg.min_version);
    const blocked  = !semverGte(clientVersion, cfg.min_version);
    res.json({
      success: true,
      data: {
        platform,
        client_version: clientVersion,
        min_version: cfg.min_version,
        latest_version: cfg.latest_version,
        force_update: !!cfg.force_update || blocked,
        store_url: cfg.store_url,
        release_notes: cfg.release_notes,
        up_to_date: upToDate,
        blocked,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
