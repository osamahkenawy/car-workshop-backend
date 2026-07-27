/**
 * job-delay-checker.js — Mechanic Job Delay Monitor
 * (renamed from delivery-delay-checker.js: a work order running late in the
 *  shop is the workshop equivalent of a delayed delivery)
 *
 * Runs a periodic cron job (every 30 minutes) that:
 *  1. Finds work orders that are assigned/accepted/in_progress/ready_for_pickup but not yet completed
 *  2. Checks if the work order has exceeded the expected completion window:
 *     - If `estimated_delivery_at` is set and past → overdue
 *     - If `scheduled_at` is set and past → overdue
 *     - If work order has been in_progress or ready_for_pickup for more than a configurable threshold (default: 3 hours) → delayed
 *     - If work order has been assigned/accepted for more than 6 hours without starting → delayed
 *  3. Sends in-app + push notifications to the mechanic and workshop admin/ops team
 *  4. Tracks which work orders have already been notified to avoid duplicate alerts
 */

import cron from 'node-cron';
import { query, execute } from './database.js';
import { createInAppNotification } from './notify.js';
import { sendPushToUser, sendPushToWorkshop } from './push.js';
import { sendFCMToUser } from './firebase.js';
import { getIO } from './socket.js';

let cronJob = null;
let isRunning = false; // re-entry guard — if a tick is still running, skip the next

// Thresholds (in hours)
const DELAY_THRESHOLDS = {
  assigned_no_pickup: 6,    // Assigned/accepted but not started after 6h
  in_transit_too_long: 3,   // In progress / ready for pickup but not completed after 3h
};

// Hard caps to keep memory + DB pressure bounded under load
const MAX_ORDERS_PER_TICK = 500;     // never process more than this in one cron run
const HISTORY_CHUNK_SIZE  = 200;     // chunk size for `WHERE work_order_id IN (...)`
const ADMIN_CACHE_TTL_MS  = 5 * 60_000; // cache admin lookup per workshop for 5 min
const workshopAdminCache = new Map();  // Map<workshopId, { ids:number[], at:number }>

/**
 * Start the delay-checker cron (every 30 minutes)
 */
export function startJobDelayChecker() {
  if (cronJob) return;

  cronJob = cron.schedule('*/30 * * * *', async () => {
    if (isRunning) {
      console.warn('[DelayChecker] Previous run still in progress — skipping this tick.');
      return;
    }
    isRunning = true;
    const startedAt = Date.now();
    console.log('[DelayChecker] Running job delay check…');
    try {
      await checkJobDelays();
    } catch (err) {
      console.error('[DelayChecker] Error:', err.message);
    } finally {
      isRunning = false;
      console.log(`[DelayChecker] Tick finished in ${Date.now() - startedAt}ms`);
    }
  });

  console.log('[DelayChecker] Cron scheduled — every 30 minutes');
}

/**
 * Core logic — find delayed work orders and send notifications
 */
async function checkJobDelays() {
  const now = new Date();

  // ── 1. Work orders past their estimated_delivery_at or scheduled_at ──
  const overdueOrders = await query(`
    SELECT o.id, o.work_order_number, o.workshop_id, o.mechanic_id, o.status,
           o.customer_name, o.scheduled_at,
           o.estimated_delivery_at, o.created_at, o.picked_up_at,
           d.full_name as mechanic_name, d.user_id as mechanic_user_id
    FROM work_orders o
    LEFT JOIN mechanics d ON o.mechanic_id = d.id
    WHERE o.status IN ('assigned', 'accepted', 'in_progress', 'ready_for_pickup')
      AND (
        (o.estimated_delivery_at IS NOT NULL AND o.estimated_delivery_at < NOW())
        OR (o.scheduled_at IS NOT NULL AND o.scheduled_at < NOW())
      )
  `);

  // ── 2. Work orders stuck too long without progress ──
  const stuckAssigned = await query(`
    SELECT o.id, o.work_order_number, o.workshop_id, o.mechanic_id, o.status,
           o.customer_name, o.scheduled_at,
           o.estimated_delivery_at, o.created_at, o.picked_up_at,
           d.full_name as mechanic_name, d.user_id as mechanic_user_id,
           TIMESTAMPDIFF(HOUR, COALESCE(
             (SELECT MAX(osl.created_at) FROM work_order_status_logs osl WHERE osl.work_order_id = o.id),
             o.created_at
           ), NOW()) as hours_since_last_update
    FROM work_orders o
    LEFT JOIN mechanics d ON o.mechanic_id = d.id
    WHERE o.status IN ('assigned', 'accepted')
      AND o.estimated_delivery_at IS NULL
      AND o.scheduled_at IS NULL
      AND TIMESTAMPDIFF(HOUR, COALESCE(
        (SELECT MAX(osl.created_at) FROM work_order_status_logs osl WHERE osl.work_order_id = o.id),
        o.created_at
      ), NOW()) >= ?
  `, [DELAY_THRESHOLDS.assigned_no_pickup]);

  const stuckInTransit = await query(`
    SELECT o.id, o.work_order_number, o.workshop_id, o.mechanic_id, o.status,
           o.customer_name, o.scheduled_at,
           o.estimated_delivery_at, o.created_at, o.picked_up_at,
           d.full_name as mechanic_name, d.user_id as mechanic_user_id,
           TIMESTAMPDIFF(HOUR, COALESCE(o.picked_up_at, o.created_at), NOW()) as hours_in_transit
    FROM work_orders o
    LEFT JOIN mechanics d ON o.mechanic_id = d.id
    WHERE o.status IN ('in_progress', 'ready_for_pickup')
      AND o.estimated_delivery_at IS NULL
      AND o.scheduled_at IS NULL
      AND TIMESTAMPDIFF(HOUR, COALESCE(o.picked_up_at, o.created_at), NOW()) >= ?
  `, [DELAY_THRESHOLDS.in_transit_too_long]);

  // Merge all delayed work orders, deduplicate by work order id
  const allDelayed = new Map();
  for (const o of overdueOrders) {
    allDelayed.set(o.id, { ...o, reason: 'overdue', detail: `Past ${o.estimated_delivery_at ? 'estimated' : 'scheduled'} completion time` });
  }
  for (const o of stuckAssigned) {
    if (!allDelayed.has(o.id)) {
      allDelayed.set(o.id, { ...o, reason: 'no_pickup', detail: `Assigned ${o.hours_since_last_update}h ago — not yet started` });
    }
  }
  for (const o of stuckInTransit) {
    if (!allDelayed.has(o.id)) {
      allDelayed.set(o.id, { ...o, reason: 'slow_transit', detail: `In progress for ${o.hours_in_transit}h — not yet completed` });
    }
  }

  if (allDelayed.size === 0) {
    console.log('[DelayChecker] No delayed work orders found.');
    return;
  }

  // ── N2: Stop alerting on stale work orders (> MAX_AGE_HOURS old).
  //        These are abandoned/lost — not "delayed". Should be cleaned up
  //        by the stale-order job, not flooded into the inbox.
  const MAX_AGE_HOURS = 48;
  for (const [orderId, order] of [...allDelayed]) {
    const ageHours = (Date.now() - new Date(order.created_at).getTime()) / 36e5;
    if (ageHours > MAX_AGE_HOURS) {
      allDelayed.delete(orderId);
    }
  }

  if (allDelayed.size === 0) {
    console.log('[DelayChecker] All delayed work orders are stale (>48h) — skipping.');
    return;
  }

  console.log(`[DelayChecker] Found ${allDelayed.size} delayed work order(s). Applying escalation…`);

  // Hard cap: never process more than MAX_ORDERS_PER_TICK in a single tick.
  // Anything truncated will be picked up next run.
  if (allDelayed.size > MAX_ORDERS_PER_TICK) {
    console.warn(`[DelayChecker] Capping ${allDelayed.size} work orders → ${MAX_ORDERS_PER_TICK} for this tick.`);
    const trimmed = new Map();
    let i = 0;
    for (const [id, o] of allDelayed) {
      if (i++ >= MAX_ORDERS_PER_TICK) break;
      trimmed.set(id, o);
    }
    allDelayed.clear();
    for (const [id, o] of trimmed) allDelayed.set(id, o);
  }

  // ── N1: Escalation backoff. Notify once, then 4h, 12h, 24h, then stop.
  //        Look up how many alerts already exist per work order and the latest
  //        timestamp; only fire if the required gap has elapsed.
  const orderIds = [...allDelayed.keys()];
  // Map<workOrderId, { count, lastNotifiedMs }>
  const history = new Map();
  try {
    // Chunk the IN() to keep prepared-statement param count + plan size sane.
    for (let i = 0; i < orderIds.length; i += HISTORY_CHUNK_SIZE) {
      const chunk = orderIds.slice(i, i + HISTORY_CHUNK_SIZE);
      const rows = await query(
        `SELECT work_order_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
           FROM user_notifications
          WHERE type = 'job_delay'
            AND work_order_id IN (${chunk.map(() => '?').join(',')})
          GROUP BY work_order_id`,
        chunk
      );
      for (const r of rows) {
        history.set(r.work_order_id, {
          count: Number(r.cnt) || 0,
          lastNotifiedMs: r.last_at ? new Date(r.last_at).getTime() : 0,
        });
      }
    }
  } catch (_) { /* table may not have type column — proceed anyway */ }

  // Required gap (ms) before sending the Nth+1 alert
  const ESCALATION_GAPS_MS = [
    0,             // 1st alert: send immediately
    4  * 3600_000, // 2nd alert: 4h after 1st
    12 * 3600_000, // 3rd alert: 12h after 2nd
    24 * 3600_000, // 4th alert: 24h after 3rd
  ];
  const MAX_ALERTS_PER_ORDER = ESCALATION_GAPS_MS.length;

  let notifiedCount = 0;
  let suppressedDup = 0;
  let suppressedMax = 0;

  for (const [orderId, order] of allDelayed) {
    const h = history.get(orderId) || { count: 0, lastNotifiedMs: 0 };

    if (h.count >= MAX_ALERTS_PER_ORDER) {
      suppressedMax++;
      continue;
    }
    const requiredGap = ESCALATION_GAPS_MS[h.count];
    if (h.lastNotifiedMs && (Date.now() - h.lastNotifiedMs) < requiredGap) {
      suppressedDup++;
      continue;
    }

    try {
      await notifyDelay(order);
      notifiedCount++;
    } catch (err) {
      console.error(`[DelayChecker] Failed to notify for work order ${order.work_order_number}:`, err.message);
    }
  }

  console.log(
    `[DelayChecker] Notified ${notifiedCount} | suppressed (within backoff) ${suppressedDup} | suppressed (max alerts reached) ${suppressedMax}`
  );
}

/**
 * Send delay notifications for a single work order
 */
async function notifyDelay(order) {
  const { workshop_id: workshopId, mechanic_user_id: mechanicUserId, work_order_number: orderNumber, mechanic_name: mechanicName } = order;

  // N12: plain titles (no emoji) — UI renders the icon separately.
  const mechanicTitle = 'Job Delayed';
  const mechanicBody = `Work order ${orderNumber} for ${order.customer_name || 'customer'} is delayed. ${order.detail}. Please update the status or contact the service desk.`;

  const adminTitle = 'Job Delay Alert';
  const adminBody = `Work order ${orderNumber} — ${mechanicName || 'Unassigned mechanic'}: ${order.detail}`;

  // ── Notify mechanic (in-app + push + FCM) ──
  if (mechanicUserId) {
    await createInAppNotification({
      workshopId,
      userId: mechanicUserId,
      title: mechanicTitle,
      body: mechanicBody,
      type: 'job_delay',
      icon: 'clock',
      link: '/mechanic/work-orders',
      orderId: order.id,
    }).catch(() => {});

    await sendPushToUser(mechanicUserId, {
      title: mechanicTitle,
      body: mechanicBody,
      url: '/mechanic/work-orders',
      tag: `delay-${order.id}`,
      data: { orderId: order.id, orderNumber, route: 'WorkOrderDetails', type: 'job_delay' },
    }).catch(() => {});

    await sendFCMToUser(mechanicUserId, {
      title: mechanicTitle,
      body: mechanicBody,
      url: '/mechanic/work-orders',
      tag: `delay-${order.id}`,
      data: { orderId: String(order.id), orderNumber, route: 'WorkOrderDetails', type: 'job_delay' },
    }).catch(() => {});
  }

  // ── Notify workshop admin/ops team (in-app + push + FCM) ──
  // N6: limit to admin + manager only. Dispatchers also see live alerts via
  //     the Socket.io workshop room emit at the bottom of this function, so
  //     they don't need a personal notification row each.
  // Cache admin lookup per workshop to avoid repeating the same SELECT for
  // every delayed work order in a busy workshop.
  const cached = workshopAdminCache.get(workshopId);
  let admins;
  if (cached && (Date.now() - cached.at) < ADMIN_CACHE_TTL_MS) {
    admins = cached.ids.map(id => ({ id }));
  } else {
    admins = await query(
      "SELECT id FROM users WHERE workshop_id = ? AND role IN ('admin', 'manager')",
      [workshopId]
    );
    workshopAdminCache.set(workshopId, { ids: admins.map(a => a.id), at: Date.now() });
  }

  for (const admin of admins) {
    await createInAppNotification({
      workshopId,
      userId: admin.id,
      title: adminTitle,
      body: adminBody,
      type: 'job_delay',
      icon: 'warning',
      link: `/work-orders`,
      orderId: order.id,
    }).catch(() => {});

    await sendPushToUser(admin.id, {
      title: adminTitle,
      body: adminBody,
      url: '/work-orders',
      tag: `admin-delay-${order.id}`,
      data: { orderId: order.id, orderNumber },
    }).catch(() => {});

    await sendFCMToUser(admin.id, {
      title: adminTitle,
      body: adminBody,
      url: '/work-orders',
      tag: `admin-delay-${order.id}`,
      data: { orderId: order.id, orderNumber },
    }).catch(() => {});
  }

  // ── Socket.io real-time event to workshop dashboard ──
  try {
    const io = getIO();
    io.to(`workshop:${workshopId}`).emit('work-order:job-delayed', {
      orderId: order.id,
      orderNumber,
      mechanicName: mechanicName || null,
      reason: order.reason,
      detail: order.detail,
      timestamp: new Date().toISOString(),
    });
  } catch (_) {}
}

/**
 * Manual trigger for testing
 */
export async function runJobDelayCheckNow() {
  return checkJobDelays();
}
