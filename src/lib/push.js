import webPush from 'web-push';
import { config } from '../config.js';
import { query, execute } from './database.js';

// ─── Setup VAPID ───────────────────────────────────────────────
let pushEnabled = false;

function initPush() {
  const { publicKey, privateKey, subject } = config.push;
  if (publicKey && privateKey) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
    pushEnabled = true;
    console.log('✅ Web Push configured (VAPID keys set)');
  } else {
    console.warn('⚠️  Push notifications not configured — no VAPID keys in .env');
    console.warn('   Generate keys with: npx web-push generate-vapid-keys');
  }
  return pushEnabled;
}

// Auto-init on module load
initPush();

/**
 * Create the push_subscriptions table if it doesn't exist.
 * Called once on server startup.
 */
export async function ensurePushTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id   INT NOT NULL,
      user_id     INT NOT NULL,
      endpoint    TEXT NOT NULL,
      p256dh      VARCHAR(255) NOT NULL,
      auth        VARCHAR(255) NOT NULL,
      user_agent  VARCHAR(500) DEFAULT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_sub (user_id, endpoint(191)),
      KEY idx_push_tenant (tenant_id),
      KEY idx_push_user (user_id),
      FOREIGN KEY (tenant_id) REFERENCES workshops(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `).catch(() => {});

  // User in-app notifications table
  await execute(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id   INT NOT NULL,
      user_id       INT NOT NULL,
      title         VARCHAR(255) NOT NULL,
      body          TEXT NOT NULL,
      type          VARCHAR(50)  DEFAULT 'info',
      icon          VARCHAR(10)  DEFAULT '🔔',
      link          VARCHAR(500) DEFAULT NULL,
      work_order_id INT          DEFAULT NULL,
      is_read       BOOLEAN      DEFAULT FALSE,
      created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      read_at       TIMESTAMP    NULL,
      KEY idx_un_user     (user_id, is_read),
      KEY idx_un_ws       (workshop_id),
      KEY idx_un_dedup    (user_id, work_order_id, type, created_at),
      KEY idx_un_history  (work_order_id, type, created_at),
      KEY idx_un_cleanup  (is_read, created_at),
      FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
  `).catch(() => {});

  // Idempotent index migration for pre-existing user_notifications tables.
  // Wrapped in try/catch so we don't fail startup if the index already exists.
  for (const stmt of [
    'ALTER TABLE user_notifications ADD INDEX idx_un_dedup (user_id, work_order_id, type, created_at)',
    'ALTER TABLE user_notifications ADD INDEX idx_un_history (work_order_id, type, created_at)',
    'ALTER TABLE user_notifications ADD INDEX idx_un_cleanup (is_read, created_at)',
  ]) {
    await execute(stmt).catch(() => { /* index already exists */ });
  }
}

/**
 * Get the public VAPID key (sent to frontend for subscription).
 */
export function getVapidPublicKey() {
  return config.push.publicKey || null;
}

/**
 * Save (upsert) a push subscription for a user.
 *
 * @param {number} tenantId  – Workshop ID
 * @param {number} userId
 * @param {Object} subscription – { endpoint, keys: { p256dh, auth } }
 * @param {string} [userAgent]
 */
export async function saveSubscription(tenantId, userId, subscription, userAgent) {
  const workshopId = tenantId;
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid push subscription — missing endpoint or keys');
  }

  // Upsert: INSERT … ON DUPLICATE KEY UPDATE
  await execute(`
    INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      p256dh = VALUES(p256dh),
      auth   = VALUES(auth),
      user_agent = VALUES(user_agent),
      created_at = CURRENT_TIMESTAMP
  `, [workshopId, userId, endpoint, keys.p256dh, keys.auth, userAgent || null]);
}

/**
 * Remove a push subscription.
 */
export async function removeSubscription(userId, endpoint) {
  await execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [userId, endpoint]);
}

/**
 * Send a push notification to a specific user.
 *
 * @param {number} userId
 * @param {Object} payload – { title, body, icon?, url?, tag?, data? }
 * @returns {Promise<{success: boolean, sent: number, failed: number}>}
 */
export async function sendPushToUser(userId, payload) {
  if (!pushEnabled) {
    return { success: false, sent: 0, failed: 0, error: 'Push not configured' };
  }

  const subs = await query('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs.length) return { success: true, sent: 0, failed: 0 };

  const notifPayload = JSON.stringify({
    title: payload.title || 'Pioneer Solutions',
    body:  payload.body  || '',
    icon:  payload.icon  || '/logo-192.png',
    badge: payload.badge || '/badge-72.png',
    url:   payload.url   || '/',
    tag:   payload.tag   || 'workshop-update',
    data:  payload.data  || {},
  });

  let sent = 0, failed = 0;
  const staleEndpoints = [];

  for (const sub of subs) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webPush.sendNotification(pushSub, notifPayload);
      sent++;
    } catch (err) {
      failed++;
      // 404 or 410 means subscription is no longer valid — clean up
      if (err.statusCode === 404 || err.statusCode === 410) {
        staleEndpoints.push(sub.id);
      }
      console.error(`[Push] Failed to send to user ${userId}:`, err.statusCode || err.message);
    }
  }

  // Clean up expired subscriptions
  if (staleEndpoints.length) {
    await execute(
      `DELETE FROM push_subscriptions WHERE id IN (${staleEndpoints.map(() => '?').join(',')})`,
      staleEndpoints
    ).catch(() => {});
  }

  return { success: sent > 0, sent, failed };
}

/**
 * Send push to all users in a workshop (admin broadcast).
 *
 * @param {number} tenantId  – Workshop ID
 * @param {Object} payload
 * @returns {Promise<{success: boolean, sent: number, failed: number}>}
 */
export async function sendPushToWorkshop(tenantId, payload) {
  const workshopId = tenantId;
  if (!pushEnabled) return { success: false, sent: 0, failed: 0, error: 'Push not configured' };

  const subs = await query('SELECT * FROM push_subscriptions WHERE tenant_id = ?', [workshopId]);
  if (!subs.length) return { success: true, sent: 0, failed: 0 };

  const notifPayload = JSON.stringify({
    title: payload.title || 'Pioneer Solutions',
    body:  payload.body  || '',
    icon:  payload.icon  || '/logo-192.png',
    badge: payload.badge || '/badge-72.png',
    url:   payload.url   || '/',
    tag:   payload.tag   || 'broadcast',
    data:  payload.data  || {},
  });

  let sent = 0, failed = 0;
  const staleIds = [];

  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        notifPayload
      );
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 404 || err.statusCode === 410) staleIds.push(sub.id);
    }
  }

  if (staleIds.length) {
    await execute(
      `DELETE FROM push_subscriptions WHERE id IN (${staleIds.map(() => '?').join(',')})`,
      staleIds
    ).catch(() => {});
  }

  return { success: sent > 0, sent, failed };
}

export default {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
  sendPushToWorkshop,
  ensurePushTable,
};
