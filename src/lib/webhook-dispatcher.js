/**
 * ═══════════════════════════════════════════════════════════════════
 *  Webhook Dispatcher  —  fire outbound webhooks for work order events
 * ═══════════════════════════════════════════════════════════════════
 *  Called by work-orders.js, service-status.js, job-assignment.js,
 *  warranty-claims.js, cash-payment.js at the end of every
 *  state-changing operation.
 *
 *  Usage:
 *    import { dispatchWebhook } from '../lib/webhook-dispatcher.js';
 *    dispatchWebhook({ workshopId, event: 'order.delivered', data: order });
 *
 *  Non-blocking — all failures are logged, never thrown.
 * ═══════════════════════════════════════════════════════════════════
 */
import { query } from './database.js';
import { deliverWebhook } from '../routes/webhooks.js';

/**
 * dispatchWebhook
 * Finds all active webhook endpoints subscribed to `event` for the
 * given workshop, then fires them all concurrently (non-blocking).
 * Failed deliveries are automatically retried up to 2 more times
 * with exponential back-off (5 s → 60 s).
 *
 * @param {object} opts
 * @param {number} opts.workshopId
 * @param {string} opts.event    — e.g. 'order.delivered'
 * @param {object} opts.data     — payload data (order, mechanic, etc.)
 */

/** Delays (ms) before retry attempt 2, then attempt 3 */
const RETRY_DELAYS = [5_000, 60_000];

export async function dispatchWebhook({ tenantId, event, data }) {
  const workshopId = tenantId;
  if (!workshopId || !event) return;

  try {
    const endpoints = await query(
      `SELECT id, url, secret, headers
       FROM webhook_endpoints
       WHERE tenant_id = ? AND is_active = 1
         AND JSON_CONTAINS(events, JSON_QUOTE(?))`,
      [workshopId, event]
    );

    if (!endpoints?.length) return;

    const payload = {
      event,
      timestamp: new Date().toISOString(),
      tenant_id: workshopId,
      data,
    };

    // Fire each endpoint independently (non-blocking); each manages its own retries
    for (const ep of endpoints) {
      _deliverWithRetry({ endpoint: ep, event, payload, workshopId, attempt: 1 })
        .catch(e => console.error(`[Webhook] unhandled error for ${ep.url}:`, e.message));
    }
  } catch (err) {
    // Never throw — webhook failures must never affect the main request
    console.error('[Webhook] Dispatcher error:', err.message);
  }
}

/**
 * _deliverWithRetry
 * Attempts delivery and, on failure, schedules the next retry up to
 * RETRY_DELAYS.length additional attempts.
 */
async function _deliverWithRetry({ endpoint, event, payload, workshopId, attempt }) {
  try {
    const result = await deliverWebhook({ endpoint, event, payload, tenantId: workshopId });

    if (result?.status === 'failed') {
      const retryIndex = attempt - 1; // 0-based index into RETRY_DELAYS
      if (retryIndex < RETRY_DELAYS.length) {
        const delayMs = RETRY_DELAYS[retryIndex];
        console.warn(
          `[Webhook] ${event} → ${endpoint.url} failed (attempt ${attempt}/${attempt + RETRY_DELAYS.length - retryIndex}),` +
          ` retrying in ${delayMs / 1000}s`
        );
        setTimeout(() => {
          _deliverWithRetry({ endpoint, event, payload, workshopId, attempt: attempt + 1 })
            .catch(e => console.error(`[Webhook] retry error ${endpoint.url}:`, e.message));
        }, delayMs);
      } else {
        console.error(`[Webhook] ${event} → ${endpoint.url} permanently failed after ${attempt} attempt(s).`);
      }
    }
  } catch (err) {
    console.error(`[Webhook] ${event} → ${endpoint.url} attempt ${attempt} threw:`, err.message);
  }
}

// ── Event name helpers ────────────────────────────────────────

/** Map a work order status to its webhook event name */
export function workOrderStatusToEvent(status) {
  const map = {
    confirmed:  'order.confirmed',
    assigned:   'order.assigned',
    picked_up:  'order.picked_up',
    in_transit: 'order.in_transit',
    delivered:  'order.delivered',
    failed:     'order.failed',
    returned:   'order.returned',
    cancelled:  'order.cancelled',
  };
  return map[status] || null;
}

/** Map a warranty claim status to its webhook event name */
export function warrantyClaimStatusToEvent(status) {
  const map = {
    approved:         'return.approved',
    pickup_scheduled: 'return.pickup_scheduled',
    picked_up:        'return.picked_up',
    received:         'return.received',
    refunded:         'return.refunded',
    rejected:         'return.rejected',
  };
  return map[status] || null;
}
