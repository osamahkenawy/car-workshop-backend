#!/usr/bin/env node
/**
 * import-survey-responses.js — load a month of survey responses from CSV.
 *
 * Written for the July 2026 demonstration dataset
 * (scripts/data/cx_survey_2026-07.csv, produced together with
 * Pioneer_CX_Survey_July-2026.xlsx), but it will take any CSV with the same
 * column names.
 *
 * Three things this deliberately does not trust:
 *
 *  1. The sheet's derived columns. ces_avg, csat_avg and nps_category are
 *     recomputed here from the answer columns using the same rules as
 *     routes/customer-survey.js. If a reviewer edits a score in the sheet and
 *     forgets the derived column beside it, the database still comes out
 *     self-consistent.
 *
 *  2. Its own idempotence. Every row is stamped
 *     user_agent = 'seed:<label>' and a re-run deletes that label's rows
 *     before inserting, so importing twice leaves one copy rather than two.
 *     That marker is also the only thing distinguishing these rows from real
 *     customer submissions — which is why it is not optional.
 *
 *  3. That the caller wants to write. --dry-run is the default posture in the
 *     runbook: it reports exactly what would change and touches nothing.
 *
 * Usage
 *   node scripts/import-survey-responses.js --file=scripts/data/cx_survey_2026-07.csv --dry-run
 *   node scripts/import-survey-responses.js --file=scripts/data/cx_survey_2026-07.csv
 *   node scripts/import-survey-responses.js --file=... --label=cx-demo-2026-07 --workshop=1
 *   node scripts/import-survey-responses.js --purge --label=cx-demo-2026-07
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

// ── Arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = name => argv.includes(`--${name}`);

const FILE = arg('file');
const LABEL = arg('label', 'cx-demo-2026-07');
const WORKSHOP = Number(arg('workshop', '1'));
const DRY = flag('dry-run');
const PURGE = flag('purge');
const MARKER = `seed:${LABEL}`;

if (!PURGE && !FILE) {
  console.error('Missing --file=<path to csv>  (or --purge to remove a previous import)');
  process.exit(1);
}

// ── CSV ────────────────────────────────────────────────────────────────────

/**
 * A quote-aware CSV reader. The verbatims contain commas, quotes and em
 * dashes, so splitting on ',' corrupts roughly a third of the rows — the
 * failure is silent, which is worse than a crash.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map(h => h.trim());
  return rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ── Derivation, mirroring routes/customer-survey.js ────────────────────────

const CSAT_KEYS = [
  'csat_overall', 'csat_as_advertised', 'csat_expectations',
  'csat_rep_knowledge', 'csat_communication', 'csat_response_time',
];
const CES_KEYS = ['ces_find_channel', 'ces_easy_handle'];
const RESOLUTIONS = ['yes', 'partially', 'no'];
const LANGUAGES = ['en', 'ar'];
const SOURCES = ['link', 'qr', 'portal', 'staff', 'google_form'];

const scale = v => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

const mean = vals => {
  const ok = vals.filter(v => v !== null);
  return ok.length ? Number((ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(2)) : null;
};

/** Standard NPS banding: 9-10 promoter, 7-8 passive, 0-6 detractor. */
const npsCategory = s =>
  s === null ? null : s >= 9 ? 'promoter' : s >= 7 ? 'passive' : 'detractor';

const oneOf = (v, allowed, fallback) =>
  allowed.includes(String(v).toLowerCase()) ? String(v).toLowerCase() : fallback;

const nullable = v => (v === '' || v === undefined ? null : v);

/** '2026-07-01 08:32:47' as written; anything unparseable is refused loudly. */
function datetime(v, rowNo, column) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
    throw new Error(`Row ${rowNo}: ${column} is not 'YYYY-MM-DD HH:MM:SS': "${v}"`);
  }
  return v;
}

function buildRow(raw, rowNo) {
  const answers = {};
  for (const k of [...CSAT_KEYS, ...CES_KEYS]) answers[k] = scale(raw[k]);

  const npsRaw = Number(raw.nps_score);
  const nps = Number.isInteger(npsRaw) && npsRaw >= 0 && npsRaw <= 10 ? npsRaw : null;

  const scored = [...Object.values(answers), nps].some(v => v !== null);
  if (!scored) throw new Error(`Row ${rowNo}: no scored answers — nothing to record`);

  if (!raw.contact_name) throw new Error(`Row ${rowNo}: contact_name is empty`);

  const resolution = raw.resolution ? oneOf(raw.resolution, RESOLUTIONS, null) : null;
  if (raw.resolution && !resolution) {
    throw new Error(`Row ${rowNo}: resolution "${raw.resolution}" is not yes/partially/no`);
  }

  const category = npsCategory(nps);

  return {
    workshop_id: WORKSHOP,
    ...answers,
    resolution,
    nps_score: nps,
    nps_reason: nullable(raw.nps_reason),
    ces_avg: mean(CES_KEYS.map(k => answers[k])),
    csat_avg: mean(CSAT_KEYS.map(k => answers[k])),
    nps_category: category,
    contact_name: raw.contact_name,
    contact_phone: nullable(raw.contact_phone),
    contact_email: nullable(raw.contact_email),
    branch: nullable(raw.branch),
    service_requested: nullable(raw.service_requested),
    language: oneOf(raw.language, LANGUAGES, 'en'),
    source: oneOf(raw.source, SOURCES, 'link'),
    // Flagged when the customer is a detractor or was not fully resolved —
    // the same rule the live submit path applies.
    is_flagged: category === 'detractor' || (resolution && resolution !== 'yes') ? 1 : 0,
    followed_up_at: datetime(raw.followed_up_at, rowNo, 'followed_up_at'),
    follow_up_notes: nullable(raw.follow_up_notes),
    user_agent: MARKER,
    submitted_at: datetime(raw.submitted_at, rowNo, 'submitted_at'),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  'workshop_id',
  ...CES_KEYS, 'resolution', 'nps_score', 'nps_reason', ...CSAT_KEYS,
  'ces_avg', 'csat_avg', 'nps_category',
  'contact_name', 'contact_phone', 'contact_email', 'branch',
  'service_requested', 'language', 'source',
  'is_flagged', 'followed_up_at', 'follow_up_notes',
  'user_agent', 'submitted_at',
];

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false,
  });

  try {
    const [[{ n: existing }]] = await db.query(
      'SELECT COUNT(*) AS n FROM survey_responses WHERE user_agent = ?', [MARKER]
    );

    if (PURGE) {
      console.log(`Marker  : ${MARKER}`);
      console.log(`Existing: ${existing} row(s)`);
      if (DRY) { console.log('\n--dry-run: nothing deleted.'); return; }
      const [r] = await db.query(
        'DELETE FROM survey_responses WHERE user_agent = ?', [MARKER]
      );
      console.log(`\nDeleted ${r.affectedRows} row(s).`);
      return;
    }

    const filePath = path.resolve(FILE);
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    const built = rows.map((r, i) => buildRow(r, i + 2));   // +2: header is row 1

    const [[{ n: total }]] = await db.query(
      'SELECT COUNT(*) AS n FROM survey_responses WHERE workshop_id = ?', [WORKSHOP]
    );
    const dates = built.map(b => b.submitted_at).filter(Boolean).sort();
    const branches = built.reduce((acc, b) => {
      acc[b.branch || '(none)'] = (acc[b.branch || '(none)'] || 0) + 1;
      return acc;
    }, {});
    const cats = built.reduce((acc, b) => {
      acc[b.nps_category] = (acc[b.nps_category] || 0) + 1;
      return acc;
    }, {});
    const nps = Math.round(
      ((cats.promoter || 0) - (cats.detractor || 0)) / built.length * 100
    );

    console.log(`File     : ${filePath}`);
    console.log(`Workshop : ${WORKSHOP}`);
    console.log(`Marker   : ${MARKER}`);
    console.log(`Parsed   : ${built.length} row(s)`);
    console.log(`Period   : ${dates[0]} .. ${dates[dates.length - 1]}`);
    console.log(`NPS      : ${nps >= 0 ? '+' : ''}${nps}  `
      + `(${cats.promoter || 0} promoter / ${cats.passive || 0} passive / `
      + `${cats.detractor || 0} detractor)`);
    console.log(`Flagged  : ${built.filter(b => b.is_flagged).length}`
      + `, of which ${built.filter(b => b.is_flagged && b.followed_up_at).length} followed up`);
    console.log('Branches :');
    for (const [b, n] of Object.entries(branches)) console.log(`   ${n.toString().padStart(4)}  ${b}`);
    console.log(`\nsurvey_responses already holds ${total} row(s) for this workshop, `
      + `${existing} of them under this marker.`);

    if (DRY) {
      console.log('\n--dry-run: nothing written. Re-run without --dry-run to import.');
      return;
    }

    await db.beginTransaction();
    try {
      if (existing) {
        const [d] = await db.query(
          'DELETE FROM survey_responses WHERE user_agent = ?', [MARKER]
        );
        console.log(`\nReplaced: removed ${d.affectedRows} row(s) from the previous run.`);
      }

      const placeholders = `(${COLUMNS.map(() => '?').join(',')})`;
      const sql = `INSERT INTO survey_responses (${COLUMNS.join(',')}) VALUES ${placeholders}`;
      for (const b of built) await db.query(sql, COLUMNS.map(c => b[c]));

      await db.commit();
      console.log(`Inserted ${built.length} row(s).`);
      console.log(`\nTo undo: node scripts/import-survey-responses.js --purge --label=${LABEL}`);
    } catch (e) {
      await db.rollback();
      throw e;
    }
  } finally {
    await db.end();
  }
}

main().catch(e => {
  console.error(`\nFailed: ${e.message}`);
  process.exit(1);
});
