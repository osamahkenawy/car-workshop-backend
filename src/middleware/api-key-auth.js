/**
 * MODULE E — API Key Authentication Middleware
 *
 * Authenticates external requests via API key instead of JWT.
 * Supports two header formats:
 *   - X-API-Key: cw_XXXX
 *   - Authorization: Bearer cw_XXXX
 *
 * Sets req.workshopId, req.apiKeyId, req.apiKeyName, req.apiPermissions
 * on successful auth. Updates last_used_at asynchronously.
 */

import { query, execute } from '../lib/database.js';
import crypto from 'crypto';

// ── Permission map ────────────────────────────────────────────
// Frontend sends 'read', 'write', 'full' but DB stores JSON array
const PERM_EXPAND = {
  read:  ['work_orders:read', 'service_status:read'],
  write: ['work_orders:read', 'work_orders:write', 'service_status:read'],
  full:  ['work_orders:read', 'work_orders:write', 'service_status:read', 'service_status:write',
           'customers:read', 'customers:write', 'mechanics:read', 'webhooks:manage'],
};

/**
 * Extract API key from request headers.
 * Returns null if no key found or key doesn't start with cw_ prefix.
 */
function extractApiKey(req) {
  // 1. X-API-Key header (preferred)
  const xKey = req.headers['x-api-key'];
  if (xKey && xKey.startsWith('cw_')) return xKey;

  // 2. Authorization: Bearer cw_XXXX
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1].startsWith('cw_')) {
      return parts[1];
    }
  }

  return null;
}

/**
 * Resolve a permission value (could be string shorthand or JSON array)
 * into a normalised array of permission strings.
 */
function resolvePermissions(raw) {
  if (!raw) return PERM_EXPAND.read; // default read-only

  // Already an array
  if (Array.isArray(raw)) return raw;

  // JSON string
  if (typeof raw === 'string') {
    // Simple shorthand: 'read', 'write', 'full'
    if (PERM_EXPAND[raw]) return PERM_EXPAND[raw];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      // Handle {"read": true, ...} style (shouldn't happen but defensive)
      return Object.keys(parsed).filter(k => parsed[k]);
    } catch {
      return PERM_EXPAND.read;
    }
  }

  return PERM_EXPAND.read;
}

/**
 * Main API-key auth middleware.
 * Use on /api/v1/* routes. Rejects if no valid key found.
 */
export async function apiKeyAuth(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      message: 'API key required. Pass X-API-Key header or Authorization: Bearer cw_XXXX',
    });
  }

  try {
    const api_key_hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const [keyRow] = await query(
      `SELECT ak.id, ak.workshop_id, ak.name, ak.permissions, ak.expires_at, ak.is_active,
              w.status AS workshop_status, w.name AS workshop_name
       FROM api_keys ak
       JOIN workshops w ON ak.workshop_id = w.id
       WHERE ak.api_key = ?`, [api_key_hash]
    );

    if (!keyRow) {
      return res.status(401).json({ success: false, message: 'Invalid API key' });
    }

    if (!keyRow.is_active) {
      return res.status(403).json({ success: false, message: 'API key has been revoked' });
    }

    // Check expiry
    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'API key has expired' });
    }

    // Check workshop is active
    if (!['active', 'trial'].includes(keyRow.workshop_status)) {
      return res.status(403).json({
        success: false,
        message: `Workshop account is ${keyRow.workshop_status}. API access is disabled.`,
      });
    }

    // Populate request context
    req.workshopId      = keyRow.workshop_id;
    req.apiKeyId       = keyRow.id;
    req.apiKeyName     = keyRow.name;
    req.apiPermissions = resolvePermissions(keyRow.permissions);
    req.isApiKey       = true;

    // Synthetic user object so downstream route handlers work
    req.user = {
      id: 0,
      workshop_id: keyRow.workshop_id,
      role: 'api',
      username: `api:${keyRow.name}`,
      full_name: keyRow.name,
      is_active: true,
      permissions: {},
    };

    // Fire-and-forget: update last_used_at, request_count, last_used_ip
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    execute(
      'UPDATE api_keys SET last_used_at = NOW(), request_count = COALESCE(request_count, 0) + 1, last_used_ip = ? WHERE id = ?',
      [clientIp, keyRow.id]
    ).catch(() => {});

    next();
  } catch (err) {
    console.error('[api-key-auth] Error:', err.message);
    return res.status(500).json({ success: false, message: 'API authentication error' });
  }
}

/**
 * Permission check middleware factory.
 * Usage: requireApiPermission('work_orders:write')
 * Must run AFTER apiKeyAuth.
 */
export function requireApiPermission(...perms) {
  return (req, res, next) => {
    // If not API key auth (e.g., JWT user), skip this check
    if (!req.isApiKey) return next();

    const granted = req.apiPermissions || [];
    const missing = perms.filter(p => !granted.includes(p));

    if (missing.length > 0) {
      return res.status(403).json({
        success: false,
        message: `API key lacks required permissions: ${missing.join(', ')}`,
        required: perms,
        granted,
      });
    }
    next();
  };
}

export default apiKeyAuth;
