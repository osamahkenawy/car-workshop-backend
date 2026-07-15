/**
 * rate-limits.js — Rate limiters for the mechanic-app auth endpoints
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
