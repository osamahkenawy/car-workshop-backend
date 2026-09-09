/**
 * import-customers-csv.js — bulk-loads the full customer master export
 * (all-customers.csv, the raw Oracle column names: CUSTCODE, CUSTOMERNAME,
 * MOBILNUM, ...) into `customers`.
 *
 * Idempotent on CUSTCODE: each row is stamped into notes as
 * {"src":"oracle","src_id":"<CUSTCODE>"} — the same key
 * scripts/oracle-migration/migrate.mjs already uses — and a row whose code
 * is already present is skipped, not duplicated. So this can be re-run
 * against a partially-imported database and only adds what's missing.
 *
 * src_id alone isn't enough, though: an earlier partial import loaded ~220 of
 * these same customers WITHOUT stamping any src_id (their notes are free
 * text, not JSON), so a code-only check would have inserted a second copy of
 * each. Those are matched on normalised phone AND normalised name together —
 * phone alone is not sufficient, since 279 phone numbers are shared by more
 * than one customer in this export (families and company contacts). On a
 * match the existing row gets the src_id backfilled instead of a duplicate
 * being created, so the dataset gets progressively more linkable rather than
 * more duplicated. A placeholder name ("Customer #98957") is also upgraded
 * if this export carries the real one.
 *
 * Source-data handling, all of it reported rather than silent:
 *   - phone: MOBILNUM -> WHATSNUM -> OFFICNUM, first one with >=7 digits.
 *     `customers.phone` is NOT NULL and 131 rows have none, so those get
 *     '-' — the placeholder the existing Oracle import already uses.
 *   - WHATSNUM goes to phone_alt when it differs from the chosen phone.
 *   - The export uses "1", "-", "'-" and "." as filler in email/company/
 *     address fields; those are treated as empty rather than imported as
 *     literal values.
 *   - 3 rows have a numeric CUSTOMERNAME ("17", "17263", "98957"). Where a
 *     plausible real name sits in an address column it's used instead (one
 *     row: "AYESHA KHAMEES SALEH ALMASHJARI" was in PARTYAD1). The others
 *     become "Customer #<code>", the convention an earlier import already
 *     used for exactly these records, rather than importing "17263"
 *     verbatim as somebody's name.
 *   - 1 row has no CUSTCODE at all (RAHUL NAGPAL). It still gets imported,
 *     keyed as "NAMED:<name>" — the same fallback the existing Oracle
 *     import used for codeless records — rather than dropped for want of
 *     an identifier.
 *   - BORNDATE/GENDERID/NATIONAL/UNIQUEID/WORKDESG have no columns on
 *     `customers`, so they're preserved in the notes JSON instead of being
 *     dropped. 8 birthdates have out-of-range years and are omitted.
 *   - `type` is a keyword guess (LLC / TRADING / CO / EST / GROUP / ... ->
 *     business, else individual) because the export has no type column.
 *     Flagged in notes as type_guessed so it's never mistaken for source data.
 *   - emirate is left to the column default rather than invented per row.
 *
 * Usage:
 *   node scripts/import-customers-csv.js <csv-path> [--dry-run] [--batch=label]
 */
import fs from 'fs';
import { query, execute } from '../src/lib/database.js';

const [, , csvPathArg, ...rest] = process.argv;
const dryRun = rest.includes('--dry-run');
const batchLabel = rest.find(a => a.startsWith('--batch='))?.split('=')[1]
  || new Date().toISOString().slice(0, 10);
const CHUNK = 200;

if (!csvPathArg) {
  console.error('Usage: node scripts/import-customers-csv.js <csv-path> [--dry-run] [--batch=label]');
  process.exit(1);
}

const PLACEHOLDERS = new Set(['', '-', "'-", '1', 'n/a', 'na', 'null', 'none', '.', '0']);
const clean = v => {
  const s = String(v ?? '').trim().replace(/^'+/, '').trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
};
const isNumericish = s => /^[\d.\-/]+$/.test(s);
const squash = s => s.replace(/\s+/g, ' ').trim();

const BUSINESS_HINTS = [
  'LLC', 'L.L.C', 'TRADING', 'TRADE', 'COMPANY', ' CO.', ' CO ', 'EST.', 'ESTABLISH',
  'GROUP', 'HYPER', 'MARKET', 'CENTRE', 'CENTER', 'SERVICES', 'CONTRACTING', 'ENGINEERING',
  'TRANSPORT', 'RENT A CAR', 'TAXI', 'CLUB', 'SCHOOL', 'MEDICAL', 'CLINIC', 'FURNITURE',
  'EQUIPMENT', 'INSURANCE', 'BROKERS', 'HOLDING', 'INDUSTRIES', 'FZ-LLC', 'F.Z', 'W.L.L',
  'SUPERMARKET', 'CARGO', 'LOGISTIC', 'CONSULTANT', 'LEASING', 'INVESTMENT',
];
const guessType = name => {
  const u = ` ${name.toUpperCase()} `;
  return BUSINESS_HINTS.some(h => u.includes(h)) ? 'business' : 'individual';
};

/** Minimal CSV parse that respects double-quoted fields containing commas. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]).map(h => h.replace(/"/g, '').trim());
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

const phoneOf = r => {
  for (const f of ['MOBILNUM', 'WHATSNUM', 'OFFICNUM']) {
    const v = clean(r[f]);
    if (v && v.replace(/\D/g, '').length >= 7) return v;
  }
  return '';
};

const bornDate = r => {
  const d = clean(r.BORNDATE);
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  if (!Number.isFinite(y) || y < 1900 || y > 2026) return null;
  return d.slice(0, 10);
};

async function main() {
  const rows = parseCsv(fs.readFileSync(csvPathArg, 'utf8'));
  console.log(`Loaded ${rows.length} rows from ${csvPathArg}`);
  console.log(`Batch label: ${batchLabel}${dryRun ? '   (dry run — nothing will be written)' : ''}\n`);

  const [{ id: workshopId } = {}] = await query('SELECT id FROM workshops LIMIT 1');
  if (!workshopId) throw new Error('No workshop found');

  // Everything already in the table, indexed both ways: by source code (the
  // primary key) and by normalised phone (the fallback for rows an earlier
  // import loaded without stamping a code).
  const existing = await query(
    `SELECT id, full_name, phone, notes,
            CASE WHEN JSON_VALID(notes) = 1
                 THEN JSON_UNQUOTE(JSON_EXTRACT(notes, '$.src_id')) END AS src_id
       FROM customers WHERE workshop_id = ?`,
    [workshopId]
  );
  const normPhone = s => String(s || '').replace(/\D/g, '').replace(/^971/, '').replace(/^0/, '');
  const normName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const have = new Set(existing.filter(r => r.src_id).map(r => r.src_id));
  const byPhone = new Map();
  for (const r of existing) {
    const p = normPhone(r.phone);
    if (p.length >= 7) {
      if (!byPhone.has(p)) byPhone.set(p, []);
      byPhone.get(p).push(r);
    }
  }
  console.log(`Already in table: ${existing.length} (${have.size} carrying a src_id)`);

  const toInsert = [];
  const toLink = [];   // existing rows to backfill src_id onto
  const review = [];   // inserted, but shares a phone with a differently-named row
  const skipped = { already: 0 };
  let noPhone = 0, rescuedName = 0, businessGuess = 0, placeholderName = 0, codeless = 0;

  for (const r of rows) {
    const rawName = squash(clean(r.CUSTOMERNAME));
    let code = clean(r.CUSTCODE);
    if (!code) {
      // Codeless row — key it by name, the fallback the existing import used.
      if (!rawName || isNumericish(rawName)) { skipped.already++; continue; }
      code = `NAMED:${rawName}`;
      codeless++;
    }
    if (have.has(code)) { skipped.already++; continue; }

    let name = rawName;
    let upgradedName = null;
    if (!name || isNumericish(name)) {
      // Real name sometimes sits in an address/company column on these rows.
      const rescue = ['PARTYAD1', 'PARTYAD2', 'PARTYAD3', 'WORKCOMP']
        .map(f => squash(clean(r[f])))
        .find(v => v && !isNumericish(v) && v.length > 3);
      if (rescue) { name = rescue; upgradedName = rescue; rescuedName++; }
      else { name = `Customer #${rawName || code}`; placeholderName++; }
    }

    // No code match — is this the same person under an earlier, unstamped
    // import? Require phone AND name to agree (or the existing name to be the
    // "Customer #N" placeholder for this very record), because a shared phone
    // on its own is a family member, not a duplicate.
    const p = normPhone(phoneOf(r));
    if (p.length >= 7 && byPhone.has(p)) {
      const cand = byPhone.get(p).find(e =>
        !e.src_id && (
          normName(e.full_name) === normName(name) ||
          normName(e.full_name) === normName(rawName) ||
          normName(e.full_name) === normName(`Customer #${rawName}`)
        ));
      if (cand) {
        toLink.push({ id: cand.id, code, name: cand.full_name, upgradedName, priorNotes: cand.notes });
        have.add(code);
        continue;
      }
      // Phone matches but no name agrees. Usually a genuinely different person
      // on a shared household/company number, occasionally the same person
      // under a spelling variant or a truncated name. Not auto-merged —
      // wrongly fusing two customers is worse than a near-duplicate someone
      // can merge later — but listed so it can be eyeballed.
      review.push(`${code} '${name}'  shares a phone with: ${byPhone.get(p).map(e => `#${e.id} '${e.full_name}'`).join(', ')}`);
    }

    const phone = phoneOf(r);
    if (!phone) noPhone++;
    const whats = clean(r.WHATSNUM);
    const email = [clean(r.PERSMAIL), clean(r.WORKMAIL)].find(v => v.includes('@')) || null;
    const company = squash(clean(r.WORKCOMP));
    const addr = ['PARTYAD1', 'PARTYAD2', 'PARTYAD3'].map(f => squash(clean(r[f]))).filter(Boolean);
    // If a name was rescued out of an address column, don't also store it as
    // the address.
    const addrParts = addr.filter(a => a !== name);
    const type = guessType(company && company !== name ? `${name} ${company}` : name);
    if (type === 'business') businessGuess++;

    toInsert.push([
      workshopId,
      name.slice(0, 255),
      company && company !== name ? company.slice(0, 255) : null,
      email ? email.slice(0, 255) : null,
      (phone || '-').slice(0, 50),
      whats && whats !== phone ? whats.slice(0, 50) : null,
      type,
      addrParts[0] || null,
      addrParts.slice(1).join(', ') || null,
      JSON.stringify({
        src: 'oracle',
        src_id: code,
        batch: batchLabel,
        kind: 'imported',
        party_code: clean(r.PARTYCDE) || null,
        comp_code: clean(r.COMPCODE) || null,
        gender: clean(r.GENDERID) || null,
        nationality: clean(r.NATIONAL) || null,
        date_of_birth: bornDate(r),
        unique_id: clean(r.UNIQUEID) || null,
        work_designation: squash(clean(r.WORKDESG)) || null,
        type_guessed: true,
      }),
    ]);
  }

  console.log(`Skipped — src_id already present:  ${skipped.already}`);
  console.log(`Matched existing row by phone+name: ${toLink.length}  (src_id backfilled, no duplicate created)`);
  console.log(`  ...of those, name upgraded from a placeholder: ${toLink.filter(l => l.upgradedName).length}`);
  console.log(`Codeless rows keyed as NAMED:<name>: ${codeless}`);
  console.log(`Name recovered from address column:  ${rescuedName}`);
  console.log(`Named "Customer #<code>" (no name anywhere): ${placeholderName}`);
  console.log(`No phone (stored as '-'):            ${noPhone}`);
  console.log(`Typed 'business' by keyword:         ${businessGuess}  (rest 'individual')`);
  if (review.length) {
    console.log(`\nWorth a look — ${review.length} imported as new but sharing a phone with a`);
    console.log(`differently-named existing customer (usually family/company, sometimes a`);
    console.log(`spelling variant of the same person). Not merged automatically:`);
    review.slice(0, 10).forEach(l => console.log(`  ${l}`));
    if (review.length > 10) console.log(`  ...and ${review.length - 10} more`);
  }
  console.log(`\n${dryRun ? 'Would insert' : 'Inserting'}: ${toInsert.length} new customers`);

  if (dryRun) {
    if (toInsert.length) {
      console.log('\nFirst 3 that would be inserted:');
      toInsert.slice(0, 3).forEach(r => console.log(`  ${r[1]} | phone=${r[4]} | type=${r[6]}`));
    }
    if (toLink.length) {
      console.log('\nFirst 5 that would be linked to an existing row instead:');
      toLink.slice(0, 5).forEach(l =>
        console.log(`  #${l.id} '${l.name}' <- src_id ${l.code}${l.upgradedName ? ` (rename to '${l.upgradedName}')` : ''}`));
    }
    process.exit(0);
  }

  // Backfill src_id onto the rows an earlier import left unlinked, so the
  // next run matches them on the code and never reconsiders them.
  let linked = 0;
  for (const l of toLink) {
    // These rows' notes are free text (that's why they had no src_id), so the
    // original is carried into the JSON rather than overwritten away.
    let prior = null;
    if (l.priorNotes) {
      try {
        const parsed = JSON.parse(l.priorNotes);
        prior = (parsed && typeof parsed === 'object') ? null : String(l.priorNotes);
      } catch { prior = String(l.priorNotes); }
    }
    const patch = JSON.stringify({
      src: 'oracle', src_id: l.code, batch: batchLabel, kind: 'linked_existing',
      ...(prior ? { prior_note: prior.slice(0, 2000) } : {}),
    });
    await execute(
      l.upgradedName
        ? 'UPDATE customers SET notes = ?, full_name = ? WHERE id = ? AND workshop_id = ?'
        : 'UPDATE customers SET notes = ? WHERE id = ? AND workshop_id = ?',
      l.upgradedName
        ? [patch, l.upgradedName.slice(0, 255), l.id, workshopId]
        : [patch, l.id, workshopId]
    );
    linked++;
  }
  if (linked) console.log(`Linked ${linked} existing customer(s) to their source code.`);
  if (!toInsert.length) {
    const [{ total: t0 }] = await query('SELECT COUNT(*) AS total FROM customers WHERE workshop_id = ?', [workshopId]);
    console.log(`\nDone. Customers in workshop ${workshopId}: ${t0}`);
    process.exit(0);
  }

  const COLS = ['workshop_id', 'full_name', 'company_name', 'email', 'phone', 'phone_alt',
    'type', 'address_line1', 'address_line2', 'notes'];
  let done = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => `(${COLS.map(() => '?').join(',')})`).join(',');
    const res = await execute(
      `INSERT INTO customers (${COLS.join(',')}) VALUES ${placeholders}`,
      chunk.flat()
    );
    done += res.affectedRows;
    console.log(`  inserted ${done}/${toInsert.length}`);
  }

  const [{ total }] = await query('SELECT COUNT(*) AS total FROM customers WHERE workshop_id = ?', [workshopId]);
  console.log(`\nDone. Customers in workshop ${workshopId}: ${total}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
