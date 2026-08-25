#!/usr/bin/env node
/**
 * rotate-service-tokens.js — reissue service-status tokens that were generated
 * before they were widened to 128 bits.
 *
 * Legacy tokens are 12 hex characters (48 bits) or, in seeded data, derived
 * from Math.random(). Both are weak enough to enumerate, and the link needs no
 * authentication.
 *
 * ROTATING BREAKS LINKS CUSTOMERS ALREADY HAVE. A tracking link that was
 * emailed or sent by SMS stops resolving the moment its token changes. So this
 * is opt-in and, by default, only touches orders that are already closed —
 * where nobody is actively following the link, and where the lasting exposure
 * (name, address, mechanic) is the part worth removing.
 *
 *   node scripts/rotate-service-tokens.js                 # report only
 *   node scripts/rotate-service-tokens.js --apply         # closed orders only
 *   node scripts/rotate-service-tokens.js --apply --all   # live orders too
 *                                                         (breaks live links)
 *   node scripts/rotate-service-tokens.js --workshop 3
 */

import { query, execute } from '../src/lib/database.js';
import { serviceStatusToken, isLegacyToken } from '../src/lib/tokens.js';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const wsArg = process.argv.indexOf('--workshop');
const WORKSHOP = wsArg > -1 ? Number(process.argv[wsArg + 1]) : null;

/** Orders someone may still be tracking right now. */
const LIVE = ['assigned', 'accepted', 'in_progress', 'ready_for_pickup', 'confirmed', 'pending'];

(async () => {
  console.log(APPLY ? '=== ROTATE (writing changes) ===' : '=== SCAN ONLY (no changes; pass --apply) ===');
  console.log(ALL ? 'scope: ALL orders — live tracking links WILL break' : 'scope: closed orders only');
  if (WORKSHOP) console.log(`workshop_id = ${WORKSHOP}`);

  const where = ['service_status_token IS NOT NULL'];
  const params = [];
  if (!ALL) { where.push(`status NOT IN (${LIVE.map(() => '?').join(',')})`); params.push(...LIVE); }
  if (WORKSHOP) { where.push('workshop_id = ?'); params.push(WORKSHOP); }

  const rows = await query(
    `SELECT id, work_order_number, status, service_status_token
       FROM work_orders WHERE ${where.join(' AND ')}`,
    params
  );

  const legacy = rows.filter(r => isLegacyToken(r.service_status_token));
  let rotated = 0;

  for (const r of legacy) {
    const next = serviceStatusToken();
    console.log(`  ${r.work_order_number} [${r.status}] ${r.service_status_token} (${r.service_status_token.length} chars)`
              + `${APPLY ? ` -> ${next}` : ''}`);
    if (APPLY) {
      await execute('UPDATE work_orders SET service_status_token = ? WHERE id = ?', [next, r.id]);
      rotated++;
    }
  }

  const skipped = rows.length - legacy.length;
  console.log(`\nlegacy tokens found: ${legacy.length}${APPLY ? `, rotated: ${rotated}` : ''}`);
  console.log(`already 128-bit: ${skipped}`);
  if (!ALL) {
    const liveLegacy = await query(
      `SELECT COUNT(*) AS n FROM work_orders
        WHERE service_status_token IS NOT NULL
          AND CHAR_LENGTH(service_status_token) < 32
          AND status IN (${LIVE.map(() => '?').join(',')})`, LIVE
    );
    // Never let a bounded scope look like full coverage.
    console.log(`live orders still on a legacy token: ${liveLegacy[0].n} (not touched; use --all to include them)`);
  }
  if (!APPLY && legacy.length) console.log('\nRe-run with --apply to rotate.');
  process.exit(0);
})().catch(err => {
  console.error('rotation failed:', err.message);
  process.exit(1);
});
