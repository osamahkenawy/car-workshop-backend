#!/usr/bin/env node
/**
 * seed-complaints.js — realistic complaint history for the Complaints page
 * and the Customer Experience dashboard's complaints card, both of which
 * read live from `disputes` (see routes/disputes.js) and show nothing
 * useful on a fresh install: 0 total, no SLA figures, "Coming soon"-shaped
 * emptiness.
 *
 * Spreads at least 9 complaints across each calendar month from
 * MONTHS_BACK months ago through the current month (today capped, so the
 * in-progress month isn't overfilled with future-dated rows), with a
 * realistic mix of intake channels, statuses, SLA outcomes and resolution
 * times — not a flat "N identical rows per month". Older months skew
 * resolved/closed; the trailing couple of weeks skew open/investigating,
 * the way a real queue looks.
 *
 * Linked to real customers and, where a plausible one exists, a real
 * completed work order — this is meant to make an existing installation's
 * dashboards tell a believable story, not to exercise the API.
 *
 *   node scripts/seed-complaints.js                 # seed (9-15/month, last 9 months)
 *   node scripts/seed-complaints.js --months 6
 *   node scripts/seed-complaints.js --workshop 3
 *   node scripts/seed-complaints.js --clean          # remove exactly what this created
 *
 * --clean works off scripts/data/.seed-complaints-ids.json, written on
 * seed and deleted on clean — there's no in-app tag to key off (case
 * numbers and reason text are meant to read as real, not flagged), so the
 * id list is the only record of what was seeded.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, execute } from '../src/lib/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACK_FILE = path.join(__dirname, 'data', '.seed-complaints-ids.json');

const argv = process.argv.slice(2);
const CLEAN = argv.includes('--clean');
const num = (flag, d) => { const i = argv.indexOf(flag); return i > -1 ? Number(argv[i + 1]) : d; };
const MONTHS_BACK = num('--months', 9);
const WORKSHOP_ARG = num('--workshop', 0);

const pick = a => a[Math.floor(Math.random() * a.length)];
const rint = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const chance = p => Math.random() < p;
const weighted = pairs => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
};

const pad = n => String(n).padStart(2, '0');
const mysqlDt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const addHours = (d, h) => new Date(d.getTime() + h * 3600000);

/* ── Reason bank — each tagged with a plausible amount range (0 for
   non-billing complaints) so the numbers on a complaint read as belonging
   to its own story rather than a random dollar figure. ────────────────── */
const REASONS = [
  { text: 'Charged more than the quoted estimate for the repair — no one called to explain the extra work before it was done.', amount: [180, 950] },
  { text: 'Vehicle was ready two days later than promised, with no update until I called in myself.', amount: [0, 0] },
  { text: 'The same noise came back within a week of the repair it was supposedly fixed for.', amount: [0, 0] },
  { text: 'Invoice included a diagnostic fee I was told would be waived since I went ahead with the repair.', amount: [80, 250] },
  { text: 'Oil stains were left on the driver seat and floor mat after the service.', amount: [0, 0] },
  { text: 'Was quoted one price over the phone and charged a higher one at pickup.', amount: [150, 1200] },
  { text: 'The service reminder light was never reset after the oil change.', amount: [0, 0] },
  { text: 'Called three times about the delay and no one returned the call.', amount: [0, 0] },
  { text: 'New brake pads are squealing already, worse than before the service.', amount: [0, 0] },
  { text: 'The wrong part was fitted — had to bring the car back a second time for the same job.', amount: [0, 0] },
  { text: "Wasn't told the warranty wouldn't cover the part that was replaced, only found out on the invoice.", amount: [300, 2200] },
  { text: "Paint touch-up doesn't match the original colour on the panel.", amount: [0, 0] },
  { text: "Car came back with a scratch on the bumper that wasn't there at drop-off.", amount: [0, 0] },
  { text: 'Charged for more labour hours than the original estimate without being told beforehand.', amount: [200, 1500] },
  { text: "AC still isn't cooling properly after paying for the recharge service.", amount: [0, 0] },
  { text: 'Was promised a courtesy car and none was available on the day.', amount: [0, 0] },
  { text: 'The invoice lists a part that was never actually replaced.', amount: [250, 900] },
  { text: 'Left a voicemail for a status update four days ago, still no callback.', amount: [0, 0] },
];

/* ── Resolution templates, keyed by outcome — used only for
   resolved/closed complaints. ─────────────────────────────────────────── */
const RESOLUTIONS = {
  refund_due: [
    'Reviewed the job card against the original estimate — the extra charge was not pre-approved, so a refund was issued for the difference.',
    'Confirmed the part billed was not the one fitted. Refunded the line item.',
  ],
  charge_correct: [
    'Walked the customer through the job card and photos taken during the work — the additional labour matched what was actually required. Charge stands, explained clearly.',
    'Estimate covered parts only per the original quote; the labour line was itemised separately from the start. No adjustment due.',
  ],
  partial_refund: [
    'Partial refund agreed — the diagnostic fee should have been waived per policy, the labour charge itself was correct.',
    'Split the difference: goodwill refund for the delay, full charge retained for the work performed.',
  ],
  goodwill: [
    'No billing error found, but offered a complimentary detail as a goodwill gesture for the inconvenience.',
    'Free re-check booked at no charge and a discount applied to the next visit as a gesture of goodwill.',
  ],
};
const CHANGES_MADE = [
  'Re-briefed the service advisor on confirming any cost change with the customer before proceeding.',
  'Job card now requires a supervisor sign-off before any diagnostic fee is applied to a completed repair.',
  'Added a callback checklist step so status updates go out proactively during multi-day repairs.',
  'None — process was followed correctly; logged for visibility only.',
];

const INTAKE = [['phone', 35], ['in_person', 28], ['whatsapp', 22], ['email', 10], ['portal', 5]];
const OUTCOME = [['refund_due', 25], ['charge_correct', 30], ['partial_refund', 20], ['goodwill', 25]];
const AUTHORITY = [['advisor', 65], ['manager', 28], ['senior', 7]];

function monthRange(monthsBack) {
  const now = new Date();
  const months = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() }); // month: 0-based
  }
  return months;
}

function randomDateInMonth(year, month) {
  const now = new Date();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const maxDay = isCurrentMonth ? now.getDate() : daysInMonth;
  const day = rint(1, Math.max(1, maxDay));
  const d = new Date(year, month, day, rint(8, 19), pick([0, 15, 30, 45]), rint(0, 59));
  return d > now ? now : d;
}

async function main() {
  const workshopId = WORKSHOP_ARG || (await query('SELECT id FROM workshops LIMIT 1'))[0]?.id;
  if (!workshopId) throw new Error('No workshop found');

  if (CLEAN) {
    if (!fs.existsSync(TRACK_FILE)) {
      console.log('No scripts/data/.seed-complaints-ids.json found — nothing to clean.');
      return;
    }
    const ids = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
    if (!ids.length) { console.log('Tracking file is empty — nothing to clean.'); fs.unlinkSync(TRACK_FILE); return; }
    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `DELETE FROM disputes WHERE workshop_id = ? AND id IN (${placeholders})`,
      [workshopId, ...ids]
    );
    fs.unlinkSync(TRACK_FILE);
    console.log(`Removed ${result.affectedRows} seeded complaint(s). Tracking file deleted.`);
    return;
  }

  const customers = await query(
    `SELECT id FROM customers WHERE workshop_id = ? AND is_active = 1 ORDER BY RAND() LIMIT 300`,
    [workshopId]
  );
  if (!customers.length) throw new Error('No customers found for this workshop — seed customers first.');

  const workOrders = await query(
    `SELECT id, customer_id FROM work_orders
      WHERE workshop_id = ? AND status = 'completed' AND customer_id IS NOT NULL
      ORDER BY RAND() LIMIT 400`,
    [workshopId]
  );
  const woByCustomer = new Map();
  for (const wo of workOrders) {
    if (!woByCustomer.has(wo.customer_id)) woByCustomer.set(wo.customer_id, []);
    woByCustomer.get(wo.customer_id).push(wo.id);
  }

  const staff = await query(
    `SELECT id FROM users WHERE workshop_id = ? AND is_active = 1 AND role IN ('admin','dispatcher') LIMIT 20`,
    [workshopId]
  );
  const staffPool = staff.length ? staff.map(u => u.id) : [null];

  const months = monthRange(MONTHS_BACK);
  const insertedIds = [];
  const summary = [];

  for (const { year, month } of months) {
    const now = new Date();
    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
    const count = isCurrentMonth ? rint(9, 12) : rint(9, 15);
    let inserted = 0;

    for (let i = 0; i < count; i++) {
      const createdAt = randomDateInMonth(year, month);
      const ageDays = (now - createdAt) / 86400000;

      const customer = pick(customers);
      const customerWos = woByCustomer.get(customer.id) || [];
      const workOrderId = customerWos.length && chance(0.55) ? pick(customerWos) : null;

      const reasonEntry = pick(REASONS);
      const amount = reasonEntry.amount[1] > 0 ? rint(reasonEntry.amount[0], reasonEntry.amount[1]) : 0;

      // Older complaints have had time to move through the queue; recent
      // ones look like a real in-progress inbox.
      const status = ageDays > 14
        ? weighted([['resolved', 60], ['closed', 25], ['investigating', 10], ['open', 5]])
        : weighted([['open', 40], ['investigating', 35], ['resolved', 20], ['closed', 5]]);

      let acknowledgedAt = null;
      if (status !== 'open' || chance(0.6)) {
        const ackHours = chance(0.8) ? rint(1, 20) : rint(24, 72);
        const candidate = addHours(createdAt, ackHours);
        acknowledgedAt = candidate > now ? null : candidate;
      }

      const responseDueAt = addHours(createdAt, 48);

      let resolvedAt = null, outcome = 'pending', outcomeCommunicatedAt = null, resolution = null, changesMade = null;
      if ((status === 'resolved' || status === 'closed') && acknowledgedAt) {
        const candidate = addHours(acknowledgedAt, rint(4, 96));
        resolvedAt = candidate > now ? now : candidate;
        outcome = weighted(OUTCOME);
        resolution = pick(RESOLUTIONS[outcome]);
        changesMade = pick(CHANGES_MADE);
        if (chance(0.85)) {
          const commCandidate = addHours(resolvedAt, rint(0, 24));
          outcomeCommunicatedAt = commCandidate > now ? now : commCandidate;
        }
      }

      const stamp = `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}`;
      const caseNumber = `CMP-${stamp}-${rint(1000, 9999)}`;

      const result = await execute(
        `INSERT INTO disputes
           (workshop_id, work_order_id, customer_id, amount, reason, status,
            case_number, owner_user_id, intake_channel, acknowledged_at, response_due_at,
            outcome, outcome_communicated_at, authority_level, resolution, changes_made,
            resolved_by, resolved_at, created_by, created_at)
         VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?)`,
        [
          workshopId, workOrderId, customer.id, amount, reasonEntry.text, status,
          caseNumber, pick(staffPool), weighted(INTAKE), acknowledgedAt ? mysqlDt(acknowledgedAt) : null, mysqlDt(responseDueAt),
          outcome, outcomeCommunicatedAt ? mysqlDt(outcomeCommunicatedAt) : null, weighted(AUTHORITY), resolution, changesMade,
          resolvedAt ? pick(staffPool) : null, resolvedAt ? mysqlDt(resolvedAt) : null, pick(staffPool), mysqlDt(createdAt),
        ]
      );
      insertedIds.push(result.insertId);
      inserted++;
    }

    summary.push({ label: `${year}-${pad(month + 1)}`, count: inserted });
  }

  fs.mkdirSync(path.dirname(TRACK_FILE), { recursive: true });
  fs.writeFileSync(TRACK_FILE, JSON.stringify(insertedIds));

  console.log('Seeded complaints by month:');
  summary.forEach(s => console.log(`  ${s.label}: ${s.count}`));
  console.log(`\nTotal inserted: ${insertedIds.length}`);
  console.log(`Tracked in ${path.relative(process.cwd(), TRACK_FILE)} for --clean.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
