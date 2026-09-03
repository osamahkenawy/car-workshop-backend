import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadToS3 } from '../lib/s3.js';
import { validateUpload, IMAGE_KINDS } from '../lib/file-validate.js';

const router = express.Router();
router.use(authMiddleware);

/* ── Upload Directory Setup ─────────────────────────────────── */
const UPLOADS_DIR = path.resolve('uploads');
const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
ensureDir(path.join(UPLOADS_DIR, 'logos'));
ensureDir(path.join(UPLOADS_DIR, 'mechanics'));
ensureDir(path.join(UPLOADS_DIR, 'proofs'));
ensureDir(path.join(UPLOADS_DIR, 'stop-proofs'));
ensureDir(path.join(UPLOADS_DIR, 'signatures'));

/* ── Multer Factories ─────────────────────────────────────── */
const ALLOWED_IMAGE = /\.(jpg|jpeg|png|webp)$/i;
const MB = 1024 * 1024;

function makeStorage(subfolder) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, path.join(UPLOADS_DIR, subfolder)),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });
}

function makeUpload(subfolder, maxSizeMB = 5) {
  return multer({
    storage: makeStorage(subfolder),
    limits: { fileSize: maxSizeMB * MB },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE.test(file.originalname)) {
        return cb(new Error('Only JPG, PNG, WEBP images are allowed'));
      }
      cb(null, true);
    },
  });
}

const logoUpload  = makeUpload('logos', 2);
const mechanicPhoto = makeUpload('mechanics', 5);
const proofPhoto  = makeUpload('proofs', 10);
const stopProofPhoto = makeUpload('stop-proofs', 10);
const signaturePhoto = makeUpload('signatures', 5);

/* ── POST /api/uploads/logo/:variant — company logo upload (colored or white) ── */
router.post('/logo/:variant?', logoUpload.single('file'), validateUpload(IMAGE_KINDS), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const variant = req.params.variant || 'colored'; // 'colored' or 'white'
    const isWhite = variant === 'white';
    const dbColumn = isWhite ? 'logo_url_white' : 'logo_url';
    const settingKey = isWhite ? 'company_logo_white' : 'company_logo';
    const s3Folder = isWhite ? 'logos/white' : 'logos';

    // The local file is kept for serving via express.static
    const localUrl = `/uploads/logos/${req.file.filename}`;

    // Upload to S3 as backup (non-blocking)
    uploadToS3(
      fs.readFileSync(req.file.path), s3Folder, req.file.originalname, req.file.mimetype
    ).then(({ url }) => console.log(`✅ S3 backup: ${url}`))
     .catch(e => console.warn('S3 backup failed (non-critical):', e.message));

    // Store LOCAL url in DB (served via /uploads static)
    await execute(`UPDATE workshops SET ${dbColumn} = ? WHERE id = ?`, [localUrl, req.workshopId]);

    // Upsert workshop_settings (optional — table may not exist)
    try {
      const [existing] = await query(
        'SELECT id FROM workshop_settings WHERE workshop_id = ? AND key_name = ?', [req.workshopId, settingKey]
      );
      if (existing) {
        await execute('UPDATE workshop_settings SET value = ? WHERE workshop_id = ? AND key_name = ?',
          [localUrl, req.workshopId, settingKey]);
      } else {
        await execute(
          'INSERT INTO workshop_settings (workshop_id, key_name, value) VALUES (?, ?, ?)',
          [req.workshopId, settingKey, localUrl]
        );
      }
    } catch (settingsErr) {
      console.warn('workshop_settings upsert skipped:', settingsErr.message);
    }

    return res.json({ success: true, url: localUrl, variant, message: `${isWhite ? 'White' : 'Colored'} logo uploaded successfully` });
  } catch (err) {
    console.error('Logo upload error:', err);
    const localUrl = `/uploads/logos/${req.file?.filename}`;
    return res.json({ success: true, url: localUrl, message: 'Logo saved locally' });
  }
});

/* ── POST /api/uploads/mechanics/:id/photo ───────────────────── */
router.post('/mechanics/:id/photo', mechanicPhoto.single('file'), validateUpload(IMAGE_KINDS), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const [mechanic] = await query(
      'SELECT id FROM mechanics WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]
    );
    if (!mechanic) return res.status(404).json({ success: false, message: 'Mechanic not found' });
    const url = `/uploads/mechanics/${req.file.filename}`;
    await execute('UPDATE mechanics SET photo_url = ? WHERE id = ? AND workshop_id = ?',
      [url, req.params.id, req.workshopId]);
    return res.json({ success: true, url, message: 'Mechanic photo uploaded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Photo upload failed' });
  }
});

/* ── Helper: check if S3 is configured ───────────────── */
const isS3Configured = () => !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

/* ── Helper: save base64 signature (S3 with local fallback) ─
   Exported so other routes (e.g. vehicle-inspections.js, which captures the
   customer's sign-off on the walk-around) can store a signature the same way
   without also writing work_orders.signature_url. */
export async function saveBase64Signature(base64DataUrl, workOrderId) {
  // Strip data URI prefix if present
  const base64Data = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64Data, 'base64');
  // Limit to 5MB
  if (buf.length > 5 * 1024 * 1024) throw new Error('Signature too large (max 5MB)');
  const filename = `sig_${workOrderId}_${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  // Try S3 first; fall back to local disk
  if (isS3Configured()) {
    try {
      const { url } = await uploadToS3(buf, 'signatures', filename, 'image/png');
      return url;
    } catch (s3Err) {
      console.warn('[Uploads] S3 signature upload failed, falling back to local:', s3Err.message);
    }
  }
  const localPath = path.join(UPLOADS_DIR, 'signatures', filename);
  fs.writeFileSync(localPath, buf);
  return `/uploads/signatures/${filename}`;
}

/* ── POST /api/uploads/work-orders/:id/proof ───────────────── */
router.post('/work-orders/:id/proof', proofPhoto.single('file'), validateUpload(IMAGE_KINDS), async (req, res) => {
  try {
    const [workOrder] = await query(
      'SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    // Handle base64 signature sent as JSON (from mobile mechanic app)
    if (!req.file && req.body?.signature) {
      const url = await saveBase64Signature(req.body.signature, req.params.id);
      try {
        await execute('UPDATE work_orders SET signature_url = ? WHERE id = ? AND workshop_id = ?',
          [url, req.params.id, req.workshopId]);
      } catch (colErr) {
        await execute(
          `UPDATE work_orders SET notes = CONCAT(COALESCE(notes,''), '\nSignature: ', ?) WHERE id = ? AND workshop_id = ?`,
          [url, req.params.id, req.workshopId]
        );
      }
      return res.json({ success: true, url, message: 'Signature uploaded' });
    }

    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const url = `/uploads/proofs/${req.file.filename}`;
    // work_orders has no proof_of_delivery_url column — the real column is completion_photo_url.
    await execute('UPDATE work_orders SET completion_photo_url = ? WHERE id = ? AND workshop_id = ?',
      [url, req.params.id, req.workshopId]);
    return res.json({ success: true, url, message: 'Proof of completion uploaded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Proof upload failed' });
  }
});

/* ── POST /api/uploads/stops/:stopId/proof — Per-stop proof photo ──
   NOTE: `order_stops` in the source modeled multi-stop delivery routing
   (a driver visiting several drop-off points on one order). That concept
   doesn't map cleanly onto a workshop (a work order isn't visited in
   multiple physical stops). Kept renamed to `work_order_stops` for any
   narrow internal use (e.g. multi-stage job checkpoints), but this
   endpoint is not expected to be commonly used in the car-workshop
   domain — left in place per "preserve business logic" guidance rather
   than silently dropped. ── */
router.post('/stops/:stopId/proof', stopProofPhoto.single('file'), validateUpload(IMAGE_KINDS), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const [stop] = await query(
      `SELECT os.id, os.work_order_id FROM work_order_stops os
       JOIN work_orders o ON o.id = os.work_order_id
       WHERE os.id = ? AND o.workshop_id = ?`, [req.params.stopId, req.workshopId]
    );
    if (!stop) return res.status(404).json({ success: false, message: 'Stop not found' });
    const url = `/uploads/stop-proofs/${req.file.filename}`;
    await execute('UPDATE work_order_stops SET proof_photo_url = ? WHERE id = ?', [url, req.params.stopId]);
    return res.json({ success: true, url, message: 'Stop proof photo uploaded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Stop proof upload failed' });
  }
});

/* ── POST /api/uploads/work-orders/:id/signature — Customer signature capture ── */
router.post('/work-orders/:id/signature', signaturePhoto.single('file'), validateUpload(IMAGE_KINDS), async (req, res) => {
  try {
    const [workOrder] = await query(
      'SELECT id, status FROM work_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]
    );
    if (!workOrder) return res.status(404).json({ success: false, message: 'Work order not found' });

    let url;
    // Handle base64 signature sent as JSON (from mobile mechanic app)
    if (!req.file && req.body?.signature) {
      url = await saveBase64Signature(req.body.signature, req.params.id);
    } else if (req.file) {
      // Try S3; fall back to local
      if (isS3Configured()) {
        try {
          const { url: s3Url } = await uploadToS3(
            fs.readFileSync(req.file.path), 'signatures', req.file.filename, req.file.mimetype || 'image/png'
          );
          url = s3Url;
          fs.unlink(req.file.path, () => {});
        } catch (s3Err) {
          console.warn('[Uploads] S3 signature file upload failed, using local:', s3Err.message);
          url = `/uploads/signatures/${req.file.filename}`;
        }
      } else {
        url = `/uploads/signatures/${req.file.filename}`;
      }
    } else {
      return res.status(400).json({ success: false, message: 'No file or signature data provided' });
    }

    try {
      await execute('UPDATE work_orders SET signature_url = ? WHERE id = ? AND workshop_id = ?',
        [url, req.params.id, req.workshopId]);
    } catch (colErr) {
      await execute(
        `UPDATE work_orders SET notes = CONCAT(COALESCE(notes,''), '\nSignature: ', ?) WHERE id = ? AND workshop_id = ?`,
        [url, req.params.id, req.workshopId]
      );
    }
    return res.json({ success: true, url, message: 'Signature uploaded' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Signature upload failed' });
  }
});

/* ── Multer error handler ──────────────────────────────────── */
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'File too large' });
  }
  return res.status(400).json({ success: false, message: err.message || 'Upload error' });
});

export default router;
