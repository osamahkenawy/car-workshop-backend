/**
 * data-retention.js — Work Order Data Retention Enforcement
 *
 * Runs a daily cron job that:
 *  1. Checks each workshop's plan data_retention_days limit
 *  2. Sends warning email 7 days before oldest work orders will be deleted
 *  3. Sends final warning email 1 day before deletion
 *  4. Deletes work orders older than the retention period
 *
 * Retention periods from plan-gate.js:
 *   trial/starter: 30 days | growth: 365 days | enterprise: 1825 days | self_hosted: 99999 days
 */

import cron from 'node-cron';
import { query, execute } from './database.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding } from './email.js';
import { PLAN_FEATURES } from '../middleware/plan-gate.js';

let cronJob = null;

/**
 * Start the daily data retention cron (runs at 3:00 AM server time)
 */
export function startDataRetention() {
  if (cronJob) return;

  cronJob = cron.schedule('0 3 * * *', async () => {
    console.log('[DataRetention] Running daily data retention check…');
    try {
      await enforceDataRetention();
    } catch (err) {
      console.error('[DataRetention] Error:', err.message);
    }
  });

  console.log('[DataRetention] Cron scheduled — daily at 03:00 AM');
}

/**
 * Core enforcement logic — can be called manually or by cron
 */
export async function enforceDataRetention() {
  const results = { warned_7d: 0, warned_1d: 0, deleted_orders: 0, workshops_processed: 0, errors: 0 };

  try {
    // Get all active workshops with their subscription plan
    const workshops = await query(`
      SELECT
        t.id AS workshop_id, t.name, t.email, t.status,
        COALESCE(s.plan, 'trial') AS plan
      FROM workshops t
      LEFT JOIN subscriptions s ON s.workshop_id = t.id
        AND s.status IN ('active','trialing','trial_expired','past_due')
      WHERE t.status NOT IN ('suspended','deleted')
      GROUP BY t.id
    `);

    for (const workshop of workshops) {
      try {
        const retentionDays = PLAN_FEATURES[workshop.plan]?.data_retention_days
          || PLAN_FEATURES.trial.data_retention_days;

        // Skip self-hosted / huge retention periods
        if (retentionDays > 3650) continue;

        // Count work orders that will be affected
        const [oldest] = await query(
          `SELECT MIN(created_at) AS oldest_date, COUNT(*) AS total_old
           FROM work_orders
           WHERE workshop_id = ?
             AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
             AND status IN ('completed','cancelled')`,
          [workshop.workshop_id, retentionDays]
        );

        const oldCount = oldest?.total_old || 0;

        // Phase 1: Delete work orders past the retention period
        if (oldCount > 0) {
          // Delete related data first (parts, status history, etc.)
          await execute(
            `DELETE p FROM parts p
             INNER JOIN work_orders o ON p.work_order_id = o.id
             WHERE o.workshop_id = ?
               AND o.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.status IN ('completed','cancelled')`,
            [workshop.workshop_id, retentionDays]
          );

          await execute(
            `DELETE sh FROM work_order_status_history sh
             INNER JOIN work_orders o ON sh.work_order_id = o.id
             WHERE o.workshop_id = ?
               AND o.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.status IN ('completed','cancelled')`,
            [workshop.workshop_id, retentionDays]
          );

          const delResult = await execute(
            `DELETE FROM work_orders
             WHERE workshop_id = ?
               AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
               AND status IN ('completed','cancelled')`,
            [workshop.workshop_id, retentionDays]
          );

          const deletedCount = delResult?.affectedRows || 0;
          results.deleted_orders += deletedCount;
          console.log(`[DataRetention] Deleted ${deletedCount} work orders for workshop ${workshop.workshop_id} (${workshop.name}) — retention: ${retentionDays} days`);

          // Send deletion notification
          if (workshop.email && deletedCount > 0) {
            try {
              const branding = await getWorkshopBranding(workshop.workshop_id);
              const html = buildEmailTemplate(branding, `
                <h2 style="color:#f59e0b;">Data Retention Notice</h2>
                <p>Hi <strong>${workshop.name}</strong>,</p>
                <p><strong>${deletedCount}</strong> completed work orders older than <strong>${retentionDays} days</strong> have been automatically removed from your account in accordance with your <strong>${workshop.plan}</strong> plan's data retention policy.</p>
                <p>To keep your work order history longer, upgrade to a higher plan:</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
                  <div style="margin-bottom:8px;"><strong>Growth</strong> — 1 year retention</div>
                  <div><strong>Enterprise</strong> — 5 years retention</div>
                </div>
                <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Upgrade Plan</a>
              `);
              await sendEmail({ to: workshop.email, subject: `Data Retention: ${deletedCount} old work orders removed — ${workshop.name}`, html });
            } catch (e) { console.error(`[DataRetention] Email error:`, e.message); }
          }
        }

        // Phase 2: Check for upcoming deletions and send warnings

        // 7-day warning: work orders that will be deleted in 7 days
        const [upcoming7d] = await query(
          `SELECT COUNT(*) AS cnt
           FROM work_orders
           WHERE workshop_id = ?
             AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
             AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             AND status IN ('completed','cancelled')`,
          [workshop.workshop_id, retentionDays - 7, retentionDays]
        );

        if ((upcoming7d?.cnt || 0) > 0 && workshop.email) {
          try {
            const branding = await getWorkshopBranding(workshop.workshop_id);
            const html = buildEmailTemplate(branding, `
              <h2 style="color:#f59e0b;">Upcoming Data Cleanup</h2>
              <p>Hi <strong>${workshop.name}</strong>,</p>
              <p><strong>${upcoming7d.cnt}</strong> completed work orders will be automatically removed from your account within the next <strong>7 days</strong> due to your plan's ${retentionDays}-day data retention policy.</p>
              <p>To preserve your work order history, consider upgrading your plan:</p>
              <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#f97316;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Upgrade Now</a>
              <p style="margin-top:20px;color:#6b7280;">This affects only completed work orders (completed, cancelled). Active work orders are never deleted.</p>
            `);
            await sendEmail({ to: workshop.email, subject: `⚠️ ${upcoming7d.cnt} work orders will be removed in 7 days — ${workshop.name}`, html });
            results.warned_7d++;
          } catch (e) { console.error(`[DataRetention] 7d warning email error:`, e.message); }
        }

        // 1-day warning: work orders that will be deleted tomorrow
        const [upcoming1d] = await query(
          `SELECT COUNT(*) AS cnt
           FROM work_orders
           WHERE workshop_id = ?
             AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
             AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             AND status IN ('completed','cancelled')`,
          [workshop.workshop_id, retentionDays - 1, retentionDays]
        );

        if ((upcoming1d?.cnt || 0) > 0 && workshop.email) {
          try {
            const branding = await getWorkshopBranding(workshop.workshop_id);
            const html = buildEmailTemplate(branding, `
              <h2 style="color:#dc2626;">Final Warning: Data Cleanup Tomorrow</h2>
              <p>Hi <strong>${workshop.name}</strong>,</p>
              <p><strong>${upcoming1d.cnt}</strong> completed work orders will be permanently removed <strong>tomorrow</strong> due to your ${retentionDays}-day data retention limit.</p>
              <p><strong>This action cannot be undone.</strong> Upgrade now to keep your data:</p>
              <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Upgrade Now — Last Chance</a>
            `);
            await sendEmail({ to: workshop.email, subject: `🔴 FINAL: ${upcoming1d.cnt} work orders will be deleted tomorrow — ${workshop.name}`, html });
            results.warned_1d++;
          } catch (e) { console.error(`[DataRetention] 1d warning email error:`, e.message); }
        }

        results.workshops_processed++;
      } catch (workshopErr) {
        console.error(`[DataRetention] Error processing workshop ${workshop.workshop_id}:`, workshopErr.message);
        results.errors++;
      }
    }

    console.log(`[DataRetention] Complete — workshops: ${results.workshops_processed}, deleted: ${results.deleted_orders}, 7d warns: ${results.warned_7d}, 1d warns: ${results.warned_1d}, errors: ${results.errors}`);
    return results;
  } catch (err) {
    console.error('[DataRetention] Fatal error:', err.message);
    throw err;
  }
}
