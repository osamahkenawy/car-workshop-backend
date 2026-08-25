#!/usr/bin/env node
/**
 * purge-stored-xss.js — find and clean markup stored in text columns.
 *
 * The read side now escapes everything (utils/escapeHtml.js) and the write side
 * strips markup from identity fields (lib/sanitize.js), so a payload sitting in
 * the database can no longer execute. This script removes the payloads anyway:
 * they predate the fix, they are ugly in exports and printouts, and they are
 * evidence of an attempt worth seeing.
 *
 * Runs read-only by default. Nothing is written without --apply.
 *
 *   node scripts/purge-stored-xss.js                 # report only
 *   node scripts/purge-stored-xss.js --apply         # clean identity fields
 *   node scripts/purge-stored-xss.js --workshop 3    # limit to one workshop
 *
 * Free-text columns (notes, descriptions, instructions) are reported but never
 * rewritten: "brake pads worn < 2mm" is legitimate content that a markup
 * stripper would destroy, and those fields are only ever rendered as text.
 */

import { query, execute } from '../src/lib/database.js';
import { stripMarkup } from '../src/lib/sanitize.js';

const APPLY = process.argv.includes('--apply');
const wsArg = process.argv.indexOf('--workshop');
const WORKSHOP = wsArg > -1 ? Number(process.argv[wsArg + 1]) : null;

/**
 * Identity columns: markup is never a legitimate value, so these are cleaned.
 * Each entry is [table, primary key, [columns], workshop column or null].
 */
const IDENTITY = [
  ['mechanics',   'id', ['full_name', 'email', 'national_id', 'license_number'], 'workshop_id'],
  ['customers',   'id', ['full_name', 'company_name', 'email'],                  'workshop_id'],
  ['users',       'id', ['full_name', 'username', 'email'],                      'workshop_id'],
  ['work_orders', 'id', ['customer_name', 'customer_email', 'dropoff_address', 'pickup_address'], 'workshop_id'],
  ['service_bays','id', ['name'],                                                'workshop_id'],
  ['vehicles',    'id', ['make', 'model', 'plate_number', 'color'],              'workshop_id'],
];

/** Free-text columns: reported for visibility, never rewritten. */
const FREE_TEXT = [
  ['mechanics',   'id', ['notes'],                                'workshop_id'],
  ['work_orders', 'id', ['notes', 'special_instructions'],         'workshop_id'],
];

/** Tag-shaped content. A bare "<" followed by a space or digit is not markup. */
const TAG_RE = /<\s*\/?\s*[a-zA-Z][^>]*>/;

async function columnExists(table, column) {
  const rows = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(table) {
  const rows = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`, [table]
  );
  return rows.length > 0;
}

async function scan(spec, { clean }) {
  let found = 0, cleaned = 0;

  for (const [table, pk, columns, wsCol] of spec) {
    if (!(await tableExists(table))) continue;

    const present = [];
    for (const c of columns) if (await columnExists(table, c)) present.push(c);
    if (!present.length) continue;

    const where = [present.map(c => `${c} LIKE '%<%'`).join(' OR ')];
    const params = [];
    if (WORKSHOP && await columnExists(table, wsCol)) { where.push(`${wsCol} = ?`); params.push(WORKSHOP); }

    const rows = await query(
      `SELECT ${pk}, ${present.join(', ')} FROM ${table} WHERE (${where[0]})${where[1] ? ` AND ${where[1]}` : ''}`,
      params
    );

    for (const row of rows) {
      const updates = [], vals = [];
      for (const c of present) {
        const v = row[c];
        if (typeof v !== 'string' || !TAG_RE.test(v)) continue;
        found++;
        console.log(`  ${table}#${row[pk]}.${c}`);
        console.log(`      value : ${JSON.stringify(v.slice(0, 90))}`);
        if (clean) {
          // Only identity fields get here. No "after" preview is printed for
          // free text, because no rewrite is proposed for it — showing one
          // would advertise a change this script deliberately never makes.
          const safe = stripMarkup(v, 255);
          console.log(`      clean : ${JSON.stringify(safe)}`);
          updates.push(`${c} = ?`); vals.push(safe);
        }
      }
      if (clean && updates.length && APPLY) {
        await execute(`UPDATE ${table} SET ${updates.join(', ')} WHERE ${pk} = ?`, [...vals, row[pk]]);
        cleaned += updates.length;
      }
    }
  }
  return { found, cleaned };
}

(async () => {
  console.log(APPLY ? '=== PURGE (writing changes) ===' : '=== SCAN ONLY (no changes; pass --apply to clean) ===');
  if (WORKSHOP) console.log(`workshop_id = ${WORKSHOP}`);

  console.log('\n-- identity fields (markup never legitimate; these are cleaned) --');
  const id = await scan(IDENTITY, { clean: true });
  if (!id.found) console.log('  none found');

  console.log('\n-- free text (reported only; never rewritten) --');
  const ft = await scan(FREE_TEXT, { clean: false });
  if (!ft.found) console.log('  none found');

  console.log(`\nidentity fields with markup: ${id.found}${APPLY ? `, cleaned: ${id.cleaned}` : ''}`);
  console.log(`free-text fields with markup: ${ft.found} (left as-is by design)`);
  if (!APPLY && id.found) console.log('\nRe-run with --apply to clean the identity fields above.');
  process.exit(0);
})().catch(err => {
  console.error('purge failed:', err.message);
  process.exit(1);
});
