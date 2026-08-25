/**
 * tokens.js — random identifiers for things a stranger must not be able to guess.
 *
 * The service-status link is unauthenticated and permanent: anyone holding it
 * sees the customer's name, address and the assigned mechanic. It was generated
 * as
 *   crypto.randomBytes(6).toString('hex')      // 48 bits
 * and, in the seeder, as
 *   Math.random().toString(36).slice(2, 12)    // not random at all
 *
 * 48 bits is enumerable by a determined attacker, and Math.random() is a
 * predictable PRNG — an attacker who observes one token can derive the sequence.
 * Both are replaced by 128 bits from the CSPRNG.
 */

import crypto from 'node:crypto';

/** Bytes of entropy in a service-status token. 16 bytes = 128 bits. */
const SERVICE_TOKEN_BYTES = 16;

/**
 * A service-status / tracking token: 32 lowercase hex characters.
 * Stored in work_orders.service_status_token (varchar(100)) and
 * pregenerated_tokens.service_status_token (widened to varchar(64) by
 * migration 20260825_widen_service_status_token.sql).
 */
export function serviceStatusToken() {
  return crypto.randomBytes(SERVICE_TOKEN_BYTES).toString('hex');
}

/** True for tokens issued before the widening — kept working, but flagged. */
export function isLegacyToken(token) {
  return typeof token === 'string' && token.length < SERVICE_TOKEN_BYTES * 2;
}

/**
 * A random suffix for an uploaded file name. These were built from
 * `Date.now()` plus Math.random(), which is guessable enough that an uploaded
 * document's URL can be found by trying nearby timestamps.
 */
export function fileSuffix() {
  return crypto.randomBytes(12).toString('hex');
}

export default serviceStatusToken;
