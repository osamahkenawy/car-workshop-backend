/**
 * survey-trigger.js — issues a satisfaction survey automatically when a job
 * closes, which is what the CX SOP ("the survey issues automatically on job
 * closure") describes. Until now invites were only ever minted by hand via
 * POST /api/customer-survey/invites, and that route sends nothing — it hands
 * staff a link to copy.
 *
 * Configuration lives in the existing `settings` key-value table under
 * `survey_auto_issue` (type json), so there is no new table and no new
 * settings endpoint: PUT /api/settings already upserts arbitrary keys.
 *
 * "Per branch" needs no branch column: a branch IS its own `workshops` row in
 * this schema (car_workshop.sql: "WORKSHOPS (workshop branches/locations)"),
 * and `settings` is unique on (workshop_id, key). So a setting saved while
 * signed into a branch applies to that branch only, which is exactly the
 * SOP's "check the trigger is active for your branch".
 *
 * Channels: email and SMS both have working senders (lib/email.js,
 * lib/sms.js). WhatsApp deliberately is NOT offered — there is no WhatsApp
 * sender anywhere in the codebase, only a `channel` enum value, and a toggle
 * that silently did nothing would be worse than not having it.
 *
 * Never throws. Callers sit in a work-order status transition and must not
 * fail the transition because a survey could not be sent, so every outcome
 * comes back as a result object and is logged.
 */
import crypto from 'crypto';
import { query, execute } from './database.js';
import { config } from '../config.js';
import { sendEmail } from './email.js';
import { sendSMS } from './sms.js';

export const SURVEY_AUTO_ISSUE_KEY = 'survey_auto_issue';

/** Off by default: enabling it starts messaging real customers. */
export const SURVEY_AUTO_ISSUE_DEFAULTS = {
  enabled: false,
  channel: 'email',      // 'email' | 'sms'
  expires_in_days: 30,
};

const SUPPORTED_CHANNELS = ['email', 'sms'];

export async function getSurveyAutoIssueConfig(workshopId) {
  const [row] = await query(
    'SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = ? LIMIT 1',
    [workshopId, SURVEY_AUTO_ISSUE_KEY]
  );
  if (!row?.value) return { ...SURVEY_AUTO_ISSUE_DEFAULTS };
  try {
    const parsed = JSON.parse(row.value);
    return { ...SURVEY_AUTO_ISSUE_DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...SURVEY_AUTO_ISSUE_DEFAULTS };
  }
}

function surveyUrl(token) {
  return `${String(config.frontendUrl).replace(/\/+$/, '')}/survey/${token}`;
}

function inviteEmail({ workshopName, contactName, url }) {
  const who = contactName ? `Dear ${contactName},` : 'Hello,';
  return {
    subject: `How did we do? — ${workshopName}`,
    text: `${who}\n\nThank you for choosing ${workshopName}. Your vehicle service is complete.\n\n`
      + `We would appreciate two minutes of your time to tell us how we did:\n${url}\n\n`
      + `Thank you,\n${workshopName}`,
    html: `<p>${who}</p>
<p>Thank you for choosing <strong>${workshopName}</strong>. Your vehicle service is now complete.</p>
<p>We would appreciate two minutes of your time to tell us how we did.</p>
<p><a href="${url}" style="display:inline-block;padding:12px 22px;background:#1e3a6b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Rate your service</a></p>
<p style="color:#7d8494;font-size:13px">Or open this link: <a href="${url}">${url}</a></p>
<p>Thank you,<br>${workshopName}</p>`,
  };
}

/**
 * Called on a work order reaching 'completed'.
 *
 * Takes an id rather than a work-order object on purpose: the three code
 * paths that close a job each SELECT a different subset of columns (the QR
 * completion scan in service-status.js doesn't read customer_id at all), so
 * loading the fields here keeps the trigger from depending on the caller's
 * query shape.
 *
 * @returns {Promise<{issued: boolean, skipped?: string, channel?: string, token?: string, error?: string}>}
 */
export async function issueSurveyOnClosure({ workOrderId, workshopId }) {
  try {
    if (!workOrderId || !workshopId) return { issued: false, skipped: 'bad_input' };

    const cfg = await getSurveyAutoIssueConfig(workshopId);
    if (!cfg.enabled) return { issued: false, skipped: 'disabled' };

    const channel = SUPPORTED_CHANNELS.includes(cfg.channel) ? cfg.channel : null;
    if (!channel) {
      console.warn(`[SurveyTrigger] WO ${workOrderId}: channel '${cfg.channel}' has no sender — skipping`);
      return { issued: false, skipped: 'unsupported_channel' };
    }

    // One survey per job. Staff can still mint extra links by hand if needed.
    const [already] = await query(
      'SELECT id FROM survey_invites WHERE work_order_id = ? AND workshop_id = ? LIMIT 1',
      [workOrderId, workshopId]
    );
    if (already) return { issued: false, skipped: 'already_issued' };

    // The work order carries name/phone; email only lives on the customer.
    const [workOrder] = await query(
      `SELECT w.id, w.customer_id, w.customer_name, w.customer_phone, w.service_category,
              c.email AS customer_email
         FROM work_orders w
         LEFT JOIN customers c ON c.id = w.customer_id
        WHERE w.id = ? AND w.workshop_id = ? LIMIT 1`,
      [workOrderId, workshopId]
    );
    if (!workOrder) return { issued: false, skipped: 'work_order_not_found' };

    const contactEmail = workOrder.customer_email || null;
    const contactName = workOrder.customer_name || null;
    const contactPhone = workOrder.customer_phone || null;

    const destination = channel === 'email' ? contactEmail : contactPhone;
    if (!destination || destination === '-') {
      console.warn(`[SurveyTrigger] WO ${workOrderId}: no ${channel} address for the customer — skipping`);
      return { issued: false, skipped: `no_${channel}` };
    }

    const [workshop] = await query('SELECT name FROM workshops WHERE id = ?', [workshopId]);
    const workshopName = workshop?.name || 'our service centre';

    const token = crypto.randomBytes(24).toString('hex');
    const days = Number.isFinite(Number(cfg.expires_in_days)) ? Number(cfg.expires_in_days) : 30;

    // sent_at is left NULL until the send actually succeeds — the manual
    // invites route stamps NOW() regardless, which makes an unsent link look
    // delivered. Not repeating that here.
    // Stamp the branch. The public submit carries invite.branch onto the
    // response (customer-survey.js: pick(body.branch, invite?.branch)), and
    // responses having no branch is exactly why the by-branch breakdowns are
    // switched off in CustomerFeedback.jsx — every row read "Unspecified".
    // Auto-issued invites know their branch for free, since a branch is a
    // workshops row here.
    const result = await execute(
      `INSERT INTO survey_invites
         (workshop_id, token, work_order_id, customer_id, contact_name, contact_phone,
          contact_email, branch, service_requested, channel, sent_by, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, NULL, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        workshopId, token, workOrderId, workOrder.customer_id || null,
        contactName, contactPhone, contactEmail,
        workshopName, workOrder.service_category || null, channel, days,
      ]
    );

    const url = surveyUrl(token);
    let sendResult;
    if (channel === 'email') {
      const msg = inviteEmail({ workshopName, contactName, url });
      sendResult = await sendEmail({ to: destination, tenantId: workshopId, ...msg });
    } else {
      sendResult = await sendSMS({
        to: destination,
        message: `${workshopName}: your service is complete. Tell us how we did — ${url}`,
      });
    }

    if (sendResult?.success) {
      await execute('UPDATE survey_invites SET sent_at = NOW() WHERE id = ?', [result.insertId]);
      console.log(`[SurveyTrigger] WO ${workOrderId}: survey issued by ${channel}`);
      return { issued: true, channel, token };
    }

    // The row stays with sent_at NULL so an undelivered invite is visible
    // rather than silently counted as issued.
    console.warn(`[SurveyTrigger] WO ${workOrderId}: invite created but ${channel} send failed — ${sendResult?.error || 'unknown error'}`);
    return { issued: false, skipped: 'send_failed', channel, token, error: sendResult?.error };
  } catch (err) {
    console.error('[SurveyTrigger] failed:', err.message);
    return { issued: false, skipped: 'error', error: err.message };
  }
}
