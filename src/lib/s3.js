/**
 * s3.js — File upload helper (S3 with local-disk fallback)
 *
 * Call shape observed in the already-ported routes (uploads.js, mechanics.js,
 * mechanic-app.js):
 *   const { url } = await uploadToS3(fileBuffer, folder, filename, mimeType);
 *
 * `folder` is a logical sub-directory (e.g. 'logos', 'signatures') used both
 * as the S3 key prefix and as the local uploads/ sub-directory when falling
 * back to disk.
 *
 * If AWS credentials are present (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
 * mirrored onto config.s3 = { bucket, region, accessKeyId, secretAccessKey }),
 * we upload to S3 via @aws-sdk/client-s3 and return the resulting object URL.
 * Otherwise we write the file locally under the project's uploads/ directory
 * and return a local URL path like `/uploads/<folder>/<filename>`.
 *
 * The AWS SDK is imported dynamically inside a try/catch so its absence
 * (package not installed) never crashes module load — uploads.js already has
 * its own local S3-configured check for the same reason, and this mirrors it.
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

/**
 * Returns true if AWS S3 credentials are present in the environment/config.
 */
export function isS3Configured() {
  const s3 = config?.s3;
  return !!(
    (process.env.AWS_S3_BUCKET || s3?.bucket) &&
    (process.env.AWS_ACCESS_KEY_ID || s3?.accessKeyId) &&
    (process.env.AWS_SECRET_ACCESS_KEY || s3?.secretAccessKey)
  );
}

async function uploadToS3Remote(fileBuffer, folder, filename, mimeType) {
  const bucket = process.env.AWS_S3_BUCKET || config.s3.bucket;
  const region = process.env.AWS_REGION || config.s3?.region || 'me-central-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || config.s3?.accessKeyId;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || config.s3?.secretAccessKey;

  // S3 keys are flat strings, so "../" cannot escape the bucket the way it
  // escapes a filesystem path — but it still writes to a key the caller did not
  // intend, so the same sanitising applies.
  const key = `${path.basename(String(folder || 'misc'))}/${safeFilename(filename)}`;

  // Dynamic import so a missing '@aws-sdk/client-s3' package never crashes
  // module load — only matters at the moment an upload is actually attempted.
  const sdk = await import('@aws-sdk/client-s3').catch(() => null);
  if (!sdk) {
    throw new Error('@aws-sdk/client-s3 is not installed — cannot upload to S3');
  }

  const { S3Client, PutObjectCommand } = sdk;
  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType || 'application/octet-stream',
  }));

  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  return { url, key, bucket };
}

/**
 * Reduce a caller-supplied name to something safe to join onto a path.
 *
 * Callers pass req.file.originalname straight through, which is chosen by
 * whoever is uploading. path.join(dir, '../../../../etc/cron.d/x') resolves
 * outside the uploads directory entirely, so this was an arbitrary file write
 * — a writable path under /etc or a web root is remote code execution.
 *
 * Only the basename is kept, and any character that is not a plain filename
 * character is replaced. An empty or dot-only result gets a generated name.
 */
function safeFilename(filename) {
  const base = path.basename(String(filename || ''));      // drops any directory part
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_')    // no separators survive
                      .replace(/^\.+/, '')                 // no leading dots
                      .slice(0, 200);
  return cleaned || `file-${Date.now()}`;
}

async function uploadToLocal(fileBuffer, folder, filename) {
  const safeFolder = path.basename(String(folder || 'misc'));
  const dir = path.join(UPLOADS_DIR, safeFolder);
  await fs.mkdir(dir, { recursive: true });

  const safeName = safeFilename(filename);
  const filePath = path.join(dir, safeName);

  // Belt and braces: even with the sanitising above, refuse to write anywhere
  // that is not inside the uploads directory.
  const root = path.resolve(UPLOADS_DIR);
  if (!path.resolve(filePath).startsWith(root + path.sep)) {
    throw new Error('Refusing to write outside the uploads directory');
  }

  await fs.writeFile(filePath, fileBuffer);
  return { url: `/uploads/${safeFolder}/${safeName}`, key: `${safeFolder}/${safeName}` };
}

/**
 * Upload a file buffer to S3 (if configured) or local disk (fallback).
 *
 * @param {Buffer} fileBuffer
 * @param {string} folder - logical sub-directory, e.g. 'logos', 'signatures'
 * @param {string} filename
 * @param {string} [mimeType]
 * @returns {Promise<{url: string, key: string, bucket?: string}>}
 */
export async function uploadToS3(fileBuffer, folder, filename, mimeType) {
  if (isS3Configured()) {
    try {
      return await uploadToS3Remote(fileBuffer, folder, filename, mimeType);
    } catch (err) {
      console.warn('[S3] Upload failed, falling back to local disk:', err.message);
      return uploadToLocal(fileBuffer, folder, filename);
    }
  }

  return uploadToLocal(fileBuffer, folder, filename);
}

export default { uploadToS3, isS3Configured };
