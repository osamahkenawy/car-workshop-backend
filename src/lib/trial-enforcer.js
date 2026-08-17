/**
 * trial-enforcer.js — Module D.4 Trial Expiry Enforcement
 *
 * Runs a daily cron job that:
 *  1. Checks all subscriptions with status='trialing' and trial_end in the past
 *  2. If trial expired → set subscription status to 'trial_expired', workshop status to 'trial_expired'
 *  3. If trial expired > 7 days → suspend workshop entirely
 *  4. If trial expiring in 1 day → urgent final reminder
 *  5. Sends reminder emails at: day 3 (4 days left), day 6 (1 day left), and day 7 (last day)
 *
 * Also exports a manual trigger for testing.
 */

import cron from 'node-cron';
import { query, execute } from './database.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding } from './email.js';

let cronJob = null;

// Super-admin contact for billing-issue digests & alerts.
// Override via env: SUPER_ADMIN_EMAIL=ops@pioneercarservice.com
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'info@pioneercarservice.com';
// Hard cut-off: after this many days past_due, suspend the workshop.
const PAST_DUE_SUSPEND_AFTER_DAYS = Number(process.env.PAST_DUE_SUSPEND_AFTER_DAYS || 14);

/**
 * Start the daily trial enforcement cron (runs at 2:00 AM server time)
 */
export function startTrialEnforcer() {
  if (cronJob) return; // already running

  // Run daily at 02:00 AM
  cronJob = cron.schedule('0 2 * * *', async () => {
    console.log('[TrialEnforcer] Running daily trial expiry check…');
    try {
      await enforceTrialExpiry();
    } catch (err) {
      console.error('[TrialEnforcer] Error:', err.message);
    }
    try {
      await checkSubscriptionRenewals();
    } catch (err) {
      console.error('[RenewalReminder] Error:', err.message);
    }
    try {
      await enforceCancelledSubscriptions();
    } catch (err) {
      console.error('[CancellationEnforcer] Error:', err.message);
    }
    let pastDueSummary = { reminders: 0, suspended: 0, errors: 0 };
    try {
      pastDueSummary = await enforcePastDueSubscriptions();
    } catch (err) {
      console.error('[PastDueEnforcer] Error:', err.message);
    }
    try {
      await notifySuperAdminDailyDigest({ pastDueSummary });
    } catch (err) {
      console.error('[SuperAdminDigest] Error:', err.message);
    }
  });

  console.log('[TrialEnforcer] Cron scheduled — daily at 02:00 AM (super-admin: ' + SUPER_ADMIN_EMAIL + ')');
}

/**
 * Core enforcement logic — can be called manually or by cron
 */
export async function enforceTrialExpiry() {
  const results = { expired: 0, suspended: 0, warned: 0, reminders: 0, errors: 0 };

  try {
    // ─── Phase 1: Check subscription-based trials (primary source of truth) ───
    const subTrials = await query(`
      SELECT
        s.id AS sub_id, s.workshop_id, s.status AS sub_status, s.trial_end, s.trial_start, s.trial_days,
        DATEDIFF(NOW(), s.trial_end) AS days_overdue,
        DATEDIFF(s.trial_end, NOW()) AS days_remaining,
        t.id AS tid, t.name, t.email, t.slug, t.status AS workshop_status
      FROM subscriptions s
      JOIN workshops t ON t.id = s.workshop_id
      WHERE s.status IN ('trialing', 'trial_expired')
        AND s.trial_end IS NOT NULL
      ORDER BY s.trial_end ASC
    `);

    for (const row of subTrials) {
      try {
        const daysOverdue = row.days_overdue || 0;
        const daysRemaining = row.days_remaining || 0;

        // ── Case A: Trial expired > 7 days → SUSPEND workshop ──
        if (daysOverdue > 7 && row.workshop_status !== 'suspended') {
          // Check if they upgraded to a paid subscription meanwhile
          const [paidSub] = await query(
            "SELECT id FROM subscriptions WHERE workshop_id = ? AND status = 'active' AND plan != 'trial'",
            [row.workshop_id]
          );
          if (!paidSub) {
            await execute("UPDATE subscriptions SET status = 'trial_expired' WHERE id = ?", [row.sub_id]);
            await execute("UPDATE workshops SET status = 'suspended' WHERE id = ?", [row.workshop_id]);
            console.log(`[TrialEnforcer] Suspended workshop ${row.workshop_id} (${row.name}) — trial expired ${daysOverdue} days ago`);
            results.suspended++;

            if (row.email) {
              try {
                const branding = await getWorkshopBranding(row.workshop_id);
                const html = buildEmailTemplate(branding, `
                  <h2 style="color:#dc2626;">Account Suspended</h2>
                  <p>Hi <strong>${row.name}</strong>,</p>
                  <p>Your trial period expired ${daysOverdue} days ago, and your account has been suspended.</p>
                  <p>All API access has been disabled. <strong>Your data is safe and will be preserved</strong> — we never delete workshop data.</p>
                  <p>To restore access, please subscribe to a plan:</p>
                  <a href="https://pioneercarservice.com/pricing" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">View Plans & Subscribe</a>
                  <p style="margin-top:20px;color:#6b7280;">If you have any questions, contact our support team at info@pioneercarservice.com</p>
                `);
                await sendEmail({ to: row.email, subject: `⚠️ Account Suspended — ${row.name}`, html });
              } catch (e) { console.error(`[TrialEnforcer] Suspension email error:`, e.message); }
            }
          }
        }

        // ── Case B: Trial just expired (0-7 days overdue) → mark trial_expired, send grace warning ──
        else if (daysOverdue >= 0 && daysOverdue <= 7 && row.sub_status === 'trialing') {
          // Mark subscription as trial_expired
          await execute("UPDATE subscriptions SET status = 'trial_expired' WHERE id = ?", [row.sub_id]);
          // Also update workshop status if still 'trial'
          if (row.workshop_status === 'trial') {
            await execute("UPDATE workshops SET status = 'trial_expired' WHERE id = ?", [row.workshop_id]);
          }
          console.log(`[TrialEnforcer] Trial expired for workshop ${row.workshop_id} (${row.name}) — ${daysOverdue} days ago`);
          results.expired++;

          if (row.email) {
            try {
              const graceDaysLeft = 7 - daysOverdue;
              const branding = await getWorkshopBranding(row.workshop_id);
              const html = buildEmailTemplate(branding, `
                <h2 style="color:#f59e0b;">Your Free Trial Has Ended</h2>
                <p>Hi <strong>${row.name}</strong>,</p>
                <p>Your 7-day free trial has ended. Your account access has been restricted.</p>
                ${graceDaysLeft > 0 ? `<p>You have <strong>${graceDaysLeft} day(s)</strong> before your account is fully suspended.</p>` : ''}
                <p><strong>Your data is safe</strong> — we'll never delete your workshop data.</p>
                <p>Subscribe now to restore full access:</p>
                <a href="https://pioneercarservice.com/pricing" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Upgrade Now</a>
              `);
              await sendEmail({ to: row.email, subject: `🚫 Trial Ended — Upgrade to Continue`, html });
            } catch (e) { console.error(`[TrialEnforcer] Expiry email error:`, e.message); }
          }
        }

        // ── Case C: Already trial_expired, send DAILY grace warnings (every day 1-7) ──
        else if (row.sub_status === 'trial_expired' && daysOverdue >= 1 && daysOverdue <= 7) {
          if (row.email) {
            const graceDaysLeft = 7 - daysOverdue;
            results.warned++;
            try {
              const branding = await getWorkshopBranding(row.workshop_id);
              const html = buildEmailTemplate(branding, `
                <h2 style="color:#dc2626;">Account Suspension Warning</h2>
                <p>Hi <strong>${row.name}</strong>,</p>
                <p>Your trial expired ${daysOverdue} days ago. ${graceDaysLeft > 0 ? `Your account will be fully suspended in <strong>${graceDaysLeft} day(s)</strong>.` : 'Your account will be suspended today.'}</p>
                <p>Subscribe to keep your data accessible:</p>
                <a href="https://pioneercarservice.com/pricing" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Subscribe Now — Urgent</a>
              `);
              await sendEmail({ to: row.email, subject: `🔴 ${graceDaysLeft > 0 ? `${graceDaysLeft} day(s) left` : 'Last chance'} — Subscribe to avoid suspension`, html });
            } catch (e) { console.error(`[TrialEnforcer] Grace email error:`, e.message); }
          }
        }

        // ── Case D: Trial still active, expiring soon → REMINDERS (day 3, 6, 7 of trial) ──
        else if (daysRemaining > 0 && daysRemaining <= 4 && row.sub_status === 'trialing') {
          // Send reminders: 4 days left (day 3), 1 day left (day 6), last day (day 7)
          if ([1, 2, 4].includes(daysRemaining) && row.email) {
            results.reminders++;
            const dayOfTrial = (row.trial_days || 7) - daysRemaining;
            try {
              const branding = await getWorkshopBranding(row.workshop_id);
              const urgency = daysRemaining <= 1 ? '#dc2626' : '#f59e0b';
              const html = buildEmailTemplate(branding, `
                <h2 style="color:${urgency};">Trial Expiring ${daysRemaining === 1 ? 'Tomorrow' : `in ${daysRemaining} Days`}</h2>
                <p>Hi <strong>${row.name}</strong>,</p>
                <p>Your free trial ${daysRemaining === 1 ? 'expires <strong>tomorrow</strong>' : `expires in <strong>${daysRemaining} day(s)</strong>`}.</p>
                <p>Don't lose access — upgrade now to keep all your data and settings:</p>
                <a href="https://pioneercarservice.com/pricing" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Choose a Plan</a>
                <p style="margin-top:20px;color:#6b7280;">If you have any questions, we're here to help.</p>
              `);
              await sendEmail({ to: row.email, subject: `🔔 Trial expires in ${daysRemaining} day(s) — ${row.name}`, html });
            } catch (e) { console.error(`[TrialEnforcer] Reminder email error:`, e.message); }
          }
        }

      } catch (workshopErr) {
        console.error(`[TrialEnforcer] Error processing workshop ${row.workshop_id}:`, workshopErr.message);
        results.errors++;
      }
    }

    // ─── Phase 2: Legacy fallback — check workshops.trial_ends_at for any missed ───
    const legacyTrials = await query(`
      SELECT t.id, t.name, t.email, t.slug, t.status, t.trial_ends_at,
             DATEDIFF(NOW(), t.trial_ends_at) AS days_overdue
      FROM workshops t
      WHERE t.status = 'trial'
        AND t.trial_ends_at IS NOT NULL
        AND t.trial_ends_at < NOW()
        AND t.id NOT IN (
          SELECT workshop_id FROM subscriptions WHERE status IN ('trialing', 'trial_expired', 'active')
        )
    `);

    for (const workshop of legacyTrials) {
      try {
        if (workshop.days_overdue > 7) {
          await execute("UPDATE workshops SET status = 'suspended' WHERE id = ?", [workshop.id]);
          results.suspended++;
          console.log(`[TrialEnforcer] Legacy suspend: workshop ${workshop.id} (${workshop.name})`);
        } else {
          await execute("UPDATE workshops SET status = 'trial_expired' WHERE id = ?", [workshop.id]);
          results.expired++;
          console.log(`[TrialEnforcer] Legacy expire: workshop ${workshop.id} (${workshop.name})`);
        }
      } catch (e) {
        console.error(`[TrialEnforcer] Legacy error:`, e.message);
        results.errors++;
      }
    }

    console.log(`[TrialEnforcer] Complete — expired: ${results.expired}, suspended: ${results.suspended}, warned: ${results.warned}, reminders: ${results.reminders}, errors: ${results.errors}`);
    return results;
  } catch (err) {
    console.error('[TrialEnforcer] Fatal error:', err.message);
    throw err;
  }
}

/**
 * Check paid subscriptions approaching renewal and send reminder emails.
 * Sends reminders at: 7 days before, 3 days before, and 1 day before renewal.
 * Runs daily alongside trial enforcement.
 */
async function checkSubscriptionRenewals() {
  const results = { reminders: 0, errors: 0 };
  try {
    const subs = await query(`
      SELECT s.id, s.workshop_id, s.plan, s.billing_cycle, s.price_monthly, s.price_yearly,
             s.current_period_end,
             DATEDIFF(s.current_period_end, NOW()) AS days_until_renewal,
             t.name AS workshop_name, t.email AS workshop_email, t.currency
      FROM subscriptions s
      JOIN workshops t ON t.id = s.workshop_id
      WHERE s.status = 'active'
        AND s.plan != 'trial'
        AND s.current_period_end IS NOT NULL
        AND DATEDIFF(s.current_period_end, NOW()) IN (1, 3, 7)
    `);

    for (const sub of subs) {
      if (!sub.workshop_email) continue;
      try {
        const amount = sub.billing_cycle === 'yearly' ? sub.price_yearly : sub.price_monthly;
        const periodLabel = sub.billing_cycle === 'yearly' ? 'annual' : 'monthly';
        const renewDate = new Date(sub.current_period_end).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        const branding = await getWorkshopBranding(sub.workshop_id);
        const urgency = sub.days_until_renewal <= 1 ? '#f59e0b' : '#2563eb';
        const html = buildEmailTemplate(branding, `
          <h2 style="color:${urgency};">Subscription Renewing ${sub.days_until_renewal === 1 ? 'Tomorrow' : `in ${sub.days_until_renewal} Days`}</h2>
          <p>Hi <strong>${sub.workshop_name}</strong>,</p>
          <p>Your <strong>${periodLabel}</strong> subscription will renew on <strong>${renewDate}</strong>.</p>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
            <div style="margin-bottom:8px;"><span style="color:#6b7280;">Plan:</span> <strong>${sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)}</strong></div>
            <div style="margin-bottom:8px;"><span style="color:#6b7280;">Cycle:</span> <strong>${sub.billing_cycle === 'yearly' ? 'Annual (15% off)' : 'Monthly'}</strong></div>
            <div><span style="color:#6b7280;">Amount:</span> <strong style="color:#f97316;">${sub.currency || 'AED'} ${Number(amount).toFixed(2)}</strong></div>
          </div>
          <p>Your payment method will be charged automatically. To update payment or change plans:</p>
          <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Manage Subscription</a>
          <p style="margin-top:20px;color:#6b7280;">Questions? Contact support@pioneercarservice.com</p>
        `);
        await sendEmail({
          to: sub.workshop_email,
          subject: `Subscription renews ${sub.days_until_renewal === 1 ? 'tomorrow' : `in ${sub.days_until_renewal} days`} — ${sub.workshop_name}`,
          html
        });
        results.reminders++;
        console.log(`[RenewalReminder] Sent ${sub.days_until_renewal}-day reminder to workshop ${sub.workshop_id} (${sub.workshop_name})`);
      } catch (e) {
        console.error(`[RenewalReminder] Error for workshop ${sub.workshop_id}:`, e.message);
        results.errors++;
      }
    }

    if (results.reminders > 0) {
      console.log(`[RenewalReminder] Sent ${results.reminders} renewal reminders, ${results.errors} errors`);
    }
  } catch (err) {
    console.error('[RenewalReminder] Fatal error:', err.message);
  }
  return results;
}

/**
 * Safety net for cancelled paid subscriptions.
 * Catches cases where Stripe webhook (customer.subscription.deleted) was missed.
 * 1. Subscriptions with cancel_at_period_end=1 and cancel_at in the past → mark cancelled
 * 2. Cancelled subscriptions where workshop is still active → fix workshop status
 */
async function enforceCancelledSubscriptions() {
  const results = { cancelled: 0, workshopFixed: 0, deactivated: 0, errors: 0 };

  try {
    // Phase 1: Subscriptions past their cancel_at date that weren't processed
    const pastCancel = await query(`
      SELECT s.id, s.workshop_id, s.stripe_subscription_id, t.name, t.email
      FROM subscriptions s
      JOIN workshops t ON t.id = s.workshop_id
      WHERE (s.cancel_at_period_end = 1 OR s.cancel_at IS NOT NULL)
        AND s.cancel_at IS NOT NULL
        AND s.cancel_at < NOW()
        AND s.status = 'active'
    `);

    for (const row of pastCancel) {
      try {
        await execute(
          "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancel_at_period_end = 0 WHERE id = ?",
          [row.id]
        );
        results.cancelled++;
        console.log(`[CancellationEnforcer] Force-cancelled subscription ${row.id} for workshop ${row.workshop_id} (missed webhook)`);
      } catch (e) {
        console.error(`[CancellationEnforcer] Error cancelling sub ${row.id}:`, e.message);
        results.errors++;
      }
    }

    // Phase 2: Workshops still 'active' but all subscriptions are cancelled
    const orphanedWorkshops = await query(`
      SELECT t.id, t.name, t.email
      FROM workshops t
      WHERE t.status = 'active'
        AND t.id IN (SELECT workshop_id FROM subscriptions WHERE status = 'cancelled')
        AND t.id NOT IN (SELECT workshop_id FROM subscriptions WHERE status IN ('active', 'trialing', 'past_due'))
    `);

    for (const workshop of orphanedWorkshops) {
      try {
        await execute("UPDATE workshops SET status = 'cancelled' WHERE id = ?", [workshop.id]);
        await execute("UPDATE users SET is_active = 0 WHERE workshop_id = ? AND role != 'admin'", [workshop.id]);
        results.workshopFixed++;
        results.deactivated++;
        console.log(`[CancellationEnforcer] Fixed orphaned workshop ${workshop.id} (${workshop.name}) — set to cancelled`);
      } catch (e) {
        console.error(`[CancellationEnforcer] Error fixing workshop ${workshop.id}:`, e.message);
        results.errors++;
      }
    }

    if (results.cancelled > 0 || results.workshopFixed > 0) {
      console.log(`[CancellationEnforcer] Complete — cancelled: ${results.cancelled}, workshops fixed: ${results.workshopFixed}, errors: ${results.errors}`);
    }
  } catch (err) {
    console.error('[CancellationEnforcer] Fatal error:', err.message);
  }
  return results;
}

/**
 * Daily dunning for paid subscriptions in `past_due` (failed payment).
 *
 * Logic per workshop:
 *  - Compute days_past_due = days since current_period_end (or updated_at if no period_end).
 *  - Day 1..PAST_DUE_SUSPEND_AFTER_DAYS: send a DAILY reminder email to the workshop
 *    asking them to update their payment method / retry payment.
 *  - After PAST_DUE_SUSPEND_AFTER_DAYS days: mark subscription `suspended`,
 *    update workshop status to `suspended`, and send a final notice.
 */
export async function enforcePastDueSubscriptions() {
  const results = { reminders: 0, suspended: 0, errors: 0, tenants: [] };
  try {
    const rows = await query(`
      SELECT s.id AS sub_id, s.workshop_id, s.plan, s.billing_cycle,
             s.price_monthly, s.price_yearly,
             s.current_period_end, s.updated_at,
             GREATEST(
               DATEDIFF(NOW(), COALESCE(s.current_period_end, s.updated_at)),
               1
             ) AS days_past_due,
             t.name AS workshop_name, t.email AS workshop_email,
             t.status AS workshop_status, t.currency
      FROM subscriptions s
      JOIN workshops t ON t.id = s.workshop_id
      WHERE s.status = 'past_due'
      ORDER BY s.updated_at ASC
    `);

    for (const row of rows) {
      try {
        const daysPastDue = Number(row.days_past_due) || 1;
        const amount = row.billing_cycle === 'yearly' ? row.price_yearly : row.price_monthly;
        const periodLabel = row.billing_cycle === 'yearly' ? 'annual' : 'monthly';
        const planLabel = (row.plan || '').charAt(0).toUpperCase() + (row.plan || '').slice(1);

        // ── Suspend after grace window ──
        if (daysPastDue > PAST_DUE_SUSPEND_AFTER_DAYS) {
          await execute("UPDATE subscriptions SET status = 'suspended' WHERE id = ?", [row.sub_id]);
          if (row.workshop_status !== 'suspended') {
            await execute("UPDATE workshops SET status = 'suspended' WHERE id = ?", [row.workshop_id]);
          }
          results.suspended++;
          console.log(`[PastDueEnforcer] Suspended workshop ${row.workshop_id} (${row.workshop_name}) — ${daysPastDue} days past due`);

          if (row.workshop_email) {
            try {
              const branding = await getWorkshopBranding(row.workshop_id);
              const html = buildEmailTemplate(branding, `
                <h2 style="color:#dc2626;">Account Suspended — Payment Failed</h2>
                <p>Hi <strong>${row.workshop_name}</strong>,</p>
                <p>We were unable to charge your payment method for <strong>${daysPastDue} consecutive days</strong>. Your account is now suspended.</p>
                <p>Your data is safe. To restore service, please update your payment method:</p>
                <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Update Payment Method</a>
                <p style="margin-top:20px;color:#6b7280;">Need help? Contact us at info@pioneercarservice.com</p>
              `);
              await sendEmail({ to: row.workshop_email, subject: `🚫 Account Suspended — Payment Failed (${row.workshop_name})`, html });
            } catch (e) { console.error('[PastDueEnforcer] Suspend email error:', e.message); }
          }
          results.tenants.push({ ...row, days_past_due: daysPastDue, action: 'suspended' });
          continue;
        }

        // ── Daily reminder ──
        if (row.workshop_email) {
          try {
            const daysLeft = PAST_DUE_SUSPEND_AFTER_DAYS - daysPastDue;
            const branding = await getWorkshopBranding(row.workshop_id);
            const html = buildEmailTemplate(branding, `
              <h2 style="color:#dc2626;">Payment Failed — Action Required</h2>
              <p>Hi <strong>${row.workshop_name}</strong>,</p>
              <p>We were unable to process the latest payment for your <strong>${planLabel}</strong> ${periodLabel} subscription
              ${amount ? `(<strong>${row.currency || 'AED'} ${Number(amount).toFixed(2)}</strong>)` : ''}.</p>
              <p>This is day <strong>${daysPastDue}</strong> past due.
              Your account will be <strong>suspended in ${daysLeft} day(s)</strong> if payment is not received.</p>
              <p>Please update your payment method or retry the charge:</p>
              <a href="https://dispatch.pioneercarservice.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Update Payment Method</a>
              <p style="margin-top:20px;color:#6b7280;">If you've already updated your card, you can ignore this message — Stripe will retry automatically.</p>
              <p style="color:#6b7280;">Questions? Contact us at info@pioneercarservice.com</p>
            `);
            await sendEmail({
              to: row.workshop_email,
              subject: `🔴 Payment Failed — ${daysPastDue} day(s) past due — ${row.workshop_name}`,
              html
            });
            results.reminders++;
          } catch (e) {
            console.error(`[PastDueEnforcer] Reminder email error for workshop ${row.workshop_id}:`, e.message);
            results.errors++;
          }
        }
        results.tenants.push({ ...row, days_past_due: daysPastDue, action: 'reminder' });
      } catch (e) {
        console.error(`[PastDueEnforcer] Error for workshop ${row.workshop_id}:`, e.message);
        results.errors++;
      }
    }

    if (results.reminders > 0 || results.suspended > 0) {
      console.log(`[PastDueEnforcer] Complete — reminders: ${results.reminders}, suspended: ${results.suspended}, errors: ${results.errors}`);
    }
  } catch (err) {
    console.error('[PastDueEnforcer] Fatal error:', err.message);
  }
  return results;
}

/**
 * Daily digest email to the super admin (info@pioneercarservice.com by default).
 * Lists every workshop currently in a billing-issue state:
 *  - past_due (payment failed)
 *  - trial_expired
 *  - suspended
 *
 * Sent every day, even if list is empty (so the admin knows the cron is alive).
 * Set SUPER_ADMIN_DIGEST_SKIP_EMPTY=1 to skip empty digests.
 */
export async function notifySuperAdminDailyDigest({ pastDueSummary } = {}) {
  try {
    const pastDue = await query(`
      SELECT s.id AS sub_id, s.workshop_id, s.plan, s.billing_cycle, s.current_period_end,
             GREATEST(DATEDIFF(NOW(), COALESCE(s.current_period_end, s.updated_at)), 1) AS days_overdue,
             t.name AS workshop_name, t.email AS workshop_email
      FROM subscriptions s JOIN workshops t ON t.id = s.workshop_id
      WHERE s.status = 'past_due'
      ORDER BY days_overdue DESC
    `);
    const trialExpired = await query(`
      SELECT s.workshop_id, s.trial_end,
             DATEDIFF(NOW(), s.trial_end) AS days_overdue,
             t.name AS workshop_name, t.email AS workshop_email
      FROM subscriptions s JOIN workshops t ON t.id = s.workshop_id
      WHERE s.status = 'trial_expired'
      ORDER BY days_overdue DESC
    `);
    const suspended = await query(`
      SELECT t.id AS workshop_id, t.name AS workshop_name, t.email AS workshop_email,
             s.plan, s.status AS sub_status, s.updated_at,
             DATEDIFF(NOW(), s.updated_at) AS days_suspended
      FROM workshops t
      LEFT JOIN subscriptions s ON s.workshop_id = t.id
      WHERE t.status = 'suspended'
      ORDER BY days_suspended DESC
    `);

    const total = pastDue.length + trialExpired.length + suspended.length;
    if (total === 0 && process.env.SUPER_ADMIN_DIGEST_SKIP_EMPTY === '1') {
      console.log('[SuperAdminDigest] No issues to report — skipping empty digest');
      return { sent: false, total: 0 };
    }

    const renderTable = (title, rows, columns) => {
      if (!rows.length) return `<h3 style="margin-top:24px;color:#16a34a;">✅ ${title}: none</h3>`;
      const head = columns.map(c => `<th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;text-transform:uppercase;">${c.label}</th>`).join('');
      const body = rows.map(r => `<tr>${columns.map(c => `<td style="padding:8px;border-bottom:1px solid #f3f4f6;font-size:13px;">${c.value(r) ?? '—'}</td>`).join('')}</tr>`).join('');
      return `
        <h3 style="margin-top:24px;color:#dc2626;">⚠️ ${title} (${rows.length})</h3>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>`;
    };

    const html = buildEmailTemplate(null, `
      <h2 style="color:#111827;">Daily Billing Issues Digest</h2>
      <p style="color:#6b7280;">${new Date().toUTCString()}</p>
      <p>Total workshops requiring attention: <strong>${total}</strong></p>
      ${renderTable('Past Due (payment failed)', pastDue, [
        { label: 'Workshop', value: r => `<strong>${r.workshop_name}</strong><br><span style="color:#6b7280;font-size:11px;">${r.workshop_email || ''}</span>` },
        { label: 'Plan', value: r => `${r.plan} / ${r.billing_cycle}` },
        { label: 'Days overdue', value: r => `<span style="color:#dc2626;font-weight:600;">${r.days_overdue}</span>` },
        { label: 'Period end', value: r => r.current_period_end ? new Date(r.current_period_end).toISOString().slice(0, 10) : '—' },
      ])}
      ${renderTable('Trial Expired', trialExpired, [
        { label: 'Workshop', value: r => `<strong>${r.workshop_name}</strong><br><span style="color:#6b7280;font-size:11px;">${r.workshop_email || ''}</span>` },
        { label: 'Trial end', value: r => r.trial_end ? new Date(r.trial_end).toISOString().slice(0, 10) : '—' },
        { label: 'Days overdue', value: r => `<span style="color:#dc2626;font-weight:600;">${r.days_overdue}</span>` },
      ])}
      ${renderTable('Suspended', suspended, [
        { label: 'Workshop', value: r => `<strong>${r.workshop_name}</strong><br><span style="color:#6b7280;font-size:11px;">${r.workshop_email || ''}</span>` },
        { label: 'Plan', value: r => r.plan || '—' },
        { label: 'Days suspended', value: r => r.days_suspended ?? '—' },
      ])}
      ${pastDueSummary ? `
        <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">
        <p style="color:#6b7280;font-size:12px;">Today's dunning run: sent <strong>${pastDueSummary.reminders}</strong> reminder email(s), suspended <strong>${pastDueSummary.suspended}</strong> workshop(s), errors: <strong>${pastDueSummary.errors}</strong>.</p>` : ''}
    `);

    await sendEmail({
      to: SUPER_ADMIN_EMAIL,
      subject: `[Pioneer Billing] Daily digest — ${total} workshop(s) need attention`,
      html
    });
    console.log(`[SuperAdminDigest] Sent daily digest to ${SUPER_ADMIN_EMAIL} — ${total} workshops flagged`);
    return { sent: true, total, pastDue: pastDue.length, trialExpired: trialExpired.length, suspended: suspended.length };
  } catch (err) {
    console.error('[SuperAdminDigest] Error:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Real-time alert to super admin when a payment fails (called from Stripe webhook).
 * Keeps the admin in the loop the moment Stripe reports the failure.
 */
export async function notifySuperAdminPaymentFailed({ tenantId, tenantName, tenantEmail, plan, billingCycle, amount, currency, attemptCount, nextPaymentAttempt, hostedInvoiceUrl }) {
  try {
    const html = buildEmailTemplate(null, `
      <h2 style="color:#dc2626;">Payment Failed</h2>
      <p>A subscription payment just failed and the workshop has been moved to <strong>past_due</strong>.</p>
      <table style="border-collapse:collapse;margin-top:8px;">
        <tr><td style="padding:6px 12px;color:#6b7280;">Workshop:</td><td style="padding:6px 12px;"><strong>${tenantName || tenantId}</strong></td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Email:</td><td style="padding:6px 12px;">${tenantEmail || '—'}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Plan:</td><td style="padding:6px 12px;">${plan || '—'} / ${billingCycle || '—'}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Amount:</td><td style="padding:6px 12px;">${amount ? `${currency || 'AED'} ${Number(amount).toFixed(2)}` : '—'}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Attempt #:</td><td style="padding:6px 12px;">${attemptCount ?? '—'}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7280;">Next retry:</td><td style="padding:6px 12px;">${nextPaymentAttempt ? new Date(nextPaymentAttempt * 1000).toUTCString() : '—'}</td></tr>
      </table>
      ${hostedInvoiceUrl ? `<p style="margin-top:16px;"><a href="${hostedInvoiceUrl}" style="color:#2563eb;">View invoice in Stripe →</a></p>` : ''}
      <p style="color:#6b7280;font-size:12px;margin-top:16px;">Daily reminder emails to the customer will continue automatically. The workshop will be auto-suspended after ${PAST_DUE_SUSPEND_AFTER_DAYS} days past due.</p>
    `);
    await sendEmail({
      to: SUPER_ADMIN_EMAIL,
      subject: `[Pioneer Billing] Payment failed — ${tenantName || tenantId}`,
      html
    });
    console.log(`[SuperAdminAlert] Sent payment-failed alert to ${SUPER_ADMIN_EMAIL} for workshop ${tenantId}`);
  } catch (err) {
    console.error('[SuperAdminAlert] Error:', err.message);
  }
}

export function stopTrialEnforcer() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[TrialEnforcer] Cron stopped');
  }
}
