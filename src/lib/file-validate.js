/**
 * file-validate.js — verify uploaded files by their actual bytes.
 *
 * The upload gates checked two things, and an attacker controls both of them:
 * the filename extension and the declared Content-Type of the part. Renaming
 * payload.html to photo.jpg and sending "image/jpeg" passed every check. One
 * route (customer-portal) had no filter at all and accepted any file up to 5MB.
 *
 * Multer's fileFilter runs before the body is read, so it can only ever see
 * metadata. Content has to be checked after the upload completes — which is
 * what the middleware here does, deleting the file if it does not match.
 *
 * No new dependency: the allow-list is five fixed formats, so sniffing them
 * directly is short, auditable, and avoids pulling a package into a security
 * fix. SVG is deliberately absent — it is a script-capable document, not a
 * safe image.
 */

import fs from 'node:fs/promises';

/**
 * Signatures for the formats this application accepts.
 * `check` receives the leading bytes of the file.
 */
const SIGNATURES = [
  {
    kind: 'jpeg',
    exts: ['.jpg', '.jpeg'],
    mimes: ['image/jpeg'],
    check: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    kind: 'png',
    exts: ['.png'],
    mimes: ['image/png'],
    check: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
                b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    kind: 'webp',
    exts: ['.webp'],
    mimes: ['image/webp'],
    // "RIFF" .... "WEBP"
    check: b => b.slice(0, 4).toString('latin1') === 'RIFF' &&
                b.slice(8, 12).toString('latin1') === 'WEBP',
  },
  {
    kind: 'gif',
    exts: ['.gif'],
    mimes: ['image/gif'],
    check: b => b.slice(0, 6).toString('latin1') === 'GIF87a' ||
                b.slice(0, 6).toString('latin1') === 'GIF89a',
  },
  {
    kind: 'doc',
    exts: ['.doc'],
    mimes: ['application/msword'],
    // OLE2 compound document, which is also .xls/.ppt. Narrow enough here: the
    // point is that it is a real Office container and not a script or binary.
    check: b => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
                b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1,
  },
  {
    kind: 'docx',
    exts: ['.docx'],
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    // DOCX is a ZIP. Magic bytes cannot tell it from any other ZIP without
    // reading the archive index, so this confirms "a real ZIP container" rather
    // than "specifically a Word file". That still rejects HTML, scripts and
    // executables, which is what matters at this boundary.
    check: b => b[0] === 0x50 && b[1] === 0x4b &&
                (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  },
  {
    kind: 'pdf',
    exts: ['.pdf'],
    mimes: ['application/pdf'],
    check: b => b.slice(0, 5).toString('latin1') === '%PDF-',
  },
];

/** Enough bytes for every signature above. */
const HEADER_BYTES = 32;

/** Convenience sets for the two call sites. */
export const IMAGE_KINDS = ['jpeg', 'png', 'webp', 'gif'];
export const DOC_KINDS = ['jpeg', 'png', 'webp', 'pdf'];
/** Resume uploads on the public careers form. */
export const RESUME_KINDS = ['pdf', 'doc', 'docx'];

/**
 * Identify a buffer by its magic bytes.
 * @returns {string|null} the kind, or null when nothing matches.
 */
export function sniffKind(buffer) {
  if (!buffer || buffer.length < 4) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.check(buffer)) return sig.kind;
    } catch {
      /* buffer shorter than this signature needs */
    }
  }
  return null;
}

/**
 * Check a buffer against an allow-list, and confirm the extension agrees with
 * the content. A .pdf holding a JPEG is not an attack, but it is a mislabelled
 * file that later code will mishandle, so it is refused too.
 *
 * @returns {{ ok: true, kind: string } | { ok: false, reason: string }}
 */
export function validateBuffer(buffer, originalName, allowedKinds) {
  const kind = sniffKind(buffer);
  if (!kind) {
    return { ok: false, reason: 'File content is not a recognised image or PDF' };
  }
  if (!allowedKinds.includes(kind)) {
    return { ok: false, reason: `${kind.toUpperCase()} files are not accepted here` };
  }
  const name = String(originalName || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  const sig = SIGNATURES.find(s => s.kind === kind);
  if (ext && !sig.exts.includes(ext)) {
    return { ok: false, reason: `File contents are ${kind.toUpperCase()} but the name says ${ext}` };
  }
  return { ok: true, kind };
}

/**
 * Express middleware for multer disk storage. Reads the header of whatever
 * landed, and removes the file if it is not an allowed type.
 *
 * Mount directly after the multer middleware:
 *   router.post('/x', upload.single('file'), validateUpload(IMAGE_KINDS), handler)
 */
export function validateUpload(allowedKinds = IMAGE_KINDS, { field = 'file' } = {}) {
  return async (req, res, next) => {
    const files = req.files
      ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat())
      : (req.file ? [req.file] : []);
    if (!files.length) return next();

    for (const f of files) {
      try {
        let head;
        if (f.buffer) {
          head = f.buffer.subarray(0, HEADER_BYTES);
        } else {
          const fh = await fs.open(f.path, 'r');
          try {
            const buf = Buffer.alloc(HEADER_BYTES);
            const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
            head = buf.subarray(0, bytesRead);
          } finally {
            await fh.close();
          }
        }

        const verdict = validateBuffer(head, f.originalname, allowedKinds);
        if (!verdict.ok) {
          // Never leave a rejected file on disk.
          await Promise.all(
            files.filter(x => x.path).map(x => fs.unlink(x.path).catch(() => {}))
          );
          return res.status(400).json({ success: false, message: verdict.reason });
        }
        f.detectedKind = verdict.kind;
      } catch (err) {
        await Promise.all(
          files.filter(x => x.path).map(x => fs.unlink(x.path).catch(() => {}))
        );
        return res.status(400).json({ success: false, message: 'Uploaded file could not be verified' });
      }
    }
    return next();
  };
}

export default validateUpload;
