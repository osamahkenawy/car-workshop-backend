/**
 * sms.js — SMS sending helper
 *
 * Call shape observed in the already-ported routes/notifications.js:
 *   const result = await sendSMS(phone, message);
 *   // result.success (bool), result.sid (provider message id), result.error (string)
 *
 * We also accept the object form `sendSMS({ to, message, workshopId })` for
 * flexibility from other call sites, since both are reasonable API shapes.
 *
 * If no SMS provider is configured (config.sms is unset, or missing
 * accountSid/authToken), we stub the send: log to console and resolve
 * `{ success: true, stub: true }` so local dev / CI never breaks on a
 * missing Twilio account.
 */

import { config } from '../config.js';

/**
 * Simple {{key}} mustache-lite template interpolation.
 * Replaces every {{key}} occurrence with vars[key]; if vars[key] is
 * undefined, the placeholder is replaced with an empty string (rather than
 * left dangling in a message sent to a customer).
 *
 * @param {string} template
 * @param {Record<string, any>} vars
 * @returns {string}
 */
export function interpolate(template, vars = {}) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = vars?.[key];
    return value != null ? String(value) : '';
  });
}

function isTwilioConfigured() {
  const sms = config?.sms;
  return !!(sms && sms.provider === 'twilio' && sms.accountSid && sms.authToken && sms.fromNumber);
}

async function sendViaTwilio(to, message) {
  try {
    // Dynamic import so a missing 'twilio' package never crashes module load.
    const twilioModule = await import('twilio').catch(() => null);
    if (!twilioModule) {
      console.warn('[SMS] Twilio configured but the "twilio" package is not installed — falling back to stub.');
      return { success: true, stub: true };
    }

    const twilioFactory = twilioModule.default || twilioModule;
    const client = twilioFactory(config.sms.accountSid, config.sms.authToken);

    const result = await client.messages.create({
      to,
      from: config.sms.fromNumber,
      body: message,
    });

    return { success: true, sid: result.sid };
  } catch (err) {
    console.error('[SMS] Twilio send error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send an SMS. Supports both:
 *   sendSMS(phone, message)
 *   sendSMS({ to, message, workshopId })
 *
 * @returns {Promise<{success: boolean, sid?: string, error?: string, stub?: boolean}>}
 */
export async function sendSMS(arg1, arg2) {
  let to, message;
  if (typeof arg1 === 'object' && arg1 !== null) {
    ({ to, message } = arg1);
  } else {
    to = arg1;
    message = arg2;
  }

  if (!to || !message) {
    return { success: false, error: 'to and message are required' };
  }

  if (!isTwilioConfigured()) {
    console.log('[SMS STUB]', to, message);
    return { success: true, stub: true };
  }

  return sendViaTwilio(to, message);
}

export default { sendSMS, interpolate };
