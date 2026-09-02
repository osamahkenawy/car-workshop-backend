#!/usr/bin/env node
/**
 * seed-enquiries.js — fill the Enquiries page with believable history.
 *
 * Volume is weighted towards the present, the way a real pipeline looks: a
 * cluster today and yesterday, a steady week behind that, thinning out over the
 * preceding two months. Flat "N per day" data makes every chart look synthetic.
 *
 *   node scripts/seed-enquiries.js                  # ~150 over 60 days, all converted
 *   node scripts/seed-enquiries.js --days 90
 *   node scripts/seed-enquiries.js --mix            # realistic status spread instead
 *   node scripts/seed-enquiries.js --clean          # remove everything this created
 *
 * Every row is tagged in external_reference with the SEED_TAG below, so --clean
 * removes exactly what was seeded and nothing else.
 *
 * Converting an enquiry is not just a status change: the app creates a customer
 * and a work order and links them (routes/enquiries.js convert). This does the
 * same, so the seeded rows behave like real ones — the WO number shows on the
 * row, and Reports counts the revenue.
 */

import crypto from 'node:crypto';
import { query, execute } from '../src/lib/database.js';

const SEED_TAG = 'SEED-ENQ';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i > -1 ? Number(argv[i + 1]) : d; };

const CLEAN = has('--clean');
const MIX = has('--mix');
const DAYS = num('--days', 60);
const WORKSHOP = num('--workshop', 0);

/* ── Source material ───────────────────────────────────────────────────── */

const FIRST = ['Ahmed', 'Mohammed', 'Fatima', 'Aisha', 'Omar', 'Khalid', 'Noura', 'Yousef',
  'Mariam', 'Hassan', 'Layla', 'Rashid', 'Sara', 'Ali', 'Huda', 'Saeed', 'Amina', 'Tariq',
  'Salma', 'Faisal', 'Reem', 'Majid', 'Hind', 'Nasser', 'Latifa', 'Sultan', 'Shaikha',
  'Abdullah', 'Moza', 'Hamdan', 'Priya', 'Rajesh', 'Anil', 'Deepa', 'John', 'Michael',
  'Sarah', 'Emily', 'David', 'Maria'];

const LAST = ['Al Maktoum', 'Al Suwaidi', 'Al Nuaimi', 'Al Qasimi', 'Al Falasi', 'Al Marri',
  'Al Shamsi', 'Al Mansoori', 'Ibrahim', 'Haddad', 'Khan', 'Sharma', 'Nair', 'Menon',
  'Fernandes', 'Smith', 'Garcia', 'Ahmed', 'Saeed', 'Rahman'];

const BRANCHES = ['Dubai', 'Sharjah', 'Abu Dhabi', 'Al Ain'];

/** Services as they appear in the website dropdown, with tier and price band. */
const SERVICES = [
  { label: 'Oil Change',                       cat: 'oil_change', type: 'service',    tier: 'tier1_routine',    lo: 150,  hi: 420 },
  { label: 'Tyre Change/Replacement Service',  cat: 'tire_service', type: 'repair',     tier: 'tier1_routine',    lo: 400,  hi: 2200 },
  { label: 'Battery Replacement',              cat: 'electrical', type: 'service',    tier: 'tier1_routine',    lo: 280,  hi: 900 },
  { label: 'Brake Service',                    cat: 'brake_repair', type: 'repair',     tier: 'tier1_routine',    lo: 350,  hi: 1600 },
  { label: 'AC Service & Repair',              cat: 'electrical', type: 'repair',     tier: 'tier2_diagnostic', lo: 300,  hi: 2400 },
  { label: 'Engine Diagnostics',               cat: 'diagnostic', type: 'diagnostic', tier: 'tier2_diagnostic', lo: 200,  hi: 800 },
  { label: 'Mechanical Repairs',               cat: 'engine_repair', type: 'repair',     tier: 'tier2_diagnostic', lo: 600,  hi: 5200 },
  { label: 'Suspension Repair',                cat: 'other', type: 'repair',     tier: 'tier2_diagnostic', lo: 700,  hi: 3800 },
  { label: 'Transmission Repair',              cat: 'transmission', type: 'repair',     tier: 'tier3_major',      lo: 2500, hi: 14000 },
  { label: 'Engine Overhaul',                  cat: 'engine_repair', type: 'repair',     tier: 'tier3_major',      lo: 4000, hi: 22000 },
  { label: 'Body Work & Paint',                cat: 'bodywork', type: 'bodywork',   tier: 'tier3_major',      lo: 1200, hi: 9500 },
  { label: 'Accident Repair',                  cat: 'bodywork', type: 'accident',   tier: 'tier3_major',      lo: 2000, hi: 18000 },
  { label: 'Periodic Maintenance',             cat: 'general_maintenance', type: 'service',    tier: 'tier1_routine',    lo: 450,  hi: 1800 },
];

const VEHICLES = [
  ['Toyota', 'Land Cruiser'], ['Toyota', 'Camry'], ['Toyota', 'Hilux'],
  ['Nissan', 'Patrol'], ['Nissan', 'Altima'], ['Nissan', 'X-Trail'],
  ['Mitsubishi', 'Pajero'], ['Mitsubishi', 'L200'],
  ['Ford', 'Explorer'], ['Ford', 'F-150'],
  ['Chevrolet', 'Tahoe'], ['Chevrolet', 'Malibu'],
  ['Hyundai', 'Tucson'], ['Hyundai', 'Sonata'],
  ['Kia', 'Sportage'], ['Kia', 'Seltos'],
  ['Honda', 'Accord'], ['Honda', 'CR-V'],
  ['Mercedes-Benz', 'G-Class'], ['Mercedes-Benz', 'C200'],
  ['BMW', 'X5'], ['BMW', '520i'],
  ['Lexus', 'LX570'], ['Land Rover', 'Range Rover'],
];

/**
 * Where enquiries come from. Weighted, because the mix is the point of the
 * "Conversion by channel" panel — an even split across four channels never
 * happens in practice.
 */
const CHANNELS = [
  { channel: 'search_discovery',  weight: 42, methods: ['website_form', 'phone'],
    details: ['website-contact-form', 'google-search', 'landing-page-promo', 'instagram-ad', 'google-maps'] },
  { channel: 'owned_repeat',      weight: 27, methods: ['whatsapp', 'phone', 'email'],
    details: ['repeat-customer', 'sms-reminder', 'referral-friend', 'service-due-reminder'] },
  { channel: 'passing_local',     weight: 19, methods: ['walk_in'],
    details: ['walk-in', 'passing-signage', 'drive-by'] },
  { channel: 'partner_referred',  weight: 12, methods: ['partner_handoff', 'phone'],
    details: ['insurance-partner', 'fleet-contract', 'dealer-referral', 'recovery-truck'] },
];

const PAYERS = [
  { v: 'self_pay',  weight: 68 },
  { v: 'insurance', weight: 16 },
  { v: 'corporate', weight: 10 },
  { v: 'fleet',     weight: 6 },
];

const NOTES = [
  'Front tyres worn on the inside edge, wants a quote for a full set.',
  'Grinding noise from the front when braking, worse in the morning.',
  'AC blows warm after twenty minutes of driving.',
  'Service light came on, due for the 60,000 km service.',
  'Car will not start, suspects the battery. Needs recovery.',
  'Steering pulls to the right after hitting a kerb.',
  'Oil leak on the driveway, small patch each morning.',
  'Rear bumper scraped in a car park, wants a paint match.',
  'Engine warning light on, no obvious change in performance.',
  'Juddering when pulling away from a stop.',
  'Annual service and inspection before a long drive to Oman.',
  'Overheating in traffic, temperature gauge climbing.',
  'Insurance claim, third-party damage to the driver side door.',
  'Fleet vehicle, scheduled maintenance for four cars this month.',
  'Suspension knocking over speed bumps.',
  'Needs a pre-purchase inspection this week if possible.',
];

/* ── Helpers ───────────────────────────────────────────────────────────── */

const pick = a => a[Math.floor(Math.random() * a.length)];
const rint = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function weighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const i of items) { r -= i.weight; if (r <= 0) return i; }
  return items[items.length - 1];
}

// MySQL DATETIME carries no timezone, so it must be written in the same clock
// the rest of the app reads it in. toISOString() converts to UTC first, which
// shifted every seeded timestamp by the local offset - enough to put rows on
// the wrong day near midnight, and to date a follow-up before its own enquiry.
const pad2 = n => String(n).padStart(2, '0');
const mysqlDate = d =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/**
 * Insert a row whose reference number must be unique, retrying on collision.
 *
 * enquiry_number and work_order_number are both unique-indexed, and the app's
 * format gives only 9000 suffixes per day (WO-YYYYMMDD-NNNN). Seeding two
 * months of history draws enough numbers that a duplicate is roughly a coin
 * flip, and on an install with existing history it is likelier still - which
 * aborted a staging run partway through, after --clean had already emptied the
 * table. Generating a number and hoping is not good enough.
 *
 * @param sql          the INSERT, with the number as one of its placeholders
 * @param params       parameter array; the slot at numberIndex is replaced
 * @param numberIndex  which parameter holds the reference number
 * @param makeNumber   called per attempt; returns a fresh candidate
 */
async function insertUnique(sql, params, numberIndex, makeNumber, attempts = 30) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const p = params.slice();
    // Widen the suffix once simple retries start failing, so a crowded day
    // cannot deadlock the run.
    p[numberIndex] = makeNumber(i >= 20);
    try {
      return await execute(sql, p);
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      lastErr = e;
    }
  }
  throw new Error(`could not allocate a unique number after ${attempts} attempts: ${lastErr?.message}`);
}

/** A plausible enquiry time: business hours, Saturday-Thursday weighted. */
function timeOnDay(daysAgo) {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(rint(8, 19), rint(0, 59), rint(0, 59), 0);
  // Today's enquiries must not be stamped later than right now - a created_at
  // in the future is visibly wrong on the page and skews "today" counts.
  if (d > now) d.setTime(now.getTime() - rint(1, 90) * 60000);
  return d;
}

/**
 * How many enquiries land on a given day. Recent days are busy, older days
 * thin out, and Fridays are quiet — a flat distribution reads as fake.
 */
function volumeFor(daysAgo) {
  const dow = new Date(Date.now() - daysAgo * 86400000).getDay();
  const friday = dow === 5 ? 0.35 : 1;
  let base;
  if (daysAgo === 0) base = rint(9, 14);
  else if (daysAgo === 1) base = rint(8, 12);
  else if (daysAgo <= 7) base = rint(4, 7);
  else if (daysAgo <= 30) base = rint(2, 5);
  else base = rint(1, 3);
  return Math.max(0, Math.round(base * friday));
}

/* ── Clean ─────────────────────────────────────────────────────────────── */

async function clean(workshopId) {
  console.log(`Removing rows tagged ${SEED_TAG} ...`);
  const rows = await query(
    'SELECT id, converted_work_order_id FROM enquiries WHERE workshop_id = ? AND external_reference LIKE ?',
    [workshopId, `${SEED_TAG}-%`]
  );
  // Work orders first: the enquiry row cannot be removed while a work order
  // still references it, and routes/enquiries.js refuses to delete a converted
  // enquiry for the same reason.
  const woIds = rows.map(r => r.converted_work_order_id).filter(Boolean);
  for (const id of woIds) {
    await execute('DELETE FROM work_orders WHERE id = ? AND workshop_id = ?', [id, workshopId]).catch(() => {});
  }
  const del = await execute(
    'DELETE FROM enquiries WHERE workshop_id = ? AND external_reference LIKE ?',
    [workshopId, `${SEED_TAG}-%`]
  );
  const cust = await execute(
    "DELETE FROM customers WHERE workshop_id = ? AND notes = ?",
    [workshopId, `[${SEED_TAG}]`]
  ).catch(() => ({ affectedRows: 0 }));

  console.log(`  work orders removed : ${woIds.length}`);
  console.log(`  enquiries removed   : ${del.affectedRows ?? 0}`);
  console.log(`  customers removed   : ${cust.affectedRows ?? 0}`);
}

/* ── Seed ──────────────────────────────────────────────────────────────── */

async function seed(workshopId) {
  const label = MIX ? 'a realistic status mix' : 'all converted';
  console.log(`Seeding ${DAYS} days of enquiries for workshop ${workshopId} (${label}) ...\n`);

  let made = 0, converted = 0, revenue = 0;
  const byChannel = {};
  const byDay = [];

  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
    const n = volumeFor(daysAgo);
    if (daysAgo <= 1) byDay.push([daysAgo, n]);

    for (let i = 0; i < n; i++) {
      const createdAt = timeOnDay(daysAgo);
      const svc = pick(SERVICES);
      const ch = weighted(CHANNELS);
      const payer = weighted(PAYERS).v;
      const [make, model] = pick(VEHICLES);
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const phone = `+9715${pick(['0', '2', '4', '5', '6'])}${rint(1000000, 9999999)}`;
      const email = Math.random() < 0.72
        ? `${name.toLowerCase().replace(/[^a-z]/g, '.')}${rint(1, 99)}@example.com`
        : null;
      const year = rint(2012, 2025);
      const plate = `${pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])}-${rint(10000, 99999)}`;
      const quoted = rint(svc.lo, svc.hi);

      const ref = `${SEED_TAG}-${mysqlDate(createdAt).slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

      // Status. Default is "everything converted"; --mix produces a spread.
      let status = 'converted';
      if (MIX) {
        const r = Math.random();
        if (daysAgo <= 1) status = r < 0.20 ? 'converted' : r < 0.55 ? 'quoted' : r < 0.80 ? 'new' : 'nurture';
        else status = r < 0.46 ? 'converted' : r < 0.62 ? 'quoted' : r < 0.82 ? 'lost' : r < 0.93 ? 'nurture' : 'new';
      }

      const quotedAt = new Date(createdAt.getTime() + rint(20, 300) * 60000);
      const convertedAt = new Date(quotedAt.getTime() + rint(30, 2880) * 60000);

      // A customer record, so CONTACT resolves and the Customers page grows too.
      let customerId = null;
      const [existing] = await query(
        'SELECT id FROM customers WHERE workshop_id = ? AND phone = ? LIMIT 1', [workshopId, phone]
      );
      if (existing) customerId = existing.id;
      else {
        const c = await execute(
          `INSERT INTO customers (workshop_id, full_name, phone, email, city, notes, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [workshopId, name, phone, email, pick(BRANCHES), `[${SEED_TAG}]`, mysqlDate(createdAt)]
        );
        customerId = c.insertId;
      }

      const enqDay = mysqlDate(createdAt).slice(0, 10).replace(/-/g, '');
      const makeEnqNumber = wide =>
        `ENQ-${enqDay}-${wide ? rint(100000, 999999) : rint(1000, 9999)}`;
      let enqNumber = makeEnqNumber(false);

      const enq = await insertUnique(
        `INSERT INTO enquiries
           (workshop_id, enquiry_number, external_reference, customer_id,
            contact_name, contact_phone, contact_email,
            vehicle_description, vehicle_plate,
            enquiry_type, service_tier, description,
            quoted_amount, quoted_at,
            source_channel, source_detail, contact_method, payer_type,
            status, follow_up_at, branch, service_requested, preferred_date,
            intake_origin, raw_payload, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          workshopId, enqNumber, ref, customerId,
          name, phone, email,
          `${make} ${model} ${year}`, plate,
          svc.type, svc.tier, pick(NOTES),
          status === 'new' ? null : quoted,
          status === 'new' ? null : mysqlDate(quotedAt),
          ch.channel, pick(ch.details), pick(ch.methods), payer,
          status,
          // Only open work carries a follow-up date.
          ['quoted', 'nurture'].includes(status)
            ? mysqlDate(new Date(createdAt.getTime() + rint(-2, 5) * 86400000))
            : null,
          pick(BRANCHES), svc.label,
          Math.random() < 0.4 ? mysqlDate(new Date(createdAt.getTime() + rint(1, 10) * 86400000)).slice(0, 10) : null,
          Math.random() < 0.5 ? 'api' : 'internal',
          JSON.stringify({ seeded: true, tag: SEED_TAG }),
          mysqlDate(createdAt), mysqlDate(createdAt),
        ],
        1, makeEnqNumber
      );

      // Conversion mirrors routes/enquiries.js: a real work order, linked both ways.
      if (status === 'converted') {
        const woDay = mysqlDate(convertedAt).slice(0, 10).replace(/-/g, '');
        const makeWoNumber = wide =>
          `WO-${woDay}-${wide ? rint(100000, 999999) : rint(1000, 9999)}`;
        const woNumber = makeWoNumber(false);
        const wo = await insertUnique(
          `INSERT INTO work_orders
             (workshop_id, work_order_number, customer_id, customer_name, customer_phone,
              customer_email, description, service_category, work_order_type,
              service_tier, payer_type, enquiry_id, service_fee, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            workshopId, woNumber, customerId, name, phone, email,
            `${svc.label} — ${make} ${model}`, svc.cat, pick(['standard','scheduled','express']),
            svc.tier, payer, enq.insertId, quoted,
            daysAgo > 3 ? 'completed' : pick(['pending', 'assigned', 'in_progress']),
            mysqlDate(convertedAt), mysqlDate(convertedAt),
          ],
          1, makeWoNumber
        );
        await execute(
          'UPDATE enquiries SET converted_work_order_id = ?, converted_at = ? WHERE id = ?',
          [wo.insertId, mysqlDate(convertedAt), enq.insertId]
        );
        converted++;
        revenue += quoted;
      }

      byChannel[ch.channel] = (byChannel[ch.channel] || 0) + 1;
      made++;
    }
  }

  console.log(`  created            : ${made} enquiries`);
  console.log(`  converted          : ${converted} (${made ? Math.round(converted / made * 100) : 0}%), each with a work order`);
  console.log(`  quoted value       : AED ${revenue.toLocaleString()}`);
  for (const [d, n] of byDay) console.log(`  ${d === 0 ? 'today' : 'yesterday'.padEnd(5)}              : ${n}`);
  console.log('  by channel         :');
  for (const [k, v] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(18)} ${v}`);
  }
  console.log(`\nRe-run with --clean to remove exactly these rows.`);
}

/* ── Main ──────────────────────────────────────────────────────────────── */

(async () => {
  let workshopId = WORKSHOP;
  if (!workshopId) {
    const [ws] = await query('SELECT id, name FROM workshops ORDER BY id ASC LIMIT 1');
    if (!ws) { console.error('No workshop found.'); process.exit(1); }
    workshopId = ws.id;
  }

  if (CLEAN) await clean(workshopId);
  else await seed(workshopId);

  process.exit(0);
})().catch(err => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
