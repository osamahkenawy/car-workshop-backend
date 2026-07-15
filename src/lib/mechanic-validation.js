/**
 * mechanic-validation.js (renamed from driver-validation.js)
 *
 * Validation helpers for the mechanics module. Call-site shape (matched
 * against how the already-ported src/routes/mechanics.js and
 * src/routes/mechanic-app.js use these):
 *
 *   const ph = validatePhone(phone);
 *   if (!ph.ok) return res.status(400).json({ success: false, message: ph.message });
 *   const normalizedPhone = ph.value;
 *
 *   const v = validateStatus(status);
 *   if (!v.ok) return res.status(400).json({ success: false, message: v.message });
 *
 * Both functions return a `{ ok, message, value }` result object (rather
 * than a plain boolean) so callers can surface a specific validation error
 * message and, for phone, a normalized value in one step.
 */

// UAE-style / general E.164 phone format: + followed by 8–15 digits.
const E164_RE = /^\+[1-9]\d{7,14}$/;

export const VALID_MECHANIC_STATUSES = ['available', 'busy', 'offline', 'on_break'];

/**
 * Validate (and lightly normalize) a phone number.
 * Accepts numbers already in E.164 form, or UAE local numbers starting with
 * '0' that we normalize to +971.
 *
 * @param {string} phone
 * @returns {{ok: boolean, message?: string, value?: string}}
 */
export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { ok: false, message: 'Phone number is required' };
  }

  let normalized = phone.trim().replace(/[\s-]/g, '');

  // Normalize common UAE local formats (0501234567 → +971501234567)
  if (/^0\d{8,9}$/.test(normalized)) {
    normalized = `+971${normalized.slice(1)}`;
  }

  if (!E164_RE.test(normalized)) {
    return {
      ok: false,
      message: 'Phone must be in E.164 format (e.g. +971501234567)',
    };
  }

  return { ok: true, value: normalized };
}

/**
 * Validate a mechanic status against the allowed ENUM values.
 *
 * @param {string} status
 * @returns {{ok: boolean, message?: string}}
 */
export function validateStatus(status) {
  if (!status || typeof status !== 'string') {
    return { ok: false, message: 'Status is required' };
  }
  if (!VALID_MECHANIC_STATUSES.includes(status)) {
    return {
      ok: false,
      message: `Invalid status. Must be one of: ${VALID_MECHANIC_STATUSES.join(', ')}`,
    };
  }
  return { ok: true };
}

export default { validatePhone, validateStatus, VALID_MECHANIC_STATUSES };
