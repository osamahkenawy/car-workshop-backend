import express from 'express';
import jwt from 'jsonwebtoken';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';
import { sanitizeRichHtml, stripMarkup } from '../lib/sanitize.js';

/**
 * Ported from delivery-service-backend/src/routes/legal-pages.js.
 *
 * JUDGMENT CALL: this file is fully generic — public terms/privacy page
 * content management with no delivery-specific fields, tables, or logic.
 * The `legal_pages` table is platform-wide (not per-tenant/workshop), so
 * there is no tenant_id/workshop_id to rename anywhere in this file.
 * Ported as-is, only updating comments/wording for the car-workshop domain.
 */

const adminRouter = express.Router();
const publicRouter = express.Router();

// ──────────────────────────────────────────────────────────────
//  TABLE SETUP (idempotent)
// ──────────────────────────────────────────────────────────────
async function ensureLegalPagesTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS legal_pages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(50) NOT NULL UNIQUE,
      title_en VARCHAR(255) NOT NULL DEFAULT '',
      title_ar VARCHAR(255) NOT NULL DEFAULT '',
      content_en LONGTEXT,
      content_ar LONGTEXT,
      is_published BOOLEAN DEFAULT FALSE,
      updated_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_published (is_published)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed the two default pages if they don't exist
  const existing = await query('SELECT COUNT(*) as c FROM legal_pages');
  if ((existing[0]?.c || 0) === 0) {
    await execute(
      `INSERT IGNORE INTO legal_pages (slug, title_en, title_ar, content_en, content_ar, is_published) VALUES
       ('privacy-policy', 'Privacy Policy', 'سياسة الخصوصية', '<h2>Privacy Policy</h2><p>Edit this content from the Super Admin panel.</p>', '<h2>سياسة الخصوصية</h2><p>قم بتعديل هذا المحتوى من لوحة المشرف.</p>', 0),
       ('terms-and-conditions', 'Terms and Conditions', 'الشروط والأحكام', '<h2>Terms and Conditions</h2><p>Edit this content from the Super Admin panel.</p>', '<h2>الشروط والأحكام</h2><p>قم بتعديل هذا المحتوى من لوحة المشرف.</p>', 0)`
    );
  }
}

ensureLegalPagesTable().catch(err => console.error('Legal pages table init error:', err));

// ──────────────────────────────────────────────────────────────
//  SUPER ADMIN AUTH MIDDLEWARE
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
  } catch {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

adminRouter.use(verifySuperAdmin);

// ──────────────────────────────────────────────────────────────
//  ADMIN ROUTES — GET all legal pages
// ──────────────────────────────────────────────────────────────
adminRouter.get('/legal-pages', async (_req, res) => {
  try {
    const pages = await query('SELECT * FROM legal_pages ORDER BY slug ASC');
    res.json({ success: true, pages });
  } catch (err) {
    console.error('[Legal Pages] List error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch legal pages.' });
  }
});

// ──────────────────────────────────────────────────────────────
//  ADMIN ROUTES — GET single legal page by slug
// ──────────────────────────────────────────────────────────────
adminRouter.get('/legal-pages/:slug', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM legal_pages WHERE slug = ?', [req.params.slug]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Page not found.' });
    res.json({ success: true, page: rows[0] });
  } catch (err) {
    console.error('[Legal Pages] Get error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch legal page.' });
  }
});

// ──────────────────────────────────────────────────────────────
//  ADMIN ROUTES — UPDATE legal page
// ──────────────────────────────────────────────────────────────
adminRouter.put('/legal-pages/:slug', async (req, res) => {
  try {
    const raw = req.body;
    // Legal page content is deliberately HTML and is served publicly to the
    // mobile app, so it is sanitised against a formatting allow-list on write:
    // headings/lists/links survive, script/style/handlers/javascript: do not.
    const title_en = stripMarkup(raw.title_en, 255);
    const title_ar = stripMarkup(raw.title_ar, 255);
    const content_en = sanitizeRichHtml(raw.content_en);
    const content_ar = sanitizeRichHtml(raw.content_ar);
    const is_published = raw.is_published;
    const rows = await query('SELECT id FROM legal_pages WHERE slug = ?', [req.params.slug]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'Page not found.' });

    await execute(
      `UPDATE legal_pages SET title_en = ?, title_ar = ?, content_en = ?, content_ar = ?, is_published = ?, updated_by = ? WHERE slug = ?`,
      [title_en, title_ar, content_en, content_ar, is_published ? 1 : 0, req.superAdmin.id, req.params.slug]
    );

    res.json({ success: true, message: 'Legal page updated successfully.' });
  } catch (err) {
    console.error('[Legal Pages] Update error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update legal page.' });
  }
});

// ──────────────────────────────────────────────────────────────
//  PUBLIC ROUTES — Mobile app fetches published legal pages
// ──────────────────────────────────────────────────────────────
publicRouter.get('/legal/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const lang = req.query.lang === 'ar' ? 'ar' : 'en';

    const rows = await query(
      'SELECT slug, title_en, title_ar, content_en, content_ar, updated_at FROM legal_pages WHERE slug = ? AND is_published = 1',
      [slug]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Page not found or not published.' });

    const page = rows[0];
    res.json({
      success: true,
      page: {
        slug: page.slug,
        title: lang === 'ar' ? page.title_ar : page.title_en,
        content: lang === 'ar' ? page.content_ar : page.content_en,
        updated_at: page.updated_at,
      },
    });
  } catch (err) {
    console.error('[Legal Pages] Public fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch legal page.' });
  }
});

// Also provide a list of all published legal pages (for mobile app settings screen)
publicRouter.get('/legal', async (_req, res) => {
  try {
    const lang = _req.query.lang === 'ar' ? 'ar' : 'en';
    const rows = await query(
      'SELECT slug, title_en, title_ar, updated_at FROM legal_pages WHERE is_published = 1 ORDER BY slug ASC'
    );
    const pages = rows.map(p => ({
      slug: p.slug,
      title: lang === 'ar' ? p.title_ar : p.title_en,
      updated_at: p.updated_at,
    }));
    res.json({ success: true, pages });
  } catch (err) {
    console.error('[Legal Pages] Public list error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch legal pages.' });
  }
});

export { adminRouter as legalAdminRouter, publicRouter as legalPublicRouter };
