/**
 * ═══════════════════════════════════════════════════════════════════
 *  Firebase Cloud Messaging (FCM) — Native Push for iOS & Android
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Uses firebase-admin SDK to send push notifications to mobile devices.
 *  Device tokens are stored in the `device_tokens` table.
 *
 *  Service account: src/traseallo-firebase-adminsdk-fbsvc-721ddb57da.json
 * ═══════════════════════════════════════════════════════════════════
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query, execute } from './database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Init Firebase Admin ──────────────────────────────────────
let fcmEnabled = false;

function initFirebase() {
  try {
    const saPath = resolve(__dirname, '..', 'traseallo-firebase-adminsdk-fbsvc-721ddb57da.json');
    const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    fcmEnabled = true;
    console.log('✅ Firebase Admin SDK initialized (FCM enabled)');
  } catch (err) {
    console.warn('⚠️  Firebase Admin SDK not configured:', err.message);
    console.warn('   Mobile push notifications will be disabled.');
  }
}

// Auto-init on module load
initFirebase();

/**
 * Create the device_tokens table if it doesn't exist.
 * Called once on server startup.
 */
export async function ensureDeviceTokensTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id   INT NOT NULL,
      user_id     INT NOT NULL,
      device_token TEXT NOT NULL,
      platform    ENUM('ios', 'android') NOT NULL DEFAULT 'android',
      device_info VARCHAR(500) DEFAULT NULL,
      is_active   BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_device (user_id, device_token(191)),
      KEY idx_dt_tenant (tenant_id),
      KEY idx_dt_user (user_id),
      KEY idx_dt_active (is_active),
      FOREIGN KEY (tenant_id) REFERENCES workshops(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `).catch(() => {});
}

/**
 * Register (upsert) a device token for a user.
 * `tenantId` here refers to the workshop the user belongs to (column name
 * kept as tenant_id in device_tokens for FK/schema consistency — see comment
 * on the table above).
 */
export async function registerDeviceToken(tenantId, userId, deviceToken, platform = 'android', deviceInfo = null) {
  const workshopId = tenantId;
  if (!deviceToken) throw new Error('device_token is required');
  await execute(`
    INSERT INTO device_tokens (tenant_id, user_id, device_token, platform, device_info, is_active)
    VALUES (?, ?, ?, ?, ?, TRUE)
    ON DUPLICATE KEY UPDATE
      platform    = VALUES(platform),
      device_info = VALUES(device_info),
      is_active   = TRUE,
      updated_at  = CURRENT_TIMESTAMP
  `, [workshopId, userId, deviceToken, platform, deviceInfo]);
}

/**
 * Remove a device token (on logout).
 */
export async function removeDeviceToken(userId, deviceToken) {
  await execute(
    'UPDATE device_tokens SET is_active = FALSE WHERE user_id = ? AND device_token = ?',
    [userId, deviceToken]
  );
}

/**
 * Remove all device tokens for a user (full sign-out).
 */
export async function removeAllDeviceTokens(userId) {
  await execute('UPDATE device_tokens SET is_active = FALSE WHERE user_id = ?', [userId]);
}

/**
 * Send FCM push notification to a specific user (all their devices).
 * Used for both mechanics and customers/admins — "user" here is any
 * account with a registered mobile device token.
 *
 * @param {number} userId
 * @param {Object} payload – { title, body, data?, imageUrl? }
 * @returns {Promise<{success: boolean, sent: number, failed: number}>}
 */
export async function sendFCMToUser(userId, payload) {
  if (!fcmEnabled) {
    return { success: false, sent: 0, failed: 0, error: 'FCM not configured' };
  }

  const tokens = await query(
    'SELECT id, device_token, platform FROM device_tokens WHERE user_id = ? AND is_active = TRUE',
    [userId]
  );
  if (!tokens.length) return { success: true, sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  const staleIds = [];

  for (const t of tokens) {
    try {
      const message = {
        token: t.device_token,
        notification: {
          title: payload.title || 'Traseallo',
          body: payload.body || '',
        },
        data: {
          ...(payload.data ? Object.fromEntries(
            Object.entries(payload.data).map(([k, v]) => [k, String(v)])
          ) : {}),
          click_action: payload.url || '/',
        },
        // Platform-specific configs
        android: {
          priority: 'high',
          notification: {
            channelId: 'traseallo_orders',
            sound: 'default',
            icon: 'ic_notification',
            color: '#244066',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              'content-available': 1,
            },
          },
        },
      };

      if (payload.imageUrl) {
        message.notification.imageUrl = payload.imageUrl;
      }

      await admin.messaging().send(message);
      sent++;
    } catch (err) {
      failed++;
      // Token invalid / unregistered — mark as stale
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token' ||
        err.code === 'messaging/invalid-argument'
      ) {
        staleIds.push(t.id);
      }
      console.error(`[FCM] Failed to send to user ${userId} (${t.platform}):`, err.code || err.message);
    }
  }

  // Clean up stale tokens
  if (staleIds.length) {
    await execute(
      `UPDATE device_tokens SET is_active = FALSE WHERE id IN (${staleIds.map(() => '?').join(',')})`,
      staleIds
    ).catch(() => {});
  }

  return { success: sent > 0, sent, failed };
}

/**
 * Send FCM push to all users in a workshop.
 */
export async function sendFCMToWorkshop(tenantId, payload) {
  const workshopId = tenantId;
  if (!fcmEnabled) return { success: false, sent: 0, failed: 0, error: 'FCM not configured' };

  const tokens = await query(
    'SELECT DISTINCT user_id FROM device_tokens WHERE tenant_id = ? AND is_active = TRUE',
    [workshopId]
  );

  let totalSent = 0, totalFailed = 0;
  for (const { user_id } of tokens) {
    const r = await sendFCMToUser(user_id, payload);
    totalSent += r.sent;
    totalFailed += r.failed;
  }

  return { success: totalSent > 0, sent: totalSent, failed: totalFailed };
}

export function isFCMEnabled() {
  return fcmEnabled;
}

export default {
  ensureDeviceTokensTable,
  registerDeviceToken,
  removeDeviceToken,
  removeAllDeviceTokens,
  sendFCMToUser,
  sendFCMToWorkshop,
  isFCMEnabled,
};
