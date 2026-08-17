/**
 * Careers API Routes
 *
 * NOTE: This module is domain-agnostic — it manages job openings/applications
 * for the SaaS company's own hiring page, not for the car-workshop tenants
 * themselves. No tenant/workshop scoping applies (job_openings and
 * job_applications are platform-wide, not per-workshop). Ported as-is aside
 * from cosmetic default URL updates.
 *
 * Public (no auth):
 *   GET  /api/public/careers           — List active openings
 *   GET  /api/public/careers/:id       — Single opening detail
 *   POST /api/public/careers/apply     — Submit job application (multipart)
 *
 * Super Admin (JWT required):
 *   GET    /api/super-admin/vacancies              — List all openings + stats
 *   POST   /api/super-admin/vacancies              — Create opening
 *   PUT    /api/super-admin/vacancies/:id          — Update opening
 *   DELETE /api/super-admin/vacancies/:id          — Delete opening
 *   PATCH  /api/super-admin/vacancies/:id/toggle   — Toggle active
 *   GET    /api/super-admin/applications            — List all applications
 *   GET    /api/super-admin/applications/:id        — Single application detail
 *   PATCH  /api/super-admin/applications/:id/status — Update application status
 *   DELETE /api/super-admin/applications/:id        — Delete application
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query, execute } from '../lib/database.js';
import { sendEmail, buildEmailTemplate } from '../lib/email.js';

/* ─── File Upload Config ────────────────────── */
const resumeDir = path.join(process.cwd(), 'uploads', 'resumes');
if (!fs.existsSync(resumeDir)) fs.mkdirSync(resumeDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, resumeDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only PDF, DOC, DOCX files are allowed'));
  },
});

/* ═══════════════════════════════════════════════
   PUBLIC ROUTES
   ═══════════════════════════════════════════════ */
export const publicCareersRouter = Router();

// GET /api/public/careers — Active openings
publicCareersRouter.get('/careers', async (_req, res) => {
  try {
    const openings = await query(
      `SELECT id, title, department, location, employment_type, description, requirements, salary_range, icon, created_at
       FROM job_openings WHERE is_active = 1 ORDER BY sort_order ASC, created_at DESC`
    );
    res.json({ success: true, openings });
  } catch (err) {
    console.error('[Careers] List error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load openings' });
  }
});

// GET /api/public/careers/:id — Single opening
publicCareersRouter.get('/careers/:id', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM job_openings WHERE id = ? AND is_active = 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Position not found' });
    res.json({ success: true, opening: rows[0] });
  } catch (err) {
    console.error('[Careers] Detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load position' });
  }
});

// POST /api/public/careers/apply — Submit application
publicCareersRouter.post('/careers/apply', upload.single('resume'), async (req, res) => {
  try {
    const { opening_id, full_name, email, phone, cover_letter } = req.body;

    if (!opening_id || !full_name || !email) {
      return res.status(400).json({ success: false, message: 'Opening ID, full name, and email are required' });
    }

    // Verify opening exists and is active
    const openings = await query('SELECT id, title, department FROM job_openings WHERE id = ? AND is_active = 1', [opening_id]);
    if (!openings.length) {
      return res.status(404).json({ success: false, message: 'Position not found or no longer accepting applications' });
    }

    const resumeUrl = req.file ? `/uploads/resumes/${req.file.filename}` : null;

    await execute(
      `INSERT INTO job_applications (opening_id, full_name, email, phone, cover_letter, resume_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [opening_id, full_name, email, phone || null, cover_letter || null, resumeUrl]
    );

    // Send confirmation email to applicant
    try {
      const opening = openings[0];
      await sendEmail({
        to: email,
        subject: `Application Received — ${opening.title}`,
        html: buildEmailTemplate({
          logoUrl: `${process.env.BACKEND_URL || 'https://workshop.pioneercarservice.com'}/uploads/logos/email/pioneer-logo.png`,
          logoAlt: 'Pioneer',
          accentColor: '#f97316',
          title: 'Application Received!',
          bodyHtml: `
            <p>Hi <strong>${full_name}</strong>,</p>
            <p>Thank you for applying for the <strong>${opening.title}</strong> position in our <strong>${opening.department}</strong> team.</p>
            <p>We've received your application and our team will review it shortly. If your profile matches our requirements, we'll reach out to schedule next steps.</p>
            <p>In the meantime, feel free to explore our platform at <a href="https://pioneercarservice.com" style="color:#f97316;text-decoration:none;font-weight:600;">pioneercarservice.com</a>.</p>
            <br/>
            <p style="font-size:12px;color:#9ca3af;">Follow us:</p>
            <p style="font-size:13px;">
              <a href="https://www.facebook.com/profile.php?id=61582271193231" style="color:#f97316;text-decoration:none;margin-right:12px;">Facebook</a>
              <a href="https://www.instagram.com/pioneer/" style="color:#f97316;text-decoration:none;margin-right:12px;">Instagram</a>
              <a href="https://www.linkedin.com/company/110608503/" style="color:#f97316;text-decoration:none;">LinkedIn</a>
            </p>
          `,
          footerName: 'Pioneer Solutions',
          isSystem: true,
        }),
      });
    } catch (emailErr) {
      console.error('[Careers] Confirmation email failed:', emailErr.message);
    }

    // Notify super admin
    try {
      const opening = openings[0];
      await sendEmail({
        to: 'hr@pioneercarservice.com',
        subject: `New Application: ${opening.title} — ${full_name}`,
        html: buildEmailTemplate({
          logoUrl: `${process.env.BACKEND_URL || 'https://workshop.pioneercarservice.com'}/uploads/logos/email/pioneer-logo.png`,
          logoAlt: 'Pioneer',
          accentColor: '#f97316',
          title: 'New Job Application',
          bodyHtml: `
            <p>A new application has been submitted:</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px;font-weight:bold;">Position:</td><td style="padding:8px;">${opening.title}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;">Name:</td><td style="padding:8px;">${full_name}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;">${email}</td></tr>
              <tr><td style="padding:8px;font-weight:bold;">Phone:</td><td style="padding:8px;">${phone || '—'}</td></tr>
            </table>
            <p>Log in to the <a href="https://app.pioneercarservice.com/super-admin/vacancies" style="color:#f97316;text-decoration:none;font-weight:600;">Super Admin panel</a> to review.</p>
          `,
          footerName: 'Pioneer Solutions',
          isSystem: true,
        }),
      });
    } catch (_) { /* non-critical */ }

    res.json({ success: true, message: 'Application submitted successfully!' });
  } catch (err) {
    console.error('[Careers] Apply error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit application' });
  }
});

/* ═══════════════════════════════════════════════
   SUPER ADMIN ROUTES (mounted under /api/super-admin)
   ═══════════════════════════════════════════════ */
export const adminCareersRouter = Router();

// GET /vacancies — All openings with application counts
adminCareersRouter.get('/vacancies', async (_req, res) => {
  try {
    const openings = await query(`
      SELECT o.*,
        (SELECT COUNT(*) FROM job_applications WHERE opening_id = o.id) AS total_applications,
        (SELECT COUNT(*) FROM job_applications WHERE opening_id = o.id AND status = 'new') AS new_applications
      FROM job_openings o ORDER BY o.sort_order ASC, o.created_at DESC
    `);

    const stats = await query(`
      SELECT
        (SELECT COUNT(*) FROM job_openings) AS total_openings,
        (SELECT COUNT(*) FROM job_openings WHERE is_active = 1) AS active_openings,
        (SELECT COUNT(*) FROM job_applications) AS total_applications,
        (SELECT COUNT(*) FROM job_applications WHERE status = 'new') AS new_applications,
        (SELECT COUNT(*) FROM job_applications WHERE status = 'shortlisted') AS shortlisted,
        (SELECT COUNT(*) FROM job_applications WHERE status = 'interview') AS interviewing,
        (SELECT COUNT(*) FROM job_applications WHERE status = 'hired') AS hired
    `);

    res.json({ success: true, openings, stats: stats[0] });
  } catch (err) {
    console.error('[Careers Admin] List error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load vacancies' });
  }
});

// POST /vacancies — Create opening
adminCareersRouter.post('/vacancies', async (req, res) => {
  try {
    const { title, department, location, employment_type, description, requirements, salary_range, icon, sort_order } = req.body;
    if (!title || !department || !location) {
      return res.status(400).json({ success: false, message: 'Title, department, and location are required' });
    }
    const result = await execute(
      `INSERT INTO job_openings (title, department, location, employment_type, description, requirements, salary_range, icon, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, department, location, employment_type || 'full-time', description || null, requirements || null, salary_range || null, icon || 'mdi:briefcase-outline', sort_order || 0]
    );
    res.json({ success: true, id: result.insertId, message: 'Vacancy created' });
  } catch (err) {
    console.error('[Careers Admin] Create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create vacancy' });
  }
});

// PUT /vacancies/:id — Update opening
adminCareersRouter.put('/vacancies/:id', async (req, res) => {
  try {
    const { title, department, location, employment_type, description, requirements, salary_range, icon, sort_order, is_active } = req.body;
    await execute(
      `UPDATE job_openings SET title=?, department=?, location=?, employment_type=?, description=?, requirements=?, salary_range=?, icon=?, sort_order=?, is_active=? WHERE id=?`,
      [title, department, location, employment_type, description, requirements, salary_range, icon, sort_order || 0, is_active !== undefined ? is_active : 1, req.params.id]
    );
    res.json({ success: true, message: 'Vacancy updated' });
  } catch (err) {
    console.error('[Careers Admin] Update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update vacancy' });
  }
});

// DELETE /vacancies/:id
adminCareersRouter.delete('/vacancies/:id', async (req, res) => {
  try {
    await execute('DELETE FROM job_openings WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Vacancy deleted' });
  } catch (err) {
    console.error('[Careers Admin] Delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete vacancy' });
  }
});

// PATCH /vacancies/:id/toggle — Toggle active status
adminCareersRouter.patch('/vacancies/:id/toggle', async (req, res) => {
  try {
    await execute('UPDATE job_openings SET is_active = NOT is_active WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Toggled' });
  } catch (err) {
    console.error('[Careers Admin] Toggle error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to toggle vacancy' });
  }
});

// GET /applications — All applications with opening info
adminCareersRouter.get('/applications', async (req, res) => {
  try {
    const { status, opening_id, search, page = 1, limit = 20 } = req.query;
    let sql = `
      SELECT a.*, o.title AS position_title, o.department AS position_department
      FROM job_applications a
      JOIN job_openings o ON a.opening_id = o.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { sql += ' AND a.status = ?'; params.push(status); }
    if (opening_id) { sql += ' AND a.opening_id = ?'; params.push(opening_id); }
    if (search) { sql += ' AND (a.full_name LIKE ? OR a.email LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    sql += ' ORDER BY a.created_at DESC';

    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT ${parseInt(limit)} OFFSET ${offset}`;

    const applications = await query(sql, params);

    // Total count
    let countSql = 'SELECT COUNT(*) AS total FROM job_applications a WHERE 1=1';
    const countParams = [];
    if (status) { countSql += ' AND a.status = ?'; countParams.push(status); }
    if (opening_id) { countSql += ' AND a.opening_id = ?'; countParams.push(opening_id); }
    if (search) { countSql += ' AND (a.full_name LIKE ? OR a.email LIKE ?)'; countParams.push(`%${search}%`, `%${search}%`); }

    const countResult = await query(countSql, countParams);
    const total = countResult[0]?.total || 0;

    res.json({ success: true, applications, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[Careers Admin] Applications list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load applications' });
  }
});

// GET /applications/:id — Single application
adminCareersRouter.get('/applications/:id', async (req, res) => {
  try {
    const rows = await query(
      `SELECT a.*, o.title AS position_title, o.department AS position_department, o.location AS position_location
       FROM job_applications a JOIN job_openings o ON a.opening_id = o.id WHERE a.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Application not found' });
    res.json({ success: true, application: rows[0] });
  } catch (err) {
    console.error('[Careers Admin] Application detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load application' });
  }
});

// PATCH /applications/:id/status — Update status
adminCareersRouter.patch('/applications/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const validStatuses = ['new', 'reviewing', 'shortlisted', 'interview', 'offered', 'hired', 'rejected'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    let sql = 'UPDATE job_applications SET status = ?';
    const params = [status];
    if (notes !== undefined) { sql += ', notes = ?'; params.push(notes); }
    sql += ' WHERE id = ?';
    params.push(req.params.id);
    await execute(sql, params);
    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    console.error('[Careers Admin] Status update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

// DELETE /applications/:id
adminCareersRouter.delete('/applications/:id', async (req, res) => {
  try {
    await execute('DELETE FROM job_applications WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Application deleted' });
  } catch (err) {
    console.error('[Careers Admin] Delete application error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete application' });
  }
});
