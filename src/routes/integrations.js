import express from 'express';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// ── Ensure extra columns exist (idempotent) ────────────────
(async () => {
  const cols = [
    { name: 'description', sql: "ALTER TABLE api_keys ADD COLUMN description VARCHAR(500) DEFAULT NULL AFTER name" },
    { name: 'request_count', sql: "ALTER TABLE api_keys ADD COLUMN request_count INT DEFAULT 0 AFTER last_used_at" },
    { name: 'last_used_ip', sql: "ALTER TABLE api_keys ADD COLUMN last_used_ip VARCHAR(45) DEFAULT NULL AFTER request_count" },
    { name: 'key_prefix', sql: "ALTER TABLE api_keys ADD COLUMN key_prefix VARCHAR(22) DEFAULT NULL AFTER api_key" },
  ];
  for (const col of cols) {
    try {
      const rows = await query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_keys' AND COLUMN_NAME=?",
        [col.name]
      );
      if (rows.length === 0) await execute(col.sql);
    } catch { /* ignore */ }
  }
  // Back-fill key_prefix is no longer applicable (api_key is now a hash)
})();

// ── GET /api/integrations — list API keys with usage stats ──
router.get('/', async (req, res) => {
  try {
    const keys = await query(
      `SELECT id, name, description, key_prefix,
              key_prefix AS key_preview,
              permissions, last_used_at, last_used_ip,
              request_count, expires_at, is_active, created_by, created_at
       FROM api_keys WHERE workshop_id = ? ORDER BY created_at DESC`,
      [req.workshopId]
    );
    return res.json({ success: true, data: keys });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch API keys' });
  }
});

// ── GET /api/integrations/:id — single key detail ───────────
router.get('/:id', async (req, res) => {
  try {
    const [key] = await query(
      `SELECT id, name, description, key_prefix,
              key_prefix AS key_preview,
              permissions, last_used_at, last_used_ip,
              request_count, expires_at, is_active, created_by, created_at
       FROM api_keys WHERE id = ? AND workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!key) return res.status(404).json({ success: false, message: 'API key not found' });
    return res.json({ success: true, data: key });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch API key' });
  }
});

// ── POST /api/integrations — create API key ─────────────────
router.post('/', async (req, res) => {
  try {
    const { name, description, permissions = 'read', expires_at } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name required' });

    // 'td_' was the old Traseallo prefix; config.js and the API docs both say
    // cw_. Keys are stored hashed, so changing the generator does not
    // invalidate any key already issued.
    const api_key = 'cw_' + crypto.randomBytes(24).toString('hex');
    const api_key_hash = crypto.createHash('sha256').update(api_key).digest('hex');
    const key_prefix = api_key.slice(0, 10) + '…' + api_key.slice(-4);

    // Expand permission shorthand to array for consistent storage
    // The enquiries scopes were missing entirely, so a key created here — even
    // at 'full' — got a 403 from POST /api/v1/enquiries, which is the endpoint
    // a website contact form needs. requireApiPermission does an exact string
    // match, so the scope has to be listed verbatim.
    const PERM_EXPAND = {
      read: [
        'work_orders:read', 'service_status:read', 'enquiries:read',
      ],
      write: [
        'work_orders:read', 'work_orders:write', 'service_status:read',
        'enquiries:read', 'enquiries:write',
      ],
      full: [
        'work_orders:read', 'work_orders:write', 'service_status:read',
        'service_status:write', 'customers:read', 'customers:write',
        'mechanics:read', 'webhooks:manage',
        'enquiries:read', 'enquiries:write',
      ],
    };
    const permArray = PERM_EXPAND[permissions] || PERM_EXPAND.read;

    const result = await execute(
      `INSERT INTO api_keys (workshop_id, name, description, api_key, key_prefix, permissions, expires_at, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
      [req.workshopId, name.trim(), description?.trim() || null, api_key_hash, key_prefix,
       JSON.stringify(permArray), expires_at || null, req.user.id]
    );

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        api_key,                 // full key — shown only once
        key_preview: key_prefix,
        name: name.trim(),
        description: description?.trim() || null,
        permissions,
      },
      message: 'Save the API key now — it will not be shown again.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create API key' });
  }
});

// ── PUT /api/integrations/:id — update key name / description ─
router.put('/:id', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name required' });

    const [existing] = await query('SELECT id FROM api_keys WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'API key not found' });

    await execute(
      'UPDATE api_keys SET name = ?, description = ? WHERE id = ? AND workshop_id = ?',
      [name.trim(), description?.trim() || null, req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'API key updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update API key' });
  }
});

// ── PATCH /api/integrations/:id/toggle — revoke/reactivate ──
router.patch('/:id/toggle', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can revoke/reactivate API keys' });
    }
    const [key] = await query('SELECT id, is_active FROM api_keys WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!key) return res.status(404).json({ success: false, message: 'API key not found' });

    await execute(
      'UPDATE api_keys SET is_active = NOT is_active WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: key.is_active ? 'API key revoked' : 'API key reactivated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update API key' });
  }
});

// ── POST /api/integrations/:id/regenerate — issue new key ───
router.post('/:id/regenerate', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can regenerate API keys' });
    }
    const [existing] = await query('SELECT id FROM api_keys WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'API key not found' });

    // 'td_' was the old Traseallo prefix; config.js and the API docs both say
    // cw_. Keys are stored hashed, so changing the generator does not
    // invalidate any key already issued.
    const api_key = 'cw_' + crypto.randomBytes(24).toString('hex');
    const api_key_hash = crypto.createHash('sha256').update(api_key).digest('hex');
    const key_prefix = api_key.slice(0, 10) + '…' + api_key.slice(-4);

    await execute(
      'UPDATE api_keys SET api_key = ?, key_prefix = ?, request_count = 0, last_used_at = NULL, last_used_ip = NULL WHERE id = ? AND workshop_id = ?',
      [api_key_hash, key_prefix, req.params.id, req.workshopId]
    );

    return res.json({
      success: true,
      data: { api_key, key_preview: key_prefix },
      message: 'New API key generated. Save it now — it will not be shown again.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to regenerate API key' });
  }
});

// ── DELETE /api/integrations/:id — delete key permanently ───
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only admins can delete API keys' });
    }
    const result = await execute('DELETE FROM api_keys WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'API key not found' });
    return res.json({ success: true, message: 'API key deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete API key' });
  }
});

export default router;
