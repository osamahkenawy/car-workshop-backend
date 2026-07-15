/**
 * Public API Routes — Landing Page
 * No authentication required. Rate-limited at mount point.
 *
 * GET  /api/public/pricing      — Active plans for landing page pricing section
 * POST /api/public/contact      — Contact form submission
 * POST /api/public/start-trial  — Free trial signup (auto-provisions workshop)
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding, getLogoCidAttachment } from '../lib/email.js';
import { config } from '../config.js';

const router = Router();

/* ═══════════════════════════════════════════
   GET /pricing — Landing page pricing engine
   ═══════════════════════════════════════════ */
router.get('/pricing', async (_req, res) => {
  try {
    const plans = await query(`
      SELECT
        id, name, slug, description,
        price_aed        AS base,
        base_stops        AS baseStops,
        extra_rate_aed    AS extraRate,
        is_featured       AS featured,
        badge_key         AS badgeKey,
        landing_features  AS featureKeys,
        features,
        max_mechanics     AS maxMechanics,
        max_users         AS maxUsers,
        max_work_orders_per_month AS maxWorkOrdersPerMonth,
        sort_order
      FROM plans
      WHERE is_active = 1 AND landing_visible = 1
      ORDER BY sort_order ASC
    `);

    const parsed = (plans || []).map(p => {
      let featureKeys = p.featureKeys;
      if (typeof featureKeys === 'string') {
        try { featureKeys = JSON.parse(featureKeys); } catch { featureKeys = []; }
      }
      let features = p.features;
      if (typeof features === 'string') {
        try { features = JSON.parse(features); } catch { features = []; }
      }
      return {
        id: p.id,
        key: p.slug,
        name: p.name,
        description: p.description,
        base: Number(p.base),
        yearlyPrice: Math.round(Number(p.base) * 12 * 0.85),
        baseStops: p.baseStops,
        extraRate: Number(p.extraRate),
        featured: !!p.featured,
        badgeKey: p.badgeKey || null,
        featureKeys: featureKeys || [],
        features: features || [],
        limits: {
          maxMechanics: p.maxMechanics,
          maxUsers: p.maxUsers,
          maxWorkOrdersPerMonth: p.maxWorkOrdersPerMonth,
        },
      };
    });

    res.json({ success: true, plans: parsed });
  } catch (err) {
    console.error('[Public API] Pricing fetch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load pricing plans' });
  }
});

/* ═══════════════════════════════════════════
   POST /contact — Contact form submission
   ═══════════════════════════════════════════ */
router.post('/contact', async (req, res) => {
  try {
    const { firstName, lastName, email, subject, message, phone } = req.body;
    const normalizedEmail = String(email || '').trim();
    const normalizedPhone = String(phone || '').trim();

    if (!firstName || (!normalizedEmail && !normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: 'First name and at least one contact method (email or phone) are required'
      });
    }

    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    // Validate email only when it is provided
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (normalizedEmail && !emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    // Prevent duplicate submissions (same message + same email or phone within 5 minutes)
    const recentDup = await query(
      `SELECT id
         FROM landing_contacts
        WHERE message = ?
          AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
          AND ((? <> '' AND email = ?) OR (? <> '' AND phone = ?))
        LIMIT 1`,
      [message, normalizedEmail, normalizedEmail, normalizedPhone, normalizedPhone]
    );
    if (recentDup?.length) {
      return res.status(429).json({ success: false, message: 'You already submitted this message recently. Please wait a few minutes.' });
    }

    const result = await execute(
      `INSERT INTO landing_contacts (first_name, last_name, email, phone, subject, message, ip_address, user_agent, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'landing_page')`,
      [firstName, lastName || null, normalizedEmail || '', normalizedPhone || null, subject || null, message, ip, ua]
    );

    // Send confirmation email when an email address is provided (non-blocking)
    if (normalizedEmail) {
      sendContactConfirmationEmail({ firstName, lastName, email: normalizedEmail, subject }).catch(err =>
        console.error('[Public API] Confirmation email failed:', err.message)
      );
    }

    res.status(201).json({
      success: true,
      message: 'Your message has been received. We will get back to you shortly.',
      id: result.insertId,
    });
  } catch (err) {
    console.error('[Public API] Contact form error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit contact form' });
  }
});

/* ═══════════════════════════════════════════
   POST /start-trial — Free trial signup
   Auto-provisions: Workshop → Admin User → Subscription → Welcome Email
   ═══════════════════════════════════════════ */
router.post('/start-trial', async (req, res) => {
  try {
    const { firstName, lastName, email, companyName, phone, planSlug, estimatedDeliveries, password } = req.body;

    if (!firstName || !email) {
      return res.status(400).json({ success: false, message: 'First name and email are required' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    // Check if email already has a workshop
    const existingUser = await query('SELECT u.id, t.name FROM users u JOIN workshops t ON u.workshop_id = t.id WHERE u.email = ? LIMIT 1', [email]);
    if (existingUser?.length) {
      return res.status(409).json({ success: false, message: 'This email already has an active account. Please log in.' });
    }

    // ── Build unique slug ──
    const baseName = (companyName || `${firstName}'s Company`).trim();
    let slug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) slug = firstName.toLowerCase();
    const existingSlug = await query('SELECT id FROM workshops WHERE slug = ?', [slug]);
    if (existingSlug?.length) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // ── Trial settings ──
    const TRIAL_DAYS = 7;
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

    // ── 1. Create Workshop ──
    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, subdomain, email, phone, status, trial_ends_at, settings, industry)
       VALUES (?, ?, ?, ?, ?, 'trial', ?, '{}', ?)`,
      [baseName, slug, slug, email, phone || null, fmt(trialEnd), null]
    );
    const workshopId = workshopResult.insertId;

    // ── 2. Create Admin User ──
    const adminPassword = password || 'Admin@123';
    const hash = await bcrypt.hash(adminPassword, 10);
    const adminUsername = email; // use email as username for simplicity
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, password, role, is_active, is_owner)
       VALUES (?, ?, ?, ?, ?, 'admin', TRUE, TRUE)`,
      [workshopId, fullName || 'Admin', adminUsername, email, hash]
    );

    // ── 3. Create Trial Subscription ──
    // Trial subscription: 3 users max during trial period (matches PLAN_LIMITS.trial)
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, trial_start, trial_end, trial_days, features, started_at)
       VALUES (?, 'trial', 'trialing', 3, ?, ?, ?, ?, NOW())`,
      [workshopId, fmt(now), fmt(trialEnd), TRIAL_DAYS, JSON.stringify({})]
    );

    // ── 4. Log trial request ──
    try {
      await execute(
        `INSERT INTO trial_requests (first_name, last_name, email, company_name, phone, plan_slug,
         estimated_deliveries, ip_address, user_agent, source, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'landing_page', 'activated')`,
        [firstName, lastName || null, email, companyName || null, phone || null,
         planSlug || 'trial', estimatedDeliveries || 0, ip, ua]
      );
    } catch { /* trial_requests may not exist — ignore */ }

    // ── 5. Send Welcome Email ──
    const frontendUrl = process.env.FRONTEND_URL || config.frontendUrl || 'https://workshop.traseallo.com';
    const loginUrl = `${frontendUrl}/login`;
    sendTrialWelcomeEmail({
      to: email,
      firstName,
      companyName: baseName,
      username: adminUsername,
      password: adminPassword,
      trialEnd,
      trialDays: TRIAL_DAYS,
      loginUrl,
      workshopId,
    }).catch(err => console.error('[Trial] Welcome email failed:', err.message));

    // ── 6. Notify platform team ──
    sendEmail({
      to: 'info@traseallo.com',
      subject: `🆕 New Trial Signup — ${baseName}`,
      html: buildEmailTemplate({}, `
        <h2>New Trial Registration</h2>
        <p><strong>Company:</strong> ${baseName}</p>
        <p><strong>Name:</strong> ${fullName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone || '—'}</p>
        <p><strong>Trial ends:</strong> ${trialEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <p><strong>IP:</strong> ${ip}</p>
      `),
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Your free trial has been activated! Check your email for login details.',
      workshop_id: workshopId,
      slug,
      login_url: loginUrl,
    });
  } catch (err) {
    console.error('[Public API] Trial signup error:', err.message);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'This email or company name is already registered.' });
    }
    res.status(500).json({ success: false, message: 'Failed to create trial account. Please try again.' });
  }
});

/* ═══════════════════════════════════════════
   Helper: Send confirmation email to contact
   ═══════════════════════════════════════════ */
async function sendContactConfirmationEmail({ firstName, lastName, email, subject }) {
  const name = [firstName, lastName].filter(Boolean).join(' ');

  // CID-embedded logo (works without external URL)
  const cidLogo = getLogoCidAttachment();
  const trasealloLogoUrl = cidLogo.src;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Traseallo Logo -->
        <tr>
          <td align="center" style="padding:0 0 28px;">
            <table cellpadding="0" cellspacing="0" style="display:inline-table;">
              <tr>
                <td style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;
                           box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:14px 28px;text-align:center;">
                  <img src="${trasealloLogoUrl}" alt="Traseallo" height="44"
                       style="display:block;height:44px;width:auto;max-width:220px;" />
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Main content card -->
        <tr>
          <td style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;
                     box-shadow:0 4px 24px rgba(0,0,0,0.06);overflow:hidden;">
            <!-- Accent bar -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="height:6px;font-size:0;line-height:0;" bgcolor="#1B3A5C">&nbsp;</td></tr>
            </table>
            <!-- Body -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:40px 40px 32px;">
                  <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;background:#eff6ff;border-radius:50%;padding:16px;">
                      <span style="font-size:32px;">&#128172;</span>
                    </div>
                  </div>
                  <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Thank You for Reaching Out!</h1>
                  <p style="margin:0 0 24px;font-size:15px;color:#6b7280;text-align:center;">Hi ${firstName}, we received your message.</p>

                  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <table cellpadding="0" cellspacing="0" style="width:100%;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Name</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${name}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Email</td><td style="padding:4px 0;font-size:14px;color:#111827;font-family:'Courier New',monospace;">${email}</td></tr>
                      ${subject ? `<tr><td style="padding:4px 0;font-size:14px;color:#475569;">Subject</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${subject}</td></tr>` : ''}
                    </table>
                  </div>

                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 16px;">
                    We've received your message${subject ? ` regarding <strong>&ldquo;${subject}&rdquo;</strong>` : ''} and our team will get back to you shortly.
                  </p>
                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 24px;">
                    In the meantime, feel free to explore our platform or reply to this email if you have additional questions.
                  </p>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
                    <tr><td align="center">
                      <table cellpadding="0" cellspacing="0" style="border-radius:10px;" bgcolor="#1B3A5C">
                        <tr>
                          <td align="center" style="padding:14px 44px;border-radius:10px;" bgcolor="#1B3A5C">
                            <a href="https://traseallo.com" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
                              Explore Traseallo &#8594;
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>

                  <p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">
                    Need help? Contact us at <a href="mailto:info@traseallo.com" style="color:#f97316;">info@traseallo.com</a>
                    or WhatsApp <a href="https://wa.me/971503920037" style="color:#f97316;">+971 50 392 0037</a>
                  </p>
                </td>
              </tr>
            </table>
            <!-- Footer: copyright -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">
                    ${new Date().getFullYear()} &copy; Trasealla Solutions. All rights reserved.
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

  return sendEmail({
    to: email,
    subject: 'We received your message — traseallo',
    html,
    fromName: 'traseallo',
    attachments: [cidLogo.attachment],
  });
}

/* ═══════════════════════════════════════════════════════════════
   POST /signup — Free trial signup (2-step form)
   Creates: Workshop → Admin User → Subscription → Verification Token
   Sends: Verification email only (welcome email sent after verification)
   ═══════════════════════════════════════════════════════════════ */
router.post('/signup', async (req, res) => {
  try {
    const {
      // Step 1 — Company Info
      company_name,
      company_email,
      company_phone,
      // Step 2 — Admin Info
      admin_full_name,
      admin_email,
      admin_phone,
      password,
    } = req.body;

    // ── Required field validation ──
    if (!company_name?.trim()) {
      return res.status(400).json({ success: false, field: 'company_name', message: 'Company name is required.' });
    }
    if (!company_email?.trim()) {
      return res.status(400).json({ success: false, field: 'company_email', message: 'Company email is required.' });
    }
    if (!company_phone?.trim()) {
      return res.status(400).json({ success: false, field: 'company_phone', message: 'Company phone is required.' });
    }
    if (!admin_full_name?.trim()) {
      return res.status(400).json({ success: false, field: 'admin_full_name', message: 'Admin full name is required.' });
    }
    if (!admin_email?.trim()) {
      return res.status(400).json({ success: false, field: 'admin_email', message: 'Admin email is required.' });
    }
    if (!password) {
      return res.status(400).json({ success: false, field: 'password', message: 'Password is required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, field: 'password', message: 'Password must be at least 8 characters long.' });
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ success: false, field: 'password', message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.' });
    }

    // ── Email format validation ──
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(company_email.trim())) {
      return res.status(400).json({ success: false, field: 'company_email', message: 'Invalid company email address.' });
    }
    if (!emailRegex.test(admin_email.trim())) {
      return res.status(400).json({ success: false, field: 'admin_email', message: 'Invalid admin email address.' });
    }

    const trimmedCompanyName  = company_name.trim();
    const trimmedCompanyEmail = company_email.trim().toLowerCase();
    const trimmedAdminEmail   = admin_email.trim().toLowerCase();

    // ── Uniqueness checks ──
    // 1. Company name
    const existingWorkshopName = await query('SELECT id FROM workshops WHERE LOWER(name) = LOWER(?) LIMIT 1', [trimmedCompanyName]);
    if (existingWorkshopName?.length) {
      return res.status(409).json({ success: false, field: 'company_name', message: 'This company is already registered in Traseallo.' });
    }

    // 2. Company email
    const existingWorkshopEmail = await query('SELECT id FROM workshops WHERE LOWER(email) = ? LIMIT 1', [trimmedCompanyEmail]);
    if (existingWorkshopEmail?.length) {
      return res.status(409).json({ success: false, field: 'company_email', message: 'This company email is already in use.' });
    }

    // 3. Admin email (check both email and username columns)
    const existingAdminEmail = await query('SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? LIMIT 1', [trimmedAdminEmail, trimmedAdminEmail]);
    if (existingAdminEmail?.length) {
      return res.status(409).json({ success: false, field: 'admin_email', message: 'This admin email is already in use.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    // ── Build unique slug ──
    let slug = trimmedCompanyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!slug) slug = 'company';
    const existingSlug = await query('SELECT id FROM workshops WHERE slug = ?', [slug]);
    if (existingSlug?.length) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    // ── Trial settings ──
    const TRIAL_DAYS = 7;
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

    // ── 1. Create Workshop (pending_verification) ──
    const workshopResult = await execute(
      `INSERT INTO workshops (name, slug, subdomain, email, phone, status, trial_ends_at, settings, industry)
       VALUES (?, ?, ?, ?, ?, 'pending_verification', ?, '{}', NULL)`,
      [trimmedCompanyName, slug, slug, trimmedCompanyEmail, company_phone?.trim() || null, fmt(trialEnd)]
    );
    const workshopId = workshopResult.insertId;

    // ── 2. Create Admin User (email NOT verified) ──
    const hash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

    await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, is_active, is_owner, email_verified, email_verification_token, email_verification_expires)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', TRUE, TRUE, 0, ?, ?)`,
      [workshopId, admin_full_name.trim(), trimmedAdminEmail, trimmedAdminEmail, admin_phone?.trim() || null, hash, verificationToken, fmt(tokenExpiry)]
    );

    // ── 3. Create Trial Subscription ──
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, trial_start, trial_end, trial_days, features, started_at)
       VALUES (?, 'trial', 'trialing', 3, ?, ?, ?, ?, NOW())`,
      [workshopId, fmt(now), fmt(trialEnd), TRIAL_DAYS, JSON.stringify({})]
    );

    // ── 4. Seed default roles for the new workshop ──
    try {
      const adminModules = JSON.stringify(['dashboard','work-orders','job-assignment','mechanics','customers','vehicles','service-status','bulk-import','warranty-claims','wallet','invoices','cash-payment','reports','performance','service-bays','pricing','notifications','settings','integrations']);
      const dispatcherModules = JSON.stringify(['dashboard','work-orders','job-assignment','mechanics','customers','vehicles','service-status','bulk-import','warranty-claims','wallet','invoices','cash-payment','reports','performance']);
      const mechanicModules = JSON.stringify(['mechanic-dashboard','my-jobs','mechanic-scan','barcode']);
      await execute(
        `INSERT INTO roles (workshop_id, name, name_ar, slug, modules, is_system) VALUES
         (?, 'Admin', 'مدير', 'admin', ?, 1),
         (?, 'Dispatcher', 'مُرسِل', 'dispatcher', ?, 1),
         (?, 'Mechanic', 'ميكانيكي', 'mechanic', ?, 1),
         (?, 'Customer', 'عميل', 'customer', '[]', 1)`,
        [workshopId, adminModules, workshopId, dispatcherModules, workshopId, mechanicModules, workshopId]
      );
    } catch (roleErr) { console.error('[Signup] Failed to seed default roles:', roleErr.message); }

    // ── 5. Log trial request ──
    try {
      await execute(
        `INSERT INTO trial_requests (first_name, last_name, email, company_name, phone, plan_slug,
         estimated_deliveries, ip_address, user_agent, source, status)
         VALUES (?, NULL, ?, ?, ?, 'trial', 0, ?, ?, 'signup_page', 'pending_verification')`,
        [admin_full_name.trim(), trimmedAdminEmail, trimmedCompanyName, admin_phone?.trim() || null, ip, ua]
      );
    } catch (trialErr) { console.error('[Signup] Failed to log trial request:', trialErr.message); }

    // ── 6. Send Verification Email ──
    const frontendUrl = process.env.FRONTEND_URL || config.frontendUrl || 'http://localhost:5173';
    const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;
    const loginUrl = `${frontendUrl}/login`;

    sendVerificationEmail({
      to: trimmedAdminEmail,
      adminName: admin_full_name.trim(),
      companyName: trimmedCompanyName,
      verificationUrl,
      tokenExpiry,
    }).catch(err => console.error('[Signup] Verification email failed:', err.message));

    // NOTE: Welcome email is sent AFTER email verification (in /verify-email handler)

    // ── 7. Notify platform team ──
    sendEmail({
      to: 'info@traseallo.com',
      subject: `🆕 New Signup — ${trimmedCompanyName}`,
      html: buildEmailTemplate({}, `
        <h2>New Trial Signup (Self-Service)</h2>
        <p><strong>Company:</strong> ${trimmedCompanyName}</p>
        <p><strong>Company Email:</strong> ${trimmedCompanyEmail}</p>
        <p><strong>Admin:</strong> ${admin_full_name.trim()} (${trimmedAdminEmail})</p>
        <p><strong>Phone:</strong> ${company_phone || '—'}</p>
        <p><strong>Trial ends:</strong> ${trialEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        <p><strong>Status:</strong> Pending email verification</p>
        <p><strong>IP:</strong> ${ip}</p>
      `),
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Your account has been created successfully. Please check your email to verify your account before logging in.',
    });
  } catch (err) {
    console.error('[Public API] Signup error:', err.message);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'This email or company name is already registered.' });
    }
    res.status(500).json({ success: false, message: 'Failed to create account. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET /verify-email?token=xxx — Email verification
   Marks user as verified, workshop → trial (active trial)
   ═══════════════════════════════════════════════════════════════ */
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Verification token is required.' });
    }

    // Find user with this token
    const users = await query(
      `SELECT u.id, u.workshop_id, u.email, u.full_name, u.email_verified, u.email_verification_expires
       FROM users u
       WHERE u.email_verification_token = ? LIMIT 1`,
      [token]
    );

    if (!users?.length) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification link.' });
    }

    const user = users[0];

    // Already verified
    if (user.email_verified) {
      return res.json({ success: true, message: 'Email already verified. You can log in.', already_verified: true });
    }

    // Check expiry
    if (user.email_verification_expires && new Date(user.email_verification_expires) < new Date()) {
      return res.status(400).json({ success: false, message: 'Verification link has expired. Please request a new one.' });
    }

    // ── Mark user as verified (keep token so re-clicks show "already verified" instead of error) ──
    await execute(
      `UPDATE users SET email_verified = 1 WHERE id = ?`,
      [user.id]
    );

    // ── Update workshop status from pending_verification → trial ──
    await execute(
      `UPDATE workshops SET status = 'trial' WHERE id = ? AND status = 'pending_verification'`,
      [user.workshop_id]
    );

    // ── Update trial_requests status ──
    try {
      await execute(
        `UPDATE trial_requests SET status = 'activated' WHERE email = ? AND status = 'pending_verification'`,
        [user.email]
      );
    } catch { /* ignore */ }

    // ── Send Welcome / Trial Started email now that email is verified ──
    const workshopRows = await query('SELECT name, trial_ends_at FROM workshops WHERE id = ?', [user.workshop_id]);
    const workshopName = workshopRows?.[0]?.name || 'Your Company';
    const trialEndsAt = workshopRows?.[0]?.trial_ends_at ? new Date(workshopRows[0].trial_ends_at) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const frontendUrl = process.env.FRONTEND_URL || config.frontendUrl || 'http://localhost:5173';

    sendSignupWelcomeEmail({
      to: user.email,
      adminName: user.full_name,
      companyName: workshopName,
      trialDays: 7,
      trialEnd: trialEndsAt,
      loginUrl: `${frontendUrl}/login`,
    }).catch(err => console.error('[Verify] Welcome email failed:', err.message));

    res.json({ success: true, message: 'Email verified successfully. You can now log in to Traseallo.' });
  } catch (err) {
    console.error('[Public API] Email verification error:', err.message);
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /resend-verification — Resend verification email
   ═══════════════════════════════════════════════════════════════ */
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const users = await query(
      `SELECT u.id, u.workshop_id, u.full_name, u.email, u.email_verified
       FROM users u
       WHERE LOWER(u.email) = ? AND u.is_owner = 1 LIMIT 1`,
      [trimmedEmail]
    );

    if (!users?.length) {
      // Don't reveal if email exists — just show generic success
      return res.json({ success: true, message: 'If that email is registered, a verification link has been sent.' });
    }

    const user = users[0];
    if (user.email_verified) {
      return res.json({ success: true, message: 'Email is already verified. You can log in.' });
    }

    // Generate new token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');

    await execute(
      `UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?`,
      [verificationToken, fmt(tokenExpiry), user.id]
    );

    // Get company name
    const workshopRows = await query('SELECT name FROM workshops WHERE id = ?', [user.workshop_id]);
    const companyName = workshopRows?.[0]?.name || 'Your Company';

    const frontendUrl = process.env.FRONTEND_URL || config.frontendUrl || 'http://localhost:5173';
    const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

    sendVerificationEmail({
      to: user.email,
      adminName: user.full_name,
      companyName,
      verificationUrl,
      tokenExpiry,
    }).catch(err => console.error('[Signup] Resend verification email failed:', err.message));

    res.json({ success: true, message: 'If that email is registered, a verification link has been sent.' });
  } catch (err) {
    console.error('[Public API] Resend verification error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to resend verification. Please try again.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /check-availability — Check if company/email is available
   Used for real-time validation in the signup form
   ═══════════════════════════════════════════════════════════════ */
router.post('/check-availability', async (req, res) => {
  try {
    const { company_name, company_email, admin_email } = req.body;
    const errors = {};

    if (company_name?.trim()) {
      const existing = await query('SELECT id FROM workshops WHERE LOWER(name) = LOWER(?) LIMIT 1', [company_name.trim()]);
      if (existing?.length) errors.company_name = 'This company is already registered in Traseallo.';
    }

    if (company_email?.trim()) {
      const existing = await query('SELECT id FROM workshops WHERE LOWER(email) = ? LIMIT 1', [company_email.trim().toLowerCase()]);
      if (existing?.length) errors.company_email = 'This company email is already in use.';
    }

    if (admin_email?.trim()) {
      const existing = await query('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [admin_email.trim().toLowerCase()]);
      if (existing?.length) errors.admin_email = 'This admin email is already in use.';
    }

    res.json({ success: true, errors, available: Object.keys(errors).length === 0 });
  } catch (err) {
    console.error('[Public API] Check availability error:', err.message);
    res.status(500).json({ success: false, message: 'Availability check failed.' });
  }
});

export default router;

/* ═══════════════════════════════════════════
   Helper: Send trial welcome email with login details
   ═══════════════════════════════════════════ */
async function sendTrialWelcomeEmail({ to, firstName, companyName, username, password, trialEnd, trialDays, loginUrl, workshopId }) {
  const cidLogo = getLogoCidAttachment();
  const trasealloLogoUrl = cidLogo.src;
  const trialEndFormatted = trialEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });

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
                  <img src="${trasealloLogoUrl}" alt="Traseallo" height="44"
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
                  <h1 style="margin:0 0 4px;font-size:24px;font-weight:700;color:#111827;">Welcome to Traseallo! &#128640;</h1>
                  <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Your ${trialDays}-day free trial has started</p>

                  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#1e40af;font-weight:600;">&#127881; TRIAL DETAILS</p>
                    <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Company</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${companyName}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Trial Period</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${trialDays} days</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Expires On</td><td style="padding:4px 0;font-size:14px;color:#dc2626;font-weight:700;">${trialEndFormatted}</td></tr>
                    </table>
                  </div>

                  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#475569;font-weight:600;">&#128274; YOUR LOGIN CREDENTIALS</p>
                    <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Username</td><td style="padding:4px 0;font-size:14px;color:#111827;font-family:'Courier New',monospace;font-weight:600;">${username}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Password</td><td style="padding:4px 0;font-size:14px;color:#111827;font-family:'Courier New',monospace;font-weight:600;">${password}</td></tr>
                    </table>
                    <p style="margin:12px 0 0;font-size:12px;color:#6b7280;">&#9888;&#65039; Change your password after logging in for security.</p>
                  </div>

                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 24px;">
                    During your trial, you have <strong>full access</strong> to all features — create work orders, add mechanics,
                    manage job assignment, use live map, generate reports, and more.
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
                    Need help? Contact us at <a href="mailto:support@traseallo.com" style="color:#f97316;">support@traseallo.com</a>
                    or WhatsApp <a href="https://wa.me/971503920037" style="color:#f97316;">+971 50 392 0037</a>
                  </p>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">
                    ${new Date().getFullYear()} &copy; Trasealla Solutions. All rights reserved.
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

  return sendEmail({
    to,
    subject: `Welcome to Traseallo – Your ${trialDays}-Day Free Trial Has Started`,
    html,
    fromName: 'Traseallo',
    attachments: [cidLogo.attachment],
  });
}

/* ═══════════════════════════════════════════
   Helper: Send email verification link
   ═══════════════════════════════════════════ */
async function sendVerificationEmail({ to, adminName, companyName, verificationUrl, tokenExpiry }) {
  const cidLogo = getLogoCidAttachment();
  const trasealloLogoUrl = cidLogo.src;
  const expiryFormatted = tokenExpiry.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

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
                  <img src="${trasealloLogoUrl}" alt="Traseallo" height="44"
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
              <tr><td style="height:6px;font-size:0;line-height:0;" bgcolor="#1B3A5C">&nbsp;</td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:40px 40px 32px;">
                  <div style="text-align:center;margin-bottom:24px;">
                    <div style="display:inline-block;background:#eff6ff;border-radius:50%;padding:16px;">
                      <span style="font-size:32px;">&#9993;</span>
                    </div>
                  </div>
                  <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Verify Your Email Address</h1>
                  <p style="margin:0 0 24px;font-size:15px;color:#6b7280;text-align:center;">Hi ${adminName}, please verify your email to activate your account.</p>

                  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <table cellpadding="0" cellspacing="0" style="width:100%;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Company</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${companyName}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Admin</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${adminName}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Email</td><td style="padding:4px 0;font-size:14px;color:#111827;font-family:'Courier New',monospace;">${to}</td></tr>
                    </table>
                  </div>

                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 24px;text-align:center;">
                    Click the button below to verify your email and start using Traseallo.
                  </p>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                    <tr><td align="center">
                      <table cellpadding="0" cellspacing="0" style="border-radius:10px;" bgcolor="#1B3A5C">
                        <tr>
                          <td align="center" style="padding:15px 44px;border-radius:10px;" bgcolor="#1B3A5C">
                            <a href="${verificationUrl}" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
                              &#10003;&nbsp; Verify My Email
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                    <tr>
                      <td style="background:#f8fafc;border:1px solid #e9edf2;border-radius:10px;padding:14px 18px;">
                        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;">Or copy this link</p>
                        <p style="margin:0;font-size:12px;color:#475569;word-break:break-all;font-family:'Courier New',monospace;">${verificationUrl}</p>
                      </td>
                    </tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;">
                        <p style="margin:0;font-size:13px;color:#92400e;">
                          &#9203; This verification link expires in <strong>24 hours</strong>.
                        </p>
                      </td>
                    </tr>
                  </table>

                  <p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">
                    If you did not sign up for Traseallo, you can safely ignore this email.
                  </p>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">
                    ${new Date().getFullYear()} &copy; Trasealla Solutions. All rights reserved.
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

  return sendEmail({
    to,
    subject: 'Verify Your Email Address — Traseallo',
    html,
    fromName: 'Traseallo',
    attachments: [cidLogo.attachment],
  });
}

/* ═══════════════════════════════════════════
   Helper: Send signup welcome email (no credentials — verification required first)
   ═══════════════════════════════════════════ */
async function sendSignupWelcomeEmail({ to, adminName, companyName, trialDays, trialEnd, loginUrl }) {
  const cidLogo = getLogoCidAttachment();
  const trasealloLogoUrl = cidLogo.src;
  const trialEndFormatted = trialEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });

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
                  <img src="${trasealloLogoUrl}" alt="Traseallo" height="44"
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
                  <h1 style="margin:0 0 4px;font-size:24px;font-weight:700;color:#111827;">Welcome to Traseallo! &#128640;</h1>
                  <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Your ${trialDays}-day free trial has started</p>

                  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:24px;">
                    <p style="margin:0 0 4px;font-size:13px;color:#1e40af;font-weight:600;">&#127881; TRIAL DETAILS</p>
                    <table cellpadding="0" cellspacing="0" style="width:100%;margin-top:8px;">
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;width:120px;">Company</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${companyName}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Admin</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${adminName}</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Trial Period</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">${trialDays} days</td></tr>
                      <tr><td style="padding:4px 0;font-size:14px;color:#475569;">Expires On</td><td style="padding:4px 0;font-size:14px;color:#dc2626;font-weight:700;">${trialEndFormatted}</td></tr>
                    </table>
                  </div>

                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 16px;">
                    Hi <strong>${adminName}</strong>, your workspace <strong>${companyName}</strong> has been created!
                  </p>
                  <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 16px;">
                    During your trial, you have <strong>full access</strong> to all features — create work orders, add mechanics, manage job assignment,
                    use live map, generate reports, and more.
                  </p>

                  <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:10px;padding:16px;margin-bottom:24px;">
                    <p style="margin:0;font-size:14px;color:#92400e;">
                      <strong>&#9888; Important:</strong> Please verify your email first before logging in.
                      Check your inbox for the verification email.
                    </p>
                  </div>

                  <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
                    <tr><td align="center">
                      <table cellpadding="0" cellspacing="0" style="border-radius:10px;" bgcolor="#1B3A5C">
                        <tr>
                          <td align="center" style="padding:14px 44px;border-radius:10px;" bgcolor="#1B3A5C">
                            <a href="${loginUrl}" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
                              Go to Login Page &#8594;
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td></tr>
                  </table>

                  <p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">
                    Need help? Contact us at <a href="mailto:support@traseallo.com" style="color:#f97316;">support@traseallo.com</a>
                    or WhatsApp <a href="https://wa.me/971503920037" style="color:#f97316;">+971 50 392 0037</a>
                  </p>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">
                    ${new Date().getFullYear()} &copy; Trasealla Solutions. All rights reserved.
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

  return sendEmail({
    to,
    subject: `Welcome to Traseallo — Your ${trialDays}-Day Free Trial Has Started`,
    html,
    fromName: 'Traseallo',
    attachments: [cidLogo.attachment],
  });
}
