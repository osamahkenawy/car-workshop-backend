/**
 * Bulk-import customers from a tab-separated paste (old system export).
 *
 * Row shape:
 *   [OldID] [Name] [Phone1] [Phone2] [Email/Note] [Company/Note] [n] [n] [n]
 *
 * Rules:
 *  - Phone1 is required; rows with '-' or blank / obviously stub phones ("050", "-")
 *    are skipped and reported.
 *  - Duplicate detection is by exact phone match against existing customers in
 *    the target workshop — dupes are skipped, never overwritten.
 *  - Name that is just a number (e.g. "17263") is imported as "Customer #17263"
 *    so it's still findable in the job-card picker.
 *  - Email column is only used when it contains "@"; otherwise ignored.
 *  - Company column is used only when it isn't a placeholder like '-', '0', '1',
 *    'd', 'D'. When set, customer `type` = 'business'.
 *  - Trailing three numbers (vehicle/order counts from the old system) are
 *    ignored; those get rebuilt naturally when you start booking jobs here.
 *
 * Usage:
 *   node scripts/bulk-import-customers.js [workshopId] [inputFile]
 *   # defaults:  workshopId=1, inputFile=scripts/_customer-import-data.tsv
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, execute } from '../src/lib/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workshopId = Number(process.argv[2] || 1);
const inputFile  = process.argv[3] || path.join(__dirname, '_customer-import-data.tsv');

const EMPTY_PLACEHOLDERS = new Set(['', '-', '0', '1', 'd', 'D']);

function normalisePhone(raw) {
  if (!raw) return '';
  // Strip spaces, non-breaking spaces, dashes; keep leading '+'.
  const t = String(raw).replace(/\u00A0/g, ' ').trim();
  if (!t || t === '-') return '';
  const hasPlus = t.startsWith('+');
  const digits = t.replace(/[^\d]/g, '');
  return hasPlus ? '+' + digits : digits;
}

function isStubPhone(p) {
  // '050' alone (and similar 3-digit stubs) are truncated exports, unusable.
  return !p || p.length < 6;
}

function cleanName(raw) {
  const n = (raw || '').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  // A "name" that's only digits is really just an old-system record number.
  if (/^\d+$/.test(n)) return `Customer #${n}`;
  return n;
}

function cleanCompany(raw) {
  const c = (raw || '').trim();
  if (EMPTY_PLACEHOLDERS.has(c)) return '';
  return c;
}

function cleanEmail(raw) {
  const e = (raw || '').trim();
  return e.includes('@') ? e : '';
}

async function main() {
  const abs = path.resolve(inputFile);
  if (!fs.existsSync(abs)) {
    console.error('Input file not found:', abs);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);

  // Pre-load existing phones for this workshop, so we can detect dupes in-memory.
  const existing = await query('SELECT phone FROM customers WHERE workshop_id = ?', [workshopId]);
  const existingPhones = new Set(existing.map(r => normalisePhone(r.phone)));

  const seenPhones = new Set();
  const stats = { total: lines.length, inserted: 0, dup: 0, skippedPhone: 0, skippedName: 0 };
  const skipped = [];

  for (const line of lines) {
    const cols = line.split('\t');
    // Row shape: [oldId, name, phone1, phone2, email/note, company/note, n, n, n]
    const [_oldId, nameRaw, phone1Raw, phone2Raw, emailRaw, companyRaw] = cols;

    const full_name = cleanName(nameRaw);
    if (!full_name) { stats.skippedName++; skipped.push({ line, reason: 'no name' }); continue; }

    const phone = normalisePhone(phone1Raw);
    if (isStubPhone(phone)) {
      stats.skippedPhone++;
      skipped.push({ line, reason: `bad phone1: "${phone1Raw ?? ''}"` });
      continue;
    }

    if (existingPhones.has(phone) || seenPhones.has(phone)) {
      stats.dup++;
      continue;
    }
    seenPhones.add(phone);

    const phone_alt_raw = normalisePhone(phone2Raw);
    const phone_alt = (!isStubPhone(phone_alt_raw) && phone_alt_raw !== phone) ? phone_alt_raw : null;
    const email = cleanEmail(emailRaw) || null;
    const company_name = cleanCompany(companyRaw) || null;
    const type = company_name ? 'business' : 'individual';

    await execute(
      `INSERT INTO customers (workshop_id, full_name, company_name, email, phone, phone_alt, type, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [workshopId, full_name, company_name, email, phone, phone_alt, type, `Imported from legacy system`]
    );
    stats.inserted++;
  }

  console.log(`\n── Customer import — workshop ${workshopId} ─────────────────────`);
  console.log(`Total rows in file:  ${stats.total}`);
  console.log(`Inserted:            ${stats.inserted}`);
  console.log(`Duplicates (skipped):${stats.dup}`);
  console.log(`Bad/missing phone:   ${stats.skippedPhone}`);
  console.log(`Missing name:        ${stats.skippedName}`);
  if (skipped.length) {
    console.log(`\nFirst 10 skipped rows:`);
    for (const s of skipped.slice(0, 10)) console.log(`  · ${s.reason} — ${s.line.slice(0, 100)}`);
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
