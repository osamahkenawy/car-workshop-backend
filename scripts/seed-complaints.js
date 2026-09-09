#!/usr/bin/env node
/**
 * seed-complaints.js — realistic complaint history for the Complaints page
 * and the Customer Experience dashboard's complaints card, both of which
 * read live from `disputes` (see routes/disputes.js) and show nothing
 * useful on a fresh install: 0 total, no SLA figures, "Coming soon"-shaped
 * emptiness.
 *
 * Monthly volume is a fixed, explicitly-requested schedule rather than a
 * random range — it tapers going backward from the current (partial) month:
 * current month 3, then 9, 8, 7, 6, 5, 4, 3, 2 for each month further back,
 * then 2, 1, 1 for the three months before that, giving a full rolling
 * twelve months. SCHEDULE below is indexed by "months back from now"
 * (0 = current month).
 *
 * The taper is not decoration: it says the CX programme was logging almost
 * nothing a year ago and now captures most of what comes in, which is what
 * a year-on-year complaints chart is for. Reading it as "complaints are
 * getting worse" would be backwards.
 *
 * Each complaint carries the workshop's actual severity classification
 * (see 20260911_complaint_severity_workflow.sql / routes/disputes.js):
 *   S1 safety or repeat failure — 1-2 working day target, root cause mandatory
 *   S2 workmanship or billing   — 3-5 working day target
 *   S3 conduct or information   — 2-3 working day target
 * A second complaint on the same customer within 90 days is auto-flagged
 * repeat and forced to S1, mirroring the backend's own create-time logic —
 * this seed re-implements that check locally rather than going through the
 * API, so it needs to make the same call itself.
 *
 * Linked to real customers and, where a plausible one exists, a real
 * completed work order — this is meant to make an existing installation's
 * dashboards tell a believable story, not to exercise the API.
 *
 *   node scripts/seed-complaints.js                 # seed the fixed schedule, Jan-current month
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
const WORKSHOP_ARG = num('--workshop', 0);

// Index 0 = current (partial) month, 1 = one month back, etc. — the exact
// counts requested: current month 3, then 9/8/7/6/5/4/3/2 going backward,
// extended with 2/1/1 to complete a rolling twelve months.
const SCHEDULE = [3, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1];

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

// Same working-day SLA the backend computes on create (routes/disputes.js
// SEVERITY_META) — skips Fridays only, an approximation, see that file's note.
const SEVERITY_META = {
  S1: { resolveDays: 2, defaultTier: 'manager' },
  S2: { resolveDays: 5, defaultTier: 'manager' },
  S3: { resolveDays: 3, defaultTier: 'advisor' },
};
function addWorkingDays(date, days) {
  const d = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 5) remaining--;
  }
  return d;
}

/* ── Reason bank — each tagged with a plausible amount range (0 for
   non-billing complaints) and the severity it falls under per the policy's
   own classification examples. ────────────────────────────────────────── */
const REASONS = [
  { text: 'Charged more than the quoted estimate for the repair — no one called to explain the extra work before it was done.', amount: [180, 950], severity: 'S2' },
  { text: 'Vehicle was ready two days later than promised, with no update until I called in myself.', amount: [0, 0], severity: 'S2' },
  { text: 'The same noise came back within a week of the repair it was supposedly fixed for.', amount: [0, 0], severity: 'S1' },
  { text: 'Invoice included a diagnostic fee I was told would be waived since I went ahead with the repair.', amount: [80, 250], severity: 'S2' },
  { text: 'Oil stains were left on the driver seat and floor mat after the service.', amount: [0, 0], severity: 'S2' },
  { text: 'Was quoted one price over the phone and charged a higher one at pickup.', amount: [150, 1200], severity: 'S2' },
  { text: 'The service reminder light was never reset after the oil change.', amount: [0, 0], severity: 'S2' },
  { text: 'Called three times about the delay and no one returned the call.', amount: [0, 0], severity: 'S3' },
  { text: 'New brake pads are squealing already, worse than before the service.', amount: [0, 0], severity: 'S1' },
  { text: 'The wrong part was fitted — had to bring the car back a second time for the same job.', amount: [0, 0], severity: 'S2' },
  { text: "Wasn't told the warranty wouldn't cover the part that was replaced, only found out on the invoice.", amount: [300, 2200], severity: 'S2' },
  { text: "Paint touch-up doesn't match the original colour on the panel.", amount: [0, 0], severity: 'S2' },
  { text: "Car came back with a scratch on the bumper that wasn't there at drop-off.", amount: [0, 0], severity: 'S2' },
  { text: 'Charged for more labour hours than the original estimate without being told beforehand.', amount: [200, 1500], severity: 'S2' },
  { text: "AC still isn't cooling properly after paying for the recharge service.", amount: [0, 0], severity: 'S2' },
  { text: 'Was promised a courtesy car and none was available on the day.', amount: [0, 0], severity: 'S3' },
  { text: 'The invoice lists a part that was never actually replaced.', amount: [250, 900], severity: 'S2' },
  { text: 'Left a voicemail for a status update four days ago, still no callback.', amount: [0, 0], severity: 'S3' },
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

// Root cause analysis — required before closing any S1, and for a repeat
// case regardless of severity, per policy.
const ROOT_CAUSES = {
  method: ['No standard step existed for confirming a cost change with the customer before extra work began.', 'Job-card sign-off procedure did not require a supervisor check before closing out the line.'],
  machine: ['Diagnostic equipment calibration was overdue, giving an inconsistent read on the fault.', 'A bay lift service interval was missed, which delayed the job by a day.'],
  material: ['The part received from the supplier did not match the OEM spec logged on the job card.', 'The wrong part was picked from stores against a similar part number.'],
  manpower: ["The technician assigned had not been briefed on this vehicle's known fault history.", 'The advisor covering the desk that day had not been trained on the price-change approval step.'],
  measurement: ['The QC road test was not logged before the vehicle was released.', 'A torque check on the job was not recorded against the QC sheet.'],
  environment: ['The bay was over capacity that week, and the job was rushed to make room.', 'A workload peak that day meant the callback checklist step was skipped.'],
};
const CORRECTIVE_ACTIONS = [
  'Added a mandatory customer sign-off step before any cost change is applied to an open job card.',
  'Scheduled equipment recalibration and added it to the maintenance calendar.',
  'Added a parts-match check against the job card before issue from stores.',
  'Briefing added to the technician handover sheet for repeat-fault vehicles.',
  'QC road test now logged as a required field before a job can be marked ready for pickup.',
  'Callback checklist step made mandatory regardless of workload, with a supervisor spot-check.',
];

const INTAKE = [['phone', 35], ['in_person', 28], ['whatsapp', 22], ['email', 10], ['portal', 5]];
const OUTCOME = [['refund_due', 25], ['charge_correct', 30], ['partial_refund', 20], ['goodwill', 25]];

function scheduleMonths() {
  const now = new Date();
  // Oldest first, so repeat detection below sees a customer's earlier
  // complaint before it generates a later one for the same customer.
  return SCHEDULE.map((count, monthsBack) => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    return { year: d.getFullYear(), month: d.getMonth(), count, monthsBack };
  }).reverse();
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

  // Idempotent re-runs: a second run used to just append another full
  // schedule on top of the first (same bug import-mechanic-kpi.js had before
  // it was fixed) — the tracking file only ever remembers the LAST run, so
  // a second run before a --clean silently orphaned the first run's rows.
  // There's no tag column to key a safe delete off, but every seeded row's
  // `reason` is verbatim one of REASONS below — a real customer complaint
  // is never going to match that text exactly — so deleting by exact reason
  // match within the schedule's date span removes prior seed output (from
  // any number of past runs) without touching a genuine complaint.
  const reasonTexts = REASONS.map(r => r.text);
  const oldestMonth = scheduleMonths()[0];
  const scheduleStart = `${oldestMonth.year}-${pad(oldestMonth.month + 1)}-01`;
  const reasonPlaceholders = reasonTexts.map(() => '?').join(',');
  const del = await execute(
    `DELETE FROM disputes WHERE workshop_id = ? AND created_at >= ? AND reason IN (${reasonPlaceholders})`,
    [workshopId, scheduleStart, ...reasonTexts]
  );
  if (del.affectedRows) console.log(`Removed ${del.affectedRows} row(s) from a prior run before reseeding.\n`);

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


  const months = scheduleMonths();
  const insertedIds = [];
  const summary = [];
  const customerHistory = new Map(); // customerId -> array of prior created_at Dates (this run only)
  const now = new Date();

  for (const { year, month, count } of months) {
    let inserted = 0;

    for (let i = 0; i < count; i++) {
      const createdAt = randomDateInMonth(year, month);
      const ageDays = (now - createdAt) / 86400000;

      const customer = pick(customers);
      const customerWos = woByCustomer.get(customer.id) || [];
      const workOrderId = customerWos.length && chance(0.55) ? pick(customerWos) : null;

      // Repeat detection — same call the backend makes on create: a second
      // complaint on this customer within 90 days forces S1.
      const priorDates = customerHistory.get(customer.id) || [];
      const isRepeat = priorDates.some(d => (createdAt - d) / 86400000 <= 90 && createdAt >= d);
      customerHistory.set(customer.id, [...priorDates, createdAt]);

      const reasonEntry = pick(REASONS);
      const amount = reasonEntry.amount[1] > 0 ? rint(reasonEntry.amount[0], reasonEntry.amount[1]) : 0;
      const severity = isRepeat ? 'S1' : reasonEntry.severity;
      const meta = SEVERITY_META[severity];
      const responseDueAt = addWorkingDays(createdAt, meta.resolveDays);

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

      // Escalation — the "time" trigger from policy (target date passed
      // while still open), surfaced by bumping the owning tier one level.
      let authorityLevel = meta.defaultTier;
      let escalatedAt = null;
      if (['open', 'investigating'].includes(status) && responseDueAt < now && chance(0.5)) {
        authorityLevel = 'senior';
        escalatedAt = addHours(responseDueAt, rint(1, 48));
        if (escalatedAt > now) escalatedAt = now;
      }

      let resolvedAt = null, outcome = 'pending', outcomeCommunicatedAt = null, resolution = null, changesMade = null;
      let customerConfirmedAt = null;
      let rootCause = null, rootCauseCategory = null, correctiveAction = null, correctiveActionOwner = null, correctiveActionDueAt = null;

      // Root cause is mandatory for S1, and done anyway for a repeat case
      // regardless of severity — matches the policy's RCA trigger table.
      const needsRootCause = severity === 'S1' || isRepeat;

      if ((status === 'resolved' || status === 'closed') && acknowledgedAt) {
        // Drawn against this case's own target date, not a spread around it.
        //
        // The earlier version drew uniformly from 24h to twice the target and
        // measured from acknowledgement, which put the mean near the target
        // and therefore breached roughly half of every severity — S1 came out
        // at 21% compliance. That reads as a workshop that misses most of its
        // commitments, which is not what a year of seeded history should
        // assert, and it drives the SLA compliance card on the Complaints
        // page directly.
        //
        // So: most cases land inside target, clustered in the back half of
        // the window because real work finishes near its deadline, and a
        // deliberate minority breach — those are what the escalation and
        // past-target features exist to surface, so the data has to contain
        // some.
        const MET_RATE = 0.82;
        const room = responseDueAt.getTime() - acknowledgedAt.getTime();
        let candidate;
        if (room > 3600000 && chance(MET_RATE)) {
          // Inside target: 45%-98% of the way from acknowledgement to due.
          candidate = new Date(acknowledgedAt.getTime()
            + room * (0.45 + Math.random() * 0.53));
        } else {
          // Breached: past the target by 2 hours to 4 days.
          candidate = addHours(responseDueAt, rint(2, 96));
        }
        resolvedAt = candidate > now ? now : candidate;
        // Never before acknowledgement, whichever branch and clamp applied.
        if (resolvedAt < acknowledgedAt) resolvedAt = addHours(acknowledgedAt, 1);
        outcome = weighted(OUTCOME);
        resolution = pick(RESOLUTIONS[outcome]);
        changesMade = pick(CHANGES_MADE);

        if (needsRootCause || chance(0.3)) {
          rootCauseCategory = pick(Object.keys(ROOT_CAUSES));
          rootCause = pick(ROOT_CAUSES[rootCauseCategory]);
          correctiveAction = pick(CORRECTIVE_ACTIONS);
          correctiveActionOwner = pick(staffPool);
          const dueCandidate = addHours(resolvedAt, rint(24, 30 * 24));
          correctiveActionDueAt = `${dueCandidate.getFullYear()}-${pad(dueCandidate.getMonth() + 1)}-${pad(dueCandidate.getDate())}`;
        }

        if (chance(0.85)) {
          const commCandidate = addHours(resolvedAt, rint(0, 24));
          outcomeCommunicatedAt = commCandidate > now ? now : commCandidate;
        }

        // Customer confirmation is the real close gate. Every 'closed' row
        // must have one; a 'resolved' row sometimes does (ready to close,
        // just not actioned yet) and sometimes doesn't (waiting on the
        // customer) — both are realistic in-flight states.
        if (status === 'closed' || (outcomeCommunicatedAt && chance(0.6))) {
          const confirmCandidate = addHours(outcomeCommunicatedAt || resolvedAt, rint(1, 48));
          customerConfirmedAt = confirmCandidate > now ? now : confirmCandidate;
        }
      }

      const stamp = `${createdAt.getFullYear()}${pad(createdAt.getMonth() + 1)}${pad(createdAt.getDate())}`;
      const caseNumber = `CMP-${stamp}-${rint(1000, 9999)}`;

      const result = await execute(
        `INSERT INTO disputes
           (workshop_id, work_order_id, customer_id, amount, reason, status,
            case_number, owner_user_id, intake_channel, acknowledged_at, response_due_at,
            outcome, outcome_communicated_at, authority_level, resolution, changes_made,
            severity, is_repeat, root_cause, root_cause_category,
            corrective_action, corrective_action_owner, corrective_action_due_at,
            customer_confirmed_at, escalated_at,
            resolved_by, resolved_at, created_by, created_at)
         VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?, ?,?,?,?)`,
        [
          workshopId, workOrderId, customer.id, amount, reasonEntry.text, status,
          caseNumber, pick(staffPool), weighted(INTAKE), acknowledgedAt ? mysqlDt(acknowledgedAt) : null, mysqlDt(responseDueAt),
          outcome, outcomeCommunicatedAt ? mysqlDt(outcomeCommunicatedAt) : null, authorityLevel, resolution, changesMade,
          severity, isRepeat ? 1 : 0, rootCause, rootCauseCategory,
          correctiveAction, correctiveActionOwner, correctiveActionDueAt,
          customerConfirmedAt ? mysqlDt(customerConfirmedAt) : null, escalatedAt ? mysqlDt(escalatedAt) : null,
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
