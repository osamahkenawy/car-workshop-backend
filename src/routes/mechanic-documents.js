/**
 * Mechanic Documents API (M1)  +  Min-version config (DM11)
 *
 * Ported from driver-documents.js (driver license/registration docs) to the
 * car-workshop domain: mechanic certifications/licenses (e.g. trade
 * certification, safety certification) with expiry tracking. The upload +
 * expiry-check structure is unchanged — only the vocabulary and table name
 * (driver_documents -> mechanic_documents) were renamed.
 *
 * Mounted from index.js:
 *   app.use('/api/mechanic-documents',  …  mechanicDocsRoutes);
 *   app.use('/api/mechanic-app/config', …  mechanicAppConfigRoutes);
 *
 * Storage: uses the same /uploads/mechanic-docs folder as other media.
 */
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { query, execute } from '../lib/database.js';
import { fileSuffix } from '../lib/tokens.js';
import { validateUpload, DOC_KINDS } from '../lib/file-validate.js';

const router = express.Router();

/* ── Upload setup (PDF + image, 8 MB) ───────────────────────── */
const UPLOADS_DIR = path.resolve('uploads');
const DOCS_DIR = path.join(UPLOADS_DIR, 'mechanic-docs');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

const ALLOWED_DOC_EXT  = /\.(jpg|jpeg|png|webp|pdf)$/i;
const ALLOWED_DOC_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${fileSuffix()}${ext}`);
  },
});
const docUpload = multer({
  storage: docStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOC_EXT.test(file.originalname)) return cb(new Error('PDF, JPG, PNG, WEBP only'));
    if (file.mimetype && !ALLOWED_DOC_MIME.has(file.mimetype.toLowerCase())) {
      return cb(new Error('PDF, JPG, PNG, WEBP only'));
    }
    cb(null, true);
  },
});

/* ── Helpers ───────────────────────────────────────────────── */
// Renamed from delivery driver doc types (national_id/license/insurance/registration)
// to workshop mechanic credential types: trade license, safety cert, insurance, ID, other.
const VALID_DOC_TYPES   = ['national_id', 'trade_license', 'safety_certification', 'insurance', 'other'];
const VALID_DOC_STATUS  = ['pending', 'approved', 'rejected'];

async function assertMechanicInWorkshop(mechanicId, workshopId) {
  const [m] = await query(
    'SELECT id FROM mechanics WHERE id = ? AND workshop_id = ? LIMIT 1',
    [mechanicId, workshopId]
  );
  return !!m;
}

/* ────────────────────────────────────────────────────────────
   GET /api/mechanic-documents?mechanic_id=&status=&expiring_in_days=
   ──────────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const { mechanic_id, status, doc_type, expiring_in_days } = req.query;
    let where = 'md.workshop_id = ?'; const params = [req.workshopId];
    if (mechanic_id) { where += ' AND md.mechanic_id = ?'; params.push(mechanic_id); }
    if (status && VALID_DOC_STATUS.includes(status)) { where += ' AND md.status = ?'; params.push(status); }
    if (doc_type && VALID_DOC_TYPES.includes(doc_type)) { where += ' AND md.doc_type = ?'; params.push(doc_type); }
    if (expiring_in_days) {
      const days = Math.min(365, Math.max(0, parseInt(expiring_in_days, 10) || 0));
      where += ' AND md.expiry_date IS NOT NULL AND md.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)';
      params.push(days);
    }
    const rows = await query(
      `SELECT md.*, m.full_name AS mechanic_name
         FROM mechanic_documents md
         JOIN mechanics m ON m.id = md.mechanic_id
        WHERE ${where}
        ORDER BY md.expiry_date ASC, md.created_at DESC
        LIMIT 500`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[MechanicDocs] list error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/mechanic-documents  (multipart: file, mechanic_id, doc_type, expiry_date?)
   ──────────────────────────────────────────────────────────── */
router.post('/', docUpload.single('file'), validateUpload(DOC_KINDS), async (req, res) => {
  try {
    const { mechanic_id, doc_type, expiry_date, notes } = req.body;
    if (!mechanic_id || !doc_type) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'mechanic_id and doc_type required' });
    }
    if (!VALID_DOC_TYPES.includes(doc_type)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'Invalid doc_type' });
    }
    if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
    if (!await assertMechanicInWorkshop(mechanic_id, req.workshopId)) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ success: false, message: 'Mechanic not found' });
    }
    const fileUrl = `/uploads/mechanic-docs/${req.file.filename}`;
    const result = await execute(
      `INSERT INTO mechanic_documents
        (workshop_id, mechanic_id, doc_type, file_url, file_name, expiry_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, mechanic_id, doc_type, fileUrl, req.file.originalname,
       expiry_date || null, notes || null]
    );
    const [doc] = await query('SELECT * FROM mechanic_documents WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    console.error('[MechanicDocs] upload error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   PATCH /api/mechanic-documents/:id   (admin review: approve/reject + notes)
   ──────────────────────────────────────────────────────────── */
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes, expiry_date } = req.body;
    if (status && !VALID_DOC_STATUS.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const sets = []; const params = [];
    if (status) { sets.push('status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()'); params.push(status, req.user?.id || null); }
    if (notes !== undefined)       { sets.push('notes = ?');       params.push(notes); }
    if (expiry_date !== undefined) { sets.push('expiry_date = ?'); params.push(expiry_date || null); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    params.push(req.params.id, req.workshopId);
    const result = await execute(
      `UPDATE mechanic_documents SET ${sets.join(', ')} WHERE id = ? AND workshop_id = ?`,
      params
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Document not found' });
    const [doc] = await query('SELECT * FROM mechanic_documents WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[MechanicDocs] patch error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ────────────────────────────────────────────────────────────
   DELETE /api/mechanic-documents/:id
   ──────────────────────────────────────────────────────────── */
router.delete('/:id', async (req, res) => {
  try {
    const [doc] = await query(
      'SELECT file_url FROM mechanic_documents WHERE id = ? AND workshop_id = ? LIMIT 1',
      [req.params.id, req.workshopId]
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
    await execute('DELETE FROM mechanic_documents WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (doc.file_url?.startsWith('/uploads/mechanic-docs/')) {
      const local = path.resolve('.' + doc.file_url);
      fs.unlink(local, () => {});
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[MechanicDocs] delete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
