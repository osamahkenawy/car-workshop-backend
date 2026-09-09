#!/usr/bin/env node
/**
 * rename-branches.js — rename branch values in place.
 *
 * The workshop names its branches by emirate — Abu Dhabi, Sharjah, Dubai,
 * Al Ain — but the survey data was seeded with "area — emirate" labels
 * ("Mussafah — Abu Dhabi"). Renaming has to happen in the database, not just
 * in new seed files, because responses are already live.
 *
 * Both tables have to move together. survey_responses.branch drives the
 * by-branch breakdown and survey_invites.branch drives the per-branch
 * response rate, and the stats endpoint compares them by string equality
 * (routes/customer-survey.js). Rename one and not the other and every branch
 * reports a response rate of zero — the numbers stay plausible-looking, which
 * is the worst kind of wrong.
 *
 *   node scripts/rename-branches.js --dry-run
 *   node scripts/rename-branches.js
 *   node scripts/rename-branches.js --workshop=1
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DRY = argv.includes('--dry-run');
const WORKSHOP = Number(arg('workshop', '1'));

// Old value -> new value. Anything not listed is left alone, so re-running
// after a partial rename is safe and rows already renamed simply match zero.
const RENAMES = [
  ['Mussafah — Abu Dhabi', 'Abu Dhabi'],
  ['Industrial Area 4 — Sharjah', 'Sharjah'],
  ['Al Quoz — Dubai', 'Dubai'],
  // Both dash styles: the seed used an em dash, but a value typed by hand in
  // the UI or pasted from a spreadsheet often carries a hyphen instead.
  ['Mussafah - Abu Dhabi', 'Abu Dhabi'],
  ['Industrial Area 4 - Sharjah', 'Sharjah'],
  ['Al Quoz - Dubai', 'Dubai'],
];

const TABLES = ['survey_responses', 'survey_invites'];

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    console.log(`Workshop: ${WORKSHOP}${DRY ? '   (dry run)' : ''}\n`);

    // Show what is actually there first. A rename list that matches nothing
    // usually means the values differ from what was assumed, and printing the
    // real distribution is what makes that obvious instead of silent.
    for (const table of TABLES) {
      const [rows] = await db.query(
        `SELECT COALESCE(NULLIF(branch, ''), '(none)') AS branch, COUNT(*) AS n
           FROM ${table} WHERE workshop_id = ? GROUP BY branch ORDER BY n DESC`,
        [WORKSHOP]
      );
      console.log(`${table} — current values:`);
      if (!rows.length) console.log('   (no rows)');
      for (const r of rows) console.log(`   ${String(r.n).padStart(5)}  ${r.branch}`);
      console.log('');
    }

    let planned = 0;
    const plan = [];
    for (const table of TABLES) {
      for (const [from, to] of RENAMES) {
        const [[{ n }]] = await db.query(
          `SELECT COUNT(*) AS n FROM ${table} WHERE workshop_id = ? AND branch = ?`,
          [WORKSHOP, from]
        );
        if (n > 0) { plan.push({ table, from, to, n }); planned += n; }
      }
    }

    if (!planned) {
      console.log('Nothing to rename — no row carries any of the old values.');
      return;
    }

    console.log('Planned changes:');
    for (const p of plan) {
      console.log(`   ${String(p.n).padStart(5)}  ${p.table}: "${p.from}" -> "${p.to}"`);
    }
    console.log(`\nTotal: ${planned} row(s)`);

    if (DRY) {
      console.log('\n--dry-run: nothing written. Re-run without --dry-run to apply.');
      return;
    }

    // One transaction: a half-applied rename is the broken state described
    // at the top of this file.
    await db.beginTransaction();
    try {
      let done = 0;
      for (const p of plan) {
        const [r] = await db.query(
          `UPDATE ${p.table} SET branch = ? WHERE workshop_id = ? AND branch = ?`,
          [p.to, WORKSHOP, p.from]
        );
        done += r.affectedRows;
      }
      await db.commit();
      console.log(`\nRenamed ${done} row(s).`);
    } catch (e) {
      await db.rollback();
      throw e;
    }

    for (const table of TABLES) {
      const [rows] = await db.query(
        `SELECT COALESCE(NULLIF(branch, ''), '(none)') AS branch, COUNT(*) AS n
           FROM ${table} WHERE workshop_id = ? GROUP BY branch ORDER BY n DESC`,
        [WORKSHOP]
      );
      console.log(`\n${table} — after:`);
      for (const r of rows) console.log(`   ${String(r.n).padStart(5)}  ${r.branch}`);
    }
  } finally {
    await db.end();
  }
}

main().catch(e => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
