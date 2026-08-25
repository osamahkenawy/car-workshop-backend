/**
 * rate-limits.js — Rate limiters for authentication and other abusable
 * unauthenticated endpoints
 * (renamed from driverLoginLimiter/driverOtpLimiter/driverPasswordResetLimiter)
 *
 * Keyed by IP + identifier (phone/email/username in the request body) so a
 * single IP can't lock out unrelated accounts, and a single account can't be
 * hammered from many IPs without still tripping the per-IP bucket.
 */

import rateLimit from 'express-rate-limit';

const TOO_MANY_ATTEMPTS = {
  success: false,
  message: 'Too many attempts, please try again later.',
};

function keyGenerator(req) {
  const identifier =
    req.body?.phone || req.body?.email || req.body?.username || req.body?.identifier || '';
  return `${req.ip}:${identifier}`;
}

function handler(req, res) {
  res.status(429).json(TOO_MANY_ATTEMPTS);
}

/**
 * Login attempts: 10 requests / 15 minutes per IP+identifier.
 */
export const mechanicLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/**
 * OTP send/verify: 5 requests / 10 minutes per IP+identifier.
 */
export const mechanicOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/**
 * Password reset: 5 requests / hour per IP+identifier.
 */
export const mechanicPasswordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});


// ── Web / customer / super-admin auth ──────────────────────────────────────
// These flows had no limiter at all: an unlimited number of credential guesses
// could be made against admin, customer and super-admin login. Same key as the
// mechanic limiters (IP + identifier) so one IP cannot lock out unrelated
// accounts, and one account cannot be hammered from many IPs unnoticed.

/** Credential submission: 10 attempts / 15 min per IP+identifier. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/**
 * Super-admin login is stricter — it is a single, well-known account set with
 * platform-wide reach, and no legitimate operator needs ten tries.
 */
export const superAdminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/** Password reset / verification resend: 5 / hour per IP+identifier. */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/** Account creation: 5 / hour per IP+identifier. */
export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler,
});

/**
 * Provisioning and outbound-email endpoints that need no authentication:
 * trial signup, contact form, verification resend. Deliberately tight — each
 * request creates records and/or sends mail to an address the caller chose,
 * so this doubles as anti-spam for third parties.
 * Keyed by IP only: the identifier is attacker-chosen and varying it must not
 * buy a fresh bucket.
 */
export const provisioningLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler,
});

/**
 * SR-08 — the public service-status lookup. Unauthenticated and keyed only by a
 * token in the URL, so it is the one endpoint where guessing tokens pays off.
 * New tokens are 128-bit and not worth guessing, but tokens issued before that
 * change are 48-bit and stay valid, so the endpoint is capped to make
 * enumeration impractical regardless.
 *
 * Keyed by IP only: the token is attacker-chosen, and keying on it would give
 * every guess its own fresh bucket — which is exactly the thing being limited.
 * The cap is generous enough for a customer refreshing a live job (the page
 * also polls) but far below what a scan needs.
 */
export const publicTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler,
});
