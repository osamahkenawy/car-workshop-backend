/**
 * audit.js — Lightweight audit log writer
 *
 * Fire-and-forget: failures are logged to console but never thrown, so a
 * broken audit_logs table (or a transient DB hiccup) can never take down a
 * request that's just trying to record "who did what."
 */

import { execute } from './database.js';

/**
 * Insert one row into `audit_logs`.
 *
 * @param {object} params
 * @param {number} params.workshopId
 * @param {number} params.userId
 * @param {string} params.action - e.g. 'dispute.created', 'escrow.hold'
 * @param {string} params.entityType - e.g. 'dispute', 'wallet', 'settings'
 * @param {number|string} params.entityId
 * @param {*} [params.oldValue] - JSON-serializable snapshot before the change
 * @param {*} [params.newValue] - JSON-serializable snapshot after the change
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 */
export async function logAudit({
  workshopId,
  userId,
  action,
  entityType,
  entityId,
  oldValue = null,
  newValue = null,
  ip = null,
  userAgent = null,
} = {}) {
  try {
    await execute(
      `INSERT INTO audit_logs
        (workshop_id, user_id, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        workshopId ?? null,
        userId ?? null,
        action ?? null,
        entityType ?? null,
        entityId ?? null,
        oldValue != null ? JSON.stringify(oldValue) : null,
        newValue != null ? JSON.stringify(newValue) : null,
        ip,
        userAgent,
      ]
    );
  } catch (err) {
    console.error('[Audit] Failed to write audit log:', err.message);
  }
}
