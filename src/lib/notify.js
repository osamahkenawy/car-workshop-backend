/**
 * ═══════════════════════════════════════════════════════════════════
 *  Notification Service  –  Unified work order lifecycle notifications
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Channels:  SMS  ·  Email  ·  Push (Web Push)  ·  In-App (Socket.io)
 *
 *  Usage:
 *    import { notifyWorkOrderStatus, notifyMechanicAssigned } from '../lib/notify.js';
 *    await notifyWorkOrderStatus({ order, status, workshopId, changedBy });
 *
 *  All channel failures are non-blocking — the work order lifecycle
 *  continues even if one channel fails.  Every attempt is logged to
 *  the `notifications` table.
 * ═══════════════════════════════════════════════════════════════════
 */

import { config } from '../config.js';
import { query, execute } from './database.js';
import { sendSMS, interpolate } from './sms.js';
import { sendEmail, buildWorkOrderStatusEmail, getWorkshopBranding } from './email.js';
import { sendPushToUser, sendPushToWorkshop } from './push.js';
import { sendFCMToUser } from './firebase.js';
import { getIO } from './socket.js';

// ─── In-App notification helper ───────────────────────────────
/**
 * Create an in-app notification record for a specific user.
 * These appear in the notification bell dropdown.
 */
export async function createInAppNotification({ workshopId, userId, title, body, type = 'info', icon = '🔔', link = null, orderId = null }) {
  try {
    // ── N7: insert-time dedup ──
    // For work-order-scoped notifications, suppress if an identical
    // (user_id, order_id, type) row was created in the last hour.
    // Prevents racing crons / endpoints from inserting duplicates.
    if (orderId) {
      try {
        const dup = await query(
          `SELECT id FROM user_notifications
            WHERE user_id = ? AND work_order_id = ? AND type = ?
              AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
            LIMIT 1`,
          [userId, orderId, type]
        );
        if (dup && dup.length) {
          return { success: true, id: dup[0].id, deduped: true };
        }
      } catch (e) {
        // This used to swallow silently, which hid the fact that the table
        // did not exist at all. Dedup is best-effort, so still proceed.
        console.warn('[notify] dedup check failed:', e.message);
      }
    }

    const result = await execute(
      `INSERT INTO user_notifications (workshop_id, user_id, title, body, type, icon, link, work_order_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workshopId, userId, title, body, type, icon, link || null, orderId || null]
    );

    // Push real-time via Socket.io so UI updates instantly
    try {
      const io = getIO();
      io.to(`user:${userId}`).emit('notification:new', {
        id: result.insertId,
        title, body, type, icon, link, order_id: orderId,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    } catch (_) { /* socket may not be ready */ }

    return { success: true, id: result.insertId };
  } catch (e) {
    console.error('[InApp] Failed to create in-app notification:', e.message);
    return { success: false, error: e.message };
  }
}

// ─── Status metadata ──────────────────────────────────────────
// Keyed on the REAL current work_orders.status enum (car_workshop.sql):
// pending, confirmed, assigned, accepted, in_progress, inspection,
// ready_for_pickup, completed, cancelled. This used to be keyed on the old
// delivery-app enum (picked_up/in_transit/delivered/failed/returned), none
// of which exist as status values any more — so notifyWorkOrderStatus()
// silently sent nothing for any real status change (`if (!meta) return;`
// below always hit). Fixed here alongside the matching field-name fix in
// buildVars()/the direct order.* reads further down, since templates alone
// don't help if the variables they interpolate are also reading from
// fields (recipient_phone, client_id, ...) this table doesn't have.
const STATUS_META = {
  pending:          { icon: 'clock',      label: 'Pending',           color: '#f59e0b' },
  confirmed:        { icon: 'check',      label: 'Confirmed',         color: '#10b981' },
  assigned:         { icon: 'user',       label: 'Mechanic Assigned', color: '#6366f1' },
  accepted:         { icon: 'check',      label: 'Accepted',          color: '#0ea5e9' },
  in_progress:      { icon: 'truck',      label: 'In Progress',       color: '#f97316' },
  inspection:       { icon: 'inspection', label: 'Inspection',        color: '#7c3aed' },
  ready_for_pickup: { icon: 'package',    label: 'Ready for Pickup',  color: '#c2410c' },
  completed:        { icon: 'delivery',   label: 'Completed',         color: '#16a34a' },
  cancelled:        { icon: 'cancelled',  label: 'Cancelled',         color: '#94a3b8' },
};

// ─── SMS templates per status ─────────────────────────────────
const SMS_TEMPLATES = {
  pending:          'Hi {recipient_name}, your work order {order_number} has been placed. You can track it here: {tracking_url}',
  confirmed:        'Hi {recipient_name}, your work order {order_number} is confirmed and will be serviced soon.',
  assigned:         'Your work order {order_number} has been assigned to mechanic {driver_name}. Tracking: {tracking_url}',
  accepted:         'Mechanic {driver_name} has accepted your work order {order_number} and will begin shortly.',
  in_progress:      'Your work order {order_number} is now in progress.',
  inspection:       'Your work order {order_number} is in final inspection.',
  ready_for_pickup: 'Good news! Your vehicle for work order {order_number} is ready for pickup.',
  completed:        'Hi {recipient_name}, your work order {order_number} has been completed. Thank you!',
  cancelled:        'Your work order {order_number} has been cancelled. Please contact us with any questions.',
};

// ─── Email subjects per status ────────────────────────────────
const EMAIL_SUBJECTS = {
  pending:          'Work Order {order_number} — Placed Successfully',
  confirmed:        'Work Order {order_number} Confirmed',
  assigned:         'Mechanic Assigned to Work Order {order_number}',
  accepted:         'Work Order {order_number} Accepted by Mechanic',
  in_progress:      'Work Order {order_number} In Progress',
  inspection:       'Work Order {order_number} In Final Inspection',
  ready_for_pickup: 'Work Order {order_number} Ready for Pickup',
  completed:        'Work Order {order_number} Completed!',
  cancelled:        'Work Order {order_number} Cancelled',
};

// ─── Push notification templates ──────────────────────────────
const PUSH_TEMPLATES = {
  // For customer
  customer: {
    pending:          { title: 'Work Order Placed',      body: 'Your work order {order_number} has been placed. Track it online!' },
    confirmed:        { title: 'Work Order Confirmed',   body: 'Your work order {order_number} is confirmed.' },
    assigned:         { title: 'Mechanic Assigned',      body: 'Your work order {order_number} has been assigned to {driver_name}.' },
    accepted:         { title: 'Mechanic Accepted Job',  body: '{driver_name} has accepted your work order {order_number}.' },
    in_progress:      { title: 'In Progress',            body: '{order_number} is being worked on!' },
    inspection:       { title: 'In Inspection',          body: '{order_number} is in final inspection.' },
    ready_for_pickup: { title: 'Ready for Pickup',       body: '{order_number} is ready for pickup.' },
    completed:        { title: 'Completed!',             body: '{order_number} has been completed.' },
    cancelled:        { title: 'Work Order Cancelled',   body: '{order_number} has been cancelled.' },
  },
  // For mechanic
  driver: {
    assigned:         { title: 'New Job Assigned',       body: 'You have a new work order: {order_number} for {recipient_name}.' },
    accepted:         { title: 'Job Accepted',           body: 'You accepted {order_number}. Head to the service bay.' },
    in_progress:      { title: 'In Progress',            body: 'You are working on {order_number}.' },
    inspection:       { title: 'In Inspection',          body: '{order_number} is in final inspection.' },
    ready_for_pickup: { title: 'Ready for Pickup',       body: '{order_number} is ready for the customer to collect.' },
    completed:        { title: 'Job Complete',           body: 'You completed {order_number}. Great job!' },
    cancelled:        { title: 'Work Order Cancelled',   body: '{order_number} has been cancelled.' },
  },
  // For admin / ops team
  admin: {
    assigned:         { title: 'Mechanic Assigned',      body: '{driver_name} assigned to {order_number}.' },
    accepted:         { title: 'Job Accepted',           body: '{driver_name} accepted {order_number}.' },
    in_progress:      { title: 'Work Order In Progress', body: '{driver_name} started work on {order_number}.' },
    inspection:       { title: 'In Inspection',          body: '{order_number} is in final inspection.' },
    ready_for_pickup: { title: 'Ready for Pickup',       body: '{order_number} is ready for the customer to collect.' },
    completed:        { title: 'Work Order Completed',   body: '{driver_name} completed {order_number}.' },
    cancelled:        { title: 'Work Order Cancelled',   body: '{order_number} has been cancelled.' },
  },
};

// ─── Helper: log notification to DB ───────────────────────────
async function logNotification({
  workshopId, type, recipientPhone, recipientEmail,
  templateKey, message, orderId, userId, driverId, status, errorMessage,
}) {
  try {
    await execute(
      `INSERT INTO notifications
       (tenant_id, type, recipient_phone, recipient_email, template_key, message, order_id, user_id, driver_id, status, error_message, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'sent' ? 'NOW()' : 'NULL'})`,
      [workshopId, type, recipientPhone || null, recipientEmail || null,
       templateKey || null, message, orderId || null, userId || null,
       driverId || null, status || 'pending', errorMessage || null]
    );
  } catch (e) {
    console.error('[Notify] Failed to log notification:', e.message);
  }
}

// ─── Helper: build tracking URL ───────────────────────────────
function trackingUrl(token) {
  let base = config.frontendUrl || 'http://localhost:5173';
  // Production safety fallback — never send localhost links in prod emails
  if (process.env.NODE_ENV === 'production' && base.includes('localhost')) {
    base = 'https://delivery.pioneercarservice.com';
  }
  return `${base}/track/${token}`;
}

// ─── Helper: build template vars ──────────────────────────────
function buildVars(order, extra = {}) {
  // NOTE: reads from the REAL work_orders columns (car_workshop.sql), not
  // the old delivery-app field names (recipient_*/order_number/tracking_token/
  // driver_*/cod_amount/delivery_fee/client_*) this used to read — those
  // don't exist on this table, so every field here was always empty/undefined
  // regardless of status, on top of the status-key mismatch fixed above.
  // Template placeholder NAMES (e.g. {recipient_name}) are kept as-is so the
  // SMS/email/push template strings above don't need to change.
  return {
    recipient_name:     order.customer_name        || 'Customer',
    order_number:       order.work_order_number    || '',
    tracking_token:     order.service_status_token || '',
    tracking_url:       trackingUrl(order.service_status_token),
    driver_name:        order.mechanic_name         || extra.driver_name || 'your mechanic',
    driver_phone:       order.mechanic_phone        || extra.driver_phone || '',
    cod_amount:         order.cash_amount ? `${extra.currency || 'AED'} ${parseFloat(order.cash_amount).toFixed(2)}` : '',
    delivery_fee:       order.service_fee ? `${extra.currency || 'AED'} ${parseFloat(order.service_fee).toFixed(2)}` : '',
    // Part-level variables (formerly package-level)
    barcode:            extra.barcode              || order.barcode || '',
    package_number:     extra.package_number       || '',
    package_status:     extra.package_status       || '',
    packages_delivered: extra.packages_delivered != null ? String(extra.packages_delivered) : '',
    packages_total:     extra.packages_total != null ? String(extra.packages_total) : '',
    master_tracking:    order.service_status_token || '',
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════
//  MAIN: Notify on work order status change
// ═══════════════════════════════════════════════════════════════

/**
 * Fire all notification channels for a work order status change.
 *
 * @param {Object}  opts
 * @param {Object}  opts.order       – Full work order row (with mechanic_name, customer fields, etc.)
 * @param {string}  opts.status      – The new status
 * @param {number}  opts.workshopId  – Workshop ID
 * @param {number}  [opts.changedBy] – User ID who triggered the change
 * @param {Object}  [opts.extra]     – Extra template variables
 */
export async function notifyWorkOrderStatus({ order, status, workshopId, changedBy, extra = {} }) {
  const [_t] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
  const currency = _t?.currency || 'AED';
  const vars = buildVars(order, { ...extra, currency });
  const meta = STATUS_META[status];
  if (!meta) return;

  const results = { sms: null, email: null, push: null, socket: null };

  // ──────────────────────────────────────
  //  1. SMS to customer
  // ──────────────────────────────────────
  if (SMS_TEMPLATES[status] && order.customer_phone) {
    try {
      const body = interpolate(SMS_TEMPLATES[status], vars);
      const smsResult = await sendSMS(order.customer_phone, body);
      results.sms = smsResult;
      await logNotification({
        workshopId, type: 'sms', recipientPhone: order.customer_phone,
        templateKey: `order_${status}`, message: body, orderId: order.id,
        status: smsResult.success ? 'sent' : 'failed',
        errorMessage: smsResult.error || null,
      });
    } catch (e) {
      console.error('[Notify] SMS error:', e.message);
    }
  }

  // ──────────────────────────────────────
  //  2. Email to customer (if email available)
  // ──────────────────────────────────────
  const recipientEmail = order.customer_email || order.customer_email_ref;
  if (EMAIL_SUBJECTS[status] && recipientEmail) {
    try {
      const branding = await getWorkshopBranding(workshopId);
      const subject  = interpolate(EMAIL_SUBJECTS[status], vars);
      const html     = buildWorkOrderStatusEmail({
        order, status,
        trackingUrl: trackingUrl(order.service_status_token),
        branding, currency,
      });
      const emailResult = await sendEmail({ to: recipientEmail, subject, html, tenantId: workshopId });
      results.email = emailResult;
      await logNotification({
        workshopId, type: 'email', recipientEmail,
        templateKey: `order_${status}`, message: subject, orderId: order.id,
        status: emailResult.success ? 'sent' : 'failed',
        errorMessage: emailResult.error || null,
      });
    } catch (e) {
      console.error('[Notify] Email error:', e.message);
    }
  }

  // ──────────────────────────────────────
  //  3. Email to customer account (business record) — if customer_id has email
  // ──────────────────────────────────────
  if (['completed', 'cancelled'].includes(status) && order.customer_id) {
    try {
      const [customer] = await query('SELECT email, full_name FROM customers WHERE id = ?', [order.customer_id]);
      if (customer?.email && customer.email !== recipientEmail) {
        const branding = await getWorkshopBranding(workshopId);
        const subject  = interpolate(`Work Order ${order.work_order_number} — ${meta.label}`, vars);
        const html     = buildWorkOrderStatusEmail({ order, status, trackingUrl: trackingUrl(order.service_status_token), branding, currency });
        await sendEmail({ to: customer.email, subject, html, tenantId: workshopId });
        await logNotification({
          workshopId, type: 'email', recipientEmail: customer.email,
          templateKey: `client_${status}`, message: subject, orderId: order.id,
          status: 'sent',
        });
      }
    } catch (e) { /* non-blocking */ }
  }

  // ──────────────────────────────────────
  //  4. Push notification to mechanic (Web Push + FCM)
  // ──────────────────────────────────────────
  if (PUSH_TEMPLATES.driver[status] && order.mechanic_id) {
    try {
      // Look up the user_id linked to this mechanic
      const [mechanic] = await query('SELECT user_id FROM mechanics WHERE id = ?', [order.mechanic_id]);
      if (mechanic?.user_id) {
        const t = PUSH_TEMPLATES.driver[status];
        const pushPayload = {
          title: interpolate(t.title, vars),
          body:  interpolate(t.body,  vars),
          url:   '/mechanic/orders',
          tag:   `order-${order.id}`,
          data:  { orderId: order.id, status, orderNumber: order.work_order_number },
        };
        // Web Push (browser)
        await sendPushToUser(mechanic.user_id, pushPayload);
        // FCM (mobile app)
        await sendFCMToUser(mechanic.user_id, pushPayload).catch(e =>
          console.error('[Notify] FCM (mechanic) error:', e.message)
        );
      }
    } catch (e) {
      console.error('[Notify] Push (mechanic) error:', e.message);
    }
  }

  // ──────────────────────────────────────
  //  5. Push notification to admin/ops team (Web Push + FCM)
  // ──────────────────────────────────────
  if (PUSH_TEMPLATES.admin[status]) {
    try {
      const t = PUSH_TEMPLATES.admin[status];
      // Get all admin/manager users for this workshop
      const admins = await query(
        "SELECT id FROM users WHERE tenant_id = ? AND role IN ('admin','manager','dispatcher') AND id != ?",
        [workshopId, changedBy || 0]
      );
      for (const admin of admins) {
        const pushPayload = {
          title: interpolate(t.title, vars),
          body:  interpolate(t.body,  vars),
          url:   `/orders`,
          tag:   `admin-order-${order.id}`,
          data:  { orderId: order.id, status, orderNumber: order.work_order_number },
        };
        await sendPushToUser(admin.id, pushPayload).catch(() => {});
        await sendFCMToUser(admin.id, pushPayload).catch(() => {});
      }
    } catch (e) {
      console.error('[Notify] Push (admin) error:', e.message);
    }
  }

  // ──────────────────────────────────────
  //  5b. In-app notifications (mechanic + admin team)
  // ──────────────────────────────────────
  try {
    // In-app to mechanic
    if (order.mechanic_id) {
      const [mch] = await query('SELECT user_id FROM mechanics WHERE id = ?', [order.mechanic_id]);
      if (mch?.user_id) {
        const driverTmpl = PUSH_TEMPLATES.driver[status];
        if (driverTmpl) {
          await createInAppNotification({
            workshopId, userId: mch.user_id,
            title: interpolate(driverTmpl.title, vars),
            body: interpolate(driverTmpl.body, vars),
            type: 'order_update', icon: meta.icon,
            link: '/mechanic/orders', orderId: order.id,
          });
        }
      }
    }

    // In-app to admin/ops team
    const adminTmpl = PUSH_TEMPLATES.admin[status];
    if (adminTmpl) {
      const adminUsers = await query(
        "SELECT id FROM users WHERE tenant_id = ? AND role IN ('admin','manager','dispatcher') AND id != ?",
        [workshopId, changedBy || 0]
      );
      for (const au of adminUsers) {
        await createInAppNotification({
          workshopId, userId: au.id,
          title: interpolate(adminTmpl.title, vars),
          body: interpolate(adminTmpl.body, vars),
          type: 'order_update', icon: meta.icon,
          link: `/orders`, orderId: order.id,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[Notify] In-app error:', e.message);
  }

  // ──────────────────────────────────────
  //  6. Socket.io real-time event
  // ──────────────────────────────────────
  try {
    const io = getIO();
    io.to(`workshop:${workshopId}`).emit('work-order:status-changed', {
      orderId:     order.id,
      orderNumber: order.work_order_number,
      status,
      previousStatus: order.status,
      driverName:  vars.driver_name,
      timestamp:   new Date().toISOString(),
    });
  } catch (e) {
    // Socket might not be initialized in testing
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
//  Notify: Mechanic assigned to work order
// ═══════════════════════════════════════════════════════════════

/**
 * Notify when a mechanic is assigned to a work order.
 */
export async function notifyMechanicAssigned({ order, driver, tenantId }) {
  const workshopId = tenantId;
  const [_t] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
  const currency = _t?.currency || 'AED';
  const vars = buildVars(order, {
    driver_name:  driver.full_name || driver.name,
    driver_phone: driver.phone,
    currency,
  });

  // SMS to customer
  if (SMS_TEMPLATES.assigned && order.customer_phone) {
    try {
      const body = interpolate(SMS_TEMPLATES.assigned, vars);
      const smsResult = await sendSMS(order.customer_phone, body);
      await logNotification({
        workshopId, type: 'sms', recipientPhone: order.customer_phone,
        templateKey: 'driver_assigned', message: body, orderId: order.id,
        driverId: driver.id, status: smsResult.success ? 'sent' : 'failed',
      });
    } catch (e) { /* non-blocking */ }
  }

  // Email to customer
  const recipientEmail = order.customer_email || order.customer_email_ref;
  if (recipientEmail) {
    try {
      const branding = await getWorkshopBranding(workshopId);
      const subject  = interpolate(EMAIL_SUBJECTS.assigned, vars);
      const html     = buildWorkOrderStatusEmail({
        order: { ...order, driver_name: vars.driver_name, driver_phone: vars.driver_phone },
        status: 'assigned',
        trackingUrl: trackingUrl(order.service_status_token),
        branding, currency,
      });
      await sendEmail({ to: recipientEmail, subject, html, tenantId: workshopId });
      await logNotification({
        workshopId, type: 'email', recipientEmail,
        templateKey: 'driver_assigned', message: subject, orderId: order.id,
        driverId: driver.id, status: 'sent',
      });
    } catch (e) { /* non-blocking */ }
  }

  // Push to the mechanic (Web Push + FCM)
  if (driver.user_id) {
    try {
      const pushPayload = {
        title: 'New Job Assigned',
        body:  `You have a new work order: ${order.work_order_number} for ${order.customer_name}`,
        url:   '/mechanic/orders',
        tag:   `assigned-${order.id}`,
        data:  { orderId: order.id, orderNumber: order.work_order_number },
      };
      await sendPushToUser(driver.user_id, pushPayload);
      await sendFCMToUser(driver.user_id, pushPayload).catch(e =>
        console.error('[Notify] FCM (mechanic assign) error:', e.message)
      );
    } catch (e) { /* non-blocking */ }
  }

  // Email to the MECHANIC's own account email
  if (driver.user_id) {
    try {
      const [driverUser] = await query('SELECT email, full_name FROM users WHERE id = ?', [driver.user_id]);
      if (driverUser?.email) {
        const branding = await getWorkshopBranding(workshopId);
        const { sendNotificationEmail } = await import('./email.js');
        const dispatchDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const dispatchTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        await sendNotificationEmail({
          to: driverUser.email,
          subject: `New Job Assigned — ${order.work_order_number}`,
          title: 'New Job Assignment',
          body: `
            <p>Hi <strong>${driverUser.full_name || 'Mechanic'}</strong>,</p>
            <p>A new work order has been assigned to you:</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;width:140px;">Work Order</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${order.work_order_number}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Customer</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${order.customer_name || '—'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Phone</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${order.customer_phone || '—'}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Drop-off Address</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${order.dropoff_address || '—'}</td></tr>
              ${order.cash_amount ? `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Cash Payment Amount</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#f97316;font-weight:700;">${currency} ${parseFloat(order.cash_amount).toFixed(2)}</td></tr>` : ''}
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Dispatch Date</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${dispatchDate}</td></tr>
              <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Dispatch Time</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${dispatchTime}</td></tr>
              ${order.notes ? `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Notes</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${order.notes}</td></tr>` : ''}
            </table>
            <p>Please log in to your mechanic dashboard to view full details and start the job.</p>
          `,
          ctaText: 'View My Jobs',
          ctaUrl: `${config.frontendUrl || 'http://localhost:5173'}/mechanic/orders`,
          tenantId: workshopId,
        });
        await logNotification({
          workshopId, type: 'email', recipientEmail: driverUser.email,
          templateKey: 'driver_assignment_email', message: `Mechanic assignment email for ${order.work_order_number}`,
          orderId: order.id, driverId: driver.id, userId: driver.user_id, status: 'sent',
        });
      }
    } catch (e) {
      console.error('[Notify] Mechanic email error:', e.message);
    }
  }

  // In-app notification to the mechanic
  if (driver.user_id) {
    try {
      const dispatchDateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      await createInAppNotification({
        workshopId, userId: driver.user_id,
        title: 'New Job Assigned',
        body: `Work order ${order.work_order_number} for ${order.customer_name || 'customer'}. Pickup from ${order.dropoff_address || 'workshop'}. Dispatched: ${dispatchDateStr}${order.cash_amount ? '. Cash payment: ' + currency + ' ' + parseFloat(order.cash_amount).toFixed(2) : ''}`,
        type: 'assignment', icon: 'assignment',
        link: '/mechanic/orders', orderId: order.id,
      });
    } catch (e) { /* non-blocking */ }
  }

  // In-app notification to admin team
  try {
    const adminUsers = await query(
      "SELECT id FROM users WHERE tenant_id = ? AND role IN ('admin','manager','dispatcher')",
      [workshopId]
    );
    for (const au of adminUsers) {
      await createInAppNotification({
        workshopId, userId: au.id,
        title: 'Mechanic Assigned',
        body: `${vars.driver_name} assigned to work order ${order.work_order_number}`,
        type: 'assignment', icon: 'assignment',
        link: `/orders`, orderId: order.id,
      }).catch(() => {});
    }
  } catch (e) { /* non-blocking */ }

  // Socket
  try {
    const io = getIO();
    io.to(`workshop:${workshopId}`).emit('work-order:mechanic-assigned', {
      orderId:     order.id,
      orderNumber: order.work_order_number,
      driverId:    driver.id,
      driverName:  vars.driver_name,
      timestamp:   new Date().toISOString(),
    });
  } catch (e) { /* non-blocking */ }
}

// ═══════════════════════════════════════════════════════════════
//  Notify: Cash payment collected
// ═══════════════════════════════════════════════════════════════

export async function notifyCashCollected({ order, amount, tenantId }) {
  const workshopId = tenantId;
  const [_t] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
  const currency = _t?.currency || 'AED';
  const vars = buildVars(order, { amount: `${currency} ${parseFloat(amount).toFixed(2)}`, currency });

  // SMS to customer
  if (order.customer_phone) {
    try {
      const body = interpolate(
        'Cash payment of {amount} has been collected for work order {order_number}. Thank you!',
        vars
      );
      await sendSMS(order.customer_phone, body);
      await logNotification({
        workshopId, type: 'sms', recipientPhone: order.customer_phone,
        templateKey: 'cod_collected', message: body, orderId: order.id, status: 'sent',
      });
    } catch (e) { /* non-blocking */ }
  }

  // Socket broadcast
  try {
    const io = getIO();
    io.to(`workshop:${workshopId}`).emit('work-order:cash-collected', {
      orderId: order.id, orderNumber: order.work_order_number,
      amount: parseFloat(amount), timestamp: new Date().toISOString(),
    });
  } catch (e) { /* non-blocking */ }
}

// ═══════════════════════════════════════════════════════════════
//  Notify: Custom / manual notification
// ═══════════════════════════════════════════════════════════════

/**
 * Send a custom notification via one or more channels.
 *
 * @param {Object}  opts
 * @param {string[]} opts.channels  – ['sms', 'email', 'push']
 * @param {string}  opts.phone      – Recipient phone (for SMS)
 * @param {string}  opts.email      – Recipient email
 * @param {string}  opts.message    – Message text
 * @param {string}  [opts.subject]  – Email subject
 * @param {number}  [opts.tenantId] – Workshop ID
 * @param {number}  [opts.orderId]
 * @param {number}  [opts.userId]   – Target user for push
 */
export async function sendCustomNotification({ channels = [], phone, email, message, subject, tenantId, orderId, userId }) {
  const workshopId = tenantId;
  const results = {};

  if (channels.includes('sms') && phone) {
    try {
      const r = await sendSMS(phone, message);
      results.sms = r;
      await logNotification({
        workshopId, type: 'sms', recipientPhone: phone,
        templateKey: 'custom', message, orderId,
        status: r.success ? 'sent' : 'failed', errorMessage: r.error,
      });
    } catch (e) { results.sms = { success: false, error: e.message }; }
  }

  if (channels.includes('email') && email) {
    try {
      const { sendNotificationEmail } = await import('./email.js');
      const r = await sendNotificationEmail({
        to: email, subject: subject || 'Notification from Pioneer',
        title: subject || 'Notification',
        body: `<p>${message}</p>`,
        tenantId: workshopId,
      });
      results.email = r;
      await logNotification({
        workshopId, type: 'email', recipientEmail: email,
        templateKey: 'custom', message: subject || message, orderId,
        status: r.success ? 'sent' : 'failed', errorMessage: r.error,
      });
    } catch (e) { results.email = { success: false, error: e.message }; }
  }

  if (channels.includes('push') && userId) {
    try {
      const pushPayload = {
        title: subject || 'Notification',
        body:  message,
        url:   orderId ? `/orders/${orderId}` : '/',
      };
      const r = await sendPushToUser(userId, pushPayload);
      results.push = r;
      // Also send via FCM to mobile devices
      await sendFCMToUser(userId, pushPayload).catch(() => {});
    } catch (e) { results.push = { success: false, error: e.message }; }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
//  Notify: Per-part status change
// ═══════════════════════════════════════════════════════════════

/**
 * JUDGMENT CALL: the original `notifyPackageStatus` modeled MPS (multi-piece
 * shipment) tracking — "Package 2/3 delivered" — which assumed packages carry
 * their own barcode/tracking and move through a delivery lifecycle independent
 * of the parent order. That doesn't map cleanly onto `parts.js`, where a "part"
 * is an inventory line item consumed within a work order (per the mapping doc,
 * parts.js drops parcel-specific tracking/proof-of-delivery fields).
 *
 * Rather than dropping this notification entirely, we repurpose it as a generic
 * "part status" notification — useful for cases like "part backordered" /
 * "part restocked" / "part installed" — while keeping the exact same function
 * shape, DB logging, and socket-emit structure as the source. If this doesn't
 * end up wired to any route, it's safe to leave unused; the shape is preserved
 * so a calling route can adopt it for low-stock/restock alerts too.
 *
 * @param {Object}  opts
 * @param {Object}  opts.order        – Parent work order row
 * @param {Object}  opts.pkg          – Part row (id, barcode/part_number, sequence, status, recipient_name, etc.)
 * @param {string}  opts.newStatus    – The new part status
 * @param {number}  opts.tenantId     – Workshop ID
 * @param {number}  [opts.changedBy]
 * @param {number}  [opts.delivered]  – Count of parts installed/delivered
 * @param {number}  [opts.total]      – Total parts on the work order
 */
export async function notifyPartStatus({ order, pkg, newStatus, tenantId, changedBy, delivered = 0, total = 0 }) {
  const workshopId = tenantId;
  if (!order || !pkg) return;

  const PART_SMS = {
    picked_up:  'Part {package_number}/{packages_total} for work order {order_number} has been picked up. Ref: {barcode}',
    in_transit: 'Part {package_number}/{packages_total} for work order {order_number} is on its way!',
    delivered:  'Part {package_number}/{packages_total} for work order {order_number} has been installed ({packages_delivered}/{packages_total} complete).',
    failed:     'Part {package_number}/{packages_total} for work order {order_number} could not be sourced.',
  };

  const template = PART_SMS[newStatus];
  if (!template) return;

  const recipientPhone = pkg.recipient_phone || order.customer_phone;
  if (!recipientPhone) return;

  const vars = buildVars(order, {
    barcode: pkg.barcode,
    package_number: String(pkg.sequence || 1),
    package_status: newStatus,
    packages_delivered: String(delivered),
    packages_total: String(total),
    recipient_name: pkg.recipient_name || order.customer_name || 'Customer',
  });

  try {
    const body = interpolate(template, vars);
    await sendSMS(recipientPhone, body);
    await logNotification({
      workshopId, type: 'sms', recipientPhone,
      templateKey: `package_${newStatus}`, message: body, orderId: order.id,
      status: 'sent',
    });
  } catch (e) {
    console.error('[Notify] Part SMS error:', e.message);
  }

  // Socket.io real-time event for part status
  try {
    const io = getIO();
    io.to(`workshop:${workshopId}`).emit('part:status-changed', {
      packageId: pkg.id,
      packageBarcode: pkg.barcode,
      packageSequence: pkg.sequence,
      orderId: order.id,
      orderNumber: order.work_order_number,
      status: newStatus,
      delivered,
      total,
      timestamp: new Date().toISOString(),
    });
  } catch (_) { /* socket not ready */ }
}

export default {
  notifyWorkOrderStatus,
  notifyMechanicAssigned,
  notifyCashCollected,
  notifyPartStatus,
  sendCustomNotification,
};
