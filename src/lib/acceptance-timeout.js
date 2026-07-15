/**
 * acceptance-timeout.js — Auto-unassign work orders not accepted within timeout
 *
 * Runs every 5 minutes. For each workshop:
 *  1. Reads `order_accept_timeout_minutes` from settings (default: 30)
 *  2. Finds work orders in 'assigned' status older than the timeout
 *  3. Un-assigns the mechanic, returns work order to 'pending'
 *  4. Notifies workshop admins via in-app notification + socket
 */

import cron from 'node-cron';
import { query, execute } from './database.js';
import { createInAppNotification } from './notify.js';
import { getIO } from './socket.js';

const DEFAULT_TIMEOUT_MINUTES = 30;
let cronJob = null;

export function startAcceptanceTimeout() {
  if (cronJob) return;

  cronJob = cron.schedule('*/5 * * * *', async () => {
    try {
      await checkStaleAssignments();
    } catch (err) {
      console.error('[AcceptTimeout] Error:', err.message);
    }
  });

  console.log('[AcceptTimeout] Cron started — checking every 5 minutes');
}

async function checkStaleAssignments() {
  const workshops = await query('SELECT id, name FROM workshops WHERE is_active = TRUE');

  for (const workshop of workshops) {
    try {
      await processWorkshopStaleOrders(workshop);
    } catch (err) {
      console.error(`[AcceptTimeout] workshop ${workshop.id}:`, err.message);
    }
  }
}

async function processWorkshopStaleOrders(workshop) {
  // Read per-workshop timeout (or use default)
  const [setting] = await query(
    "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'order_accept_timeout_minutes'",
    [workshop.id]
  );
  const timeoutMin = parseInt(setting?.value, 10) || DEFAULT_TIMEOUT_MINUTES;

  // 0 means disabled
  if (timeoutMin <= 0) return;

  // Find assigned work orders that have exceeded the timeout
  // Use work_order_assignments.assigned_at for accurate timing
  const staleOrders = await query(
    `SELECT o.id, o.work_order_number, o.mechanic_id, m.full_name as mechanic_name,
            oa.assigned_at
     FROM work_orders o
     JOIN mechanics m ON m.id = o.mechanic_id
     LEFT JOIN work_order_assignments oa ON oa.work_order_id = o.id AND oa.is_current = TRUE
     WHERE o.workshop_id = ? AND o.status = 'assigned'
       AND (
         (oa.assigned_at IS NOT NULL AND oa.assigned_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
         OR
         (oa.assigned_at IS NULL AND o.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
       )`,
    [workshop.id, timeoutMin, timeoutMin]
  );

  if (!staleOrders.length) return;

  console.log(`[AcceptTimeout] workshop ${workshop.id}: ${staleOrders.length} stale assigned work order(s)`);

  for (const order of staleOrders) {
    const mechanicId = order.mechanic_id;

    // Un-assign mechanic, return to pending
    await execute(
      "UPDATE work_orders SET mechanic_id = NULL, status = 'pending' WHERE id = ? AND status = 'assigned'",
      [order.id]
    );

    // Mark assignment as no longer current
    await execute(
      'UPDATE work_order_assignments SET is_current = FALSE WHERE work_order_id = ? AND is_current = TRUE',
      [order.id]
    );

    // Log the timeout
    await execute(
      "INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, 'pending', NULL, ?)",
      [order.id, `Auto-unassigned: mechanic ${order.mechanic_name} did not accept within ${timeoutMin} min`]
    );

    // Release mechanic if no other active work orders
    const [activeCount] = await query(
      "SELECT COUNT(*) as cnt FROM work_orders WHERE mechanic_id = ? AND status IN ('assigned','accepted','in_progress','ready_for_pickup')",
      [mechanicId]
    );
    if (!activeCount?.cnt || activeCount.cnt === 0) {
      await execute("UPDATE mechanics SET status = 'available' WHERE id = ? AND status = 'busy'", [mechanicId]);
    }

    // Notify workshop admins
    const admins = await query(
      "SELECT id FROM users WHERE workshop_id = ? AND role IN ('admin','manager','dispatcher') AND is_active = TRUE",
      [workshop.id]
    );
    for (const admin of admins) {
      await createInAppNotification({
        workshopId: workshop.id,
        userId: admin.id,
        title: 'Work order auto-unassigned',
        body: `Work order ${order.work_order_number} was unassigned from ${order.mechanic_name} — no response within ${timeoutMin} min`,
        type: 'warning',
        icon: '⏰',
        link: `/work-orders`,
        orderId: order.id,
      });
    }

    // Broadcast via socket so Live board updates immediately
    const io = getIO();
    if (io) {
      io.to(`workshop:${workshop.id}`).emit('work-order:reassigned', {
        orderId: order.id,
        orderNumber: order.work_order_number,
        status: 'pending',
        reason: 'acceptance_timeout',
      });
    }

    console.log(`[AcceptTimeout] Work order ${order.work_order_number} unassigned from ${order.mechanic_name} (${timeoutMin}min timeout)`);
  }
}
