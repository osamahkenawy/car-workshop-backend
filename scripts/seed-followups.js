#!/usr/bin/env node
/**
 * seed-followups.js — put follow-up activity on last week's enquiries.
 *
 * The Enquiries page counts follow-ups due as
 *   follow_up_at <= NOW() AND status IN ('new','quoted','nurture')
 * (routes/enquiries.js /stats). A converted enquiry therefore never counts, no
 * matter what date is on it — which is correct, since there is nothing left to
 * chase once the work order exists.
 *
 * So this does two things over the chosen window:
 *   - sets follow_up_at on enquiries, spread across the week: some overdue,
 *     some today, some still upcoming
 *   - moves a slice of them off 'converted' to 'quoted' or 'nurture', so the
 *     Follow-ups due and In nurture cards have something real to count
 *
 * Moving one off converted also removes its work order and clears the link.
 * Leaving a row marked 'quoted' while still pointing at a work order would be
 * inconsistent state, and the page would show a WO number next to an open
 * status.
 *
 *   node scripts/seed-followups.js                 # last 7 days, ~18 opened
 *   node scripts/seed-followups.js --days 14 --open 30
 *   node scripts/seed-followups.js --dates-only    # add dates, change no status
 *
 * Only touches rows created by seed-enquiries.js (tagged in
 * external_reference), so real enquiries are never modified.
 */

import { query, execute } from '../src/lib/database.js';

const SEED_TAG = 'SEED-ENQ';

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); return i > -1 ? Number(argv[i + 1]) : d; };

const DAYS = num('--days', 7);
const OPEN = num('--open', 18);
const DATES_ONLY = has('--dates-only');
const WORKSHOP = num('--workshop', 0);

const pick = a => a[Math.floor(Math.random() * a.length)];
const rint = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
// MySQL DATETIME carries no timezone, so it must be written in the same clock
// the rest of the app reads it in. toISOString() converts to UTC first, which
// shifted every seeded timestamp by the local offset - enough to put rows on
// the wrong day near midnight, and to date a follow-up before its own enquiry.
const pad2 = n => String(n).padStart(2, '0');
const mysqlDate = d =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** Why an enquiry is still open. Feeds the lost-reasons breakdown. */
const NURTURE_REASONS = ['price', 'timing', 'no_response', 'went_elsewhere', 'other'];

const NURTURE_NOTES = [
  'Wants to wait until after payday, asked us to call back next week.',
  'Comparing our quote against two other garages.',
  'Parts on order from the supplier, customer informed.',
  'Waiting for insurance to confirm the claim before approving work.',
  'Asked us to check back once the car is out of warranty.',
  'Said the price was higher than expected, offered a revised quote.',
  'Left a voicemail twice, no answer yet.',
];

(async () => {
  let workshopId = WORKSHOP;
  if (!workshopId) {
    const [ws] = await query('SELECT id FROM workshops ORDER BY id ASC LIMIT 1');
    if (!ws) { console.error('No workshop found.'); process.exit(1); }
    workshopId = ws.id;
  }

  // Candidates: seeded enquiries raised inside the window.
  const rows = await query(
    `SELECT id, enquiry_number, status, converted_work_order_id, created_at
       FROM enquiries
      WHERE workshop_id = ?
        AND external_reference LIKE ?
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY created_at DESC`,
    [workshopId, `${SEED_TAG}-%`, DAYS]
  );

  if (!rows.length) {
    console.error(`No seeded enquiries in the last ${DAYS} days. Run seed-enquiries.js first.`);
    process.exit(1);
  }

  console.log(`Found ${rows.length} seeded enquiries in the last ${DAYS} days.\n`);

  const toOpen = DATES_ONLY ? [] : rows.slice(0, Math.min(OPEN, rows.length));
  let opened = 0, nurtured = 0, quoted = 0, dated = 0, overdue = 0, upcoming = 0, wosRemoved = 0;

  for (const r of rows) {
    const created = new Date(r.created_at);
    const isOpening = toOpen.includes(r);

    // Follow-up dates spread across the window: most already due (that is the
    // point of the card), a few still ahead so the column is not uniformly red.
    const offsetDays = Math.random() < 0.72 ? rint(-DAYS, 0) : rint(1, 5);
    const followUp = new Date();
    followUp.setDate(followUp.getDate() + offsetDays);
    followUp.setHours(rint(9, 17), pick([0, 15, 30, 45]), 0, 0);
    // Never schedule a follow-up before the enquiry existed.
    if (followUp < created) followUp.setTime(created.getTime() + 3600000);

    if (offsetDays <= 0) overdue++; else upcoming++;

    if (isOpening) {
      // Re-open it: quoted (waiting on the customer) or nurture (re-offer later).
      const status = Math.random() < 0.55 ? 'quoted' : 'nurture';

      if (r.converted_work_order_id) {
        await execute('DELETE FROM work_orders WHERE id = ? AND workshop_id = ?',
          [r.converted_work_order_id, workshopId]).catch(() => {});
        wosRemoved++;
      }

      await execute(
        `UPDATE enquiries
            SET status = ?, follow_up_at = ?,
                converted_work_order_id = NULL, converted_at = NULL,
                lost_reason = ?, lost_notes = ?, updated_at = NOW()
          WHERE id = ?`,
        [
          status, mysqlDate(followUp),
          status === 'nurture' ? pick(NURTURE_REASONS) : null,
          status === 'nurture' ? pick(NURTURE_NOTES) : null,
          r.id,
        ]
      );
      opened++;
      if (status === 'nurture') nurtured++; else quoted++;
    } else {
      // Leave the status alone; just record when it was last chased.
      await execute('UPDATE enquiries SET follow_up_at = ?, updated_at = NOW() WHERE id = ?',
        [mysqlDate(followUp), r.id]);
    }
    dated++;
  }

  // Consistency pass. A row marked converted with no work order shows
  // "Converted" against an empty WO column, and Reports counts no revenue for
  // it. One such row turned up during testing that neither script should have
  // produced, so rather than assume it cannot happen, repair it: give it the
  // work order its status claims.
  const broken = await query(
    `SELECT id, contact_name, contact_phone, contact_email, quoted_amount,
            service_tier, payer_type, service_requested, vehicle_description,
            customer_id, created_at
       FROM enquiries
      WHERE workshop_id = ? AND external_reference LIKE ?
        AND status = 'converted' AND converted_work_order_id IS NULL`,
    [workshopId, `${SEED_TAG}-%`]
  );
  let repaired = 0;
  for (const e of broken) {
    const when = new Date(e.created_at);
    when.setHours(when.getHours() + rint(1, 30));
    // Same collision risk as the main seeder; retry rather than abort.
    const woDay = mysqlDate(when).slice(0, 10).replace(/-/g, '');
    let woNumber = `WO-${woDay}-${rint(1000, 9999)}`;
    let wo = null;
    for (let attempt = 0; attempt < 30 && !wo; attempt++) {
      woNumber = `WO-${woDay}-${attempt >= 20 ? rint(100000, 999999) : rint(1000, 9999)}`;
      try {
        wo = await execute(
      `INSERT INTO work_orders
         (workshop_id, work_order_number, customer_id, customer_name, customer_phone,
          customer_email, description, work_order_type, service_tier, payer_type,
          enquiry_id, service_fee, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'standard', ?,?,?,?, 'completed', ?, ?)`,
      [workshopId, woNumber, e.customer_id, e.contact_name, e.contact_phone,
       e.contact_email, `${e.service_requested || 'Service'} — ${e.vehicle_description || ''}`.trim(),
       e.service_tier, e.payer_type || 'self_pay', e.id, e.quoted_amount || 0,
       mysqlDate(when), mysqlDate(when)]
        );
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    if (!wo) { console.warn(`  could not allocate a work order number for enquiry ${e.id}, skipped`); continue; }
    await execute(
      'UPDATE enquiries SET converted_work_order_id = ?, converted_at = ? WHERE id = ?',
      [wo.insertId, mysqlDate(when), e.id]
    );
    repaired++;
  }
  if (repaired) console.log(`  repaired            : ${repaired} converted row(s) that had no work order`);

  // Report what the page will now show, read back from the same query it uses.
  const [t] = await query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'converted') AS converted,
            SUM(status = 'quoted') AS quoted,
            SUM(status = 'nurture') AS nurture,
            SUM(follow_up_at IS NOT NULL AND follow_up_at <= NOW()
                AND status IN ('new','quoted','nurture')) AS follow_ups_due
       FROM enquiries WHERE workshop_id = ?`,
    [workshopId]
  );

  console.log(`  follow-up dates set : ${dated}  (${overdue} already due, ${upcoming} upcoming)`);
  if (!DATES_ONLY) {
    console.log(`  re-opened           : ${opened}  (${quoted} quoted, ${nurtured} nurture)`);
    console.log(`  work orders removed : ${wosRemoved}  (an open enquiry must not point at one)`);
  }
  console.log('\n  the page will now show:');
  console.log(`      Total enquiries  ${t.total}`);
  console.log(`      Converted        ${t.converted}  (${Math.round(t.converted / t.total * 100)}% conversion)`);
  console.log(`      In nurture       ${t.nurture}`);
  console.log(`      Follow-ups due   ${t.follow_ups_due}`);
  console.log('\n  seed-enquiries.js --clean still removes all of it.');
  process.exit(0);
})().catch(err => {
  console.error('failed:', err.message);
  process.exit(1);
});
