#!/usr/bin/env node
/**
 * seed-crm.js — realistic data for the three CRM phase-1 screens.
 *
 * The reminder engine only ever produces reminders that are *coming up*,
 * because it derives them from the last completed job plus an interval. That
 * is correct, but it means a fresh install shows an empty "Due now" tab and a
 * 0% conversion figure, which makes a working module look broken. Real
 * workshops have a mix: overdue ones nobody chased, sent ones awaiting a
 * reply, some that turned into bookings, and some the customer declined.
 *
 * So this seeds the *lifecycle*, not just rows:
 *   - reminders spread across overdue / due / sent / booked / snoozed /
 *     dismissed, with sent_at and converted_at that make the conversion
 *     figure add up
 *   - tasks across types, priorities and assignees, some overdue, some
 *     finished this week
 *   - call and note history on customer timelines
 *
 * It also creates a few service advisors, because with one user every task
 * lands on the same person and the by-assignee breakdown says nothing.
 *
 *   node scripts/seed-crm.js            # seed everything
 *   node scripts/seed-crm.js --clean    # remove exactly what this created
 *
 * Cleanup is keyed on authorship, not on text: every task and note is created
 * by one of the seeded advisors, whose usernames carry a marker. An earlier
 * version appended a "[seed:crm]" tag to the body, which then showed to staff
 * in the task list — seed data should not announce itself in the UI. Reminders
 * still carry the tag in `notes`, which no screen renders.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { query, execute } from '../src/lib/database.js';

const TAG = '[seed:crm]';
const ADVISOR_TAG = 'seedadv_';

const argv = process.argv.slice(2);
const CLEAN = argv.includes('--clean');
const wsArg = argv.indexOf('--workshop');
const WORKSHOP = wsArg > -1 ? Number(argv[wsArg + 1]) : 0;

const pick = a => a[Math.floor(Math.random() * a.length)];
const rint = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const chance = p => Math.random() < p;

const pad = n => String(n).padStart(2, '0');
const dt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A date `days` from now (negative = past), at a plausible hour. */
const dayOffset = (days, hour) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour ?? rint(8, 18), pick([0, 15, 30, 45]), rint(0, 59), 0);
  return d;
};

/**
 * Clamp a date to the past.
 *
 * Capping a day offset at 0 is not enough: dayOffset then picks an hour
 * between 08:00 and 18:00, so running the seeder in the early morning stamps
 * "already happened" events later today. Anything that has happened — a
 * reminder sent, a booking taken, a task finished — must be in the past.
 */
const past = d => (d > new Date() ? new Date(Date.now() - rint(5, 240) * 60000) : d);

/* ── Service advisors ──────────────────────────────────────────────────── */

const ADVISORS = [
  { name: 'Nadia Khoury',   role: 'dispatcher' },
  { name: 'Tarek El Sayed', role: 'dispatcher' },
  { name: 'Priya Menon',    role: 'dispatcher' },
];

/* ── Source material ──────────────────────────────────────────────────── */

const TASK_TEMPLATES = [
  { type: 'quote_chase',     pri: 'high',   title: c => `Chase quote with ${c}`,
    detail: 'Quote sent, no answer yet. Second attempt agreed for this week.' },
  { type: 'call_back',       pri: 'normal', title: c => `Call ${c} back about the estimate`,
    detail: 'Asked for a breakdown of parts versus labour before deciding.' },
  { type: 'collect_payment', pri: 'urgent', title: c => `Collect balance from ${c}`,
    detail: 'Vehicle released on account. Balance still outstanding.' },
  { type: 'check_part',      pri: 'normal', title: () => 'Check part arrival with supplier',
    detail: 'Customer waiting on an ETA before approving the work.' },
  { type: 'complaint',       pri: 'urgent', title: c => `Resolve complaint — ${c}`,
    detail: 'Unhappy with the turnaround. Branch manager to call personally.' },
  { type: 'follow_up',       pri: 'normal', title: c => `Follow up after service — ${c}`,
    detail: 'Courtesy check that everything is running well.' },
  { type: 'reminder',        pri: 'low',    title: c => `Book ${c} in for the next service`,
    detail: 'Due soon. Customer asked to be called nearer the time.' },
  { type: 'follow_up',       pri: 'high',   title: c => `Insurance approval — ${c}`,
    detail: 'Waiting on the insurer to authorise the repair before we start.' },
];

const ACTIVITY_TEMPLATES = [
  { type: 'call_out',  subject: 'Called about the quote',
    body: 'Talked through the estimate. Asked us to hold the slot until Thursday.' },
  { type: 'call_in',   subject: 'Customer called for an update',
    body: 'Wanted to know if the parts had arrived. Told them we expect them tomorrow.' },
  { type: 'whatsapp',  subject: 'Sent photos of the worn parts',
    body: 'Sent pictures of the brake discs. Approved the work on the same message.' },
  { type: 'visit',     subject: 'Walked in without an appointment',
    body: 'Dropped by about a warning light. Booked a diagnostic for Saturday morning.' },
  { type: 'call_out',  subject: 'Reminded about the service due',
    body: 'No answer, left a voicemail. Will try again next week.' },
  { type: 'complaint', subject: 'Unhappy with the wait',
    body: 'Job took a day longer than quoted. Apologised and offered a free wash next visit.' },
  { type: 'note',      subject: 'Prefers to be called after 6pm',
    body: 'Works shifts, cannot take calls during the day.' },
  { type: 'email',     subject: 'Emailed the invoice',
    body: 'Sent the invoice and the warranty terms as a PDF.' },
  { type: 'call_in',   subject: 'Asked about a fleet rate',
    body: 'Runs four vehicles, asked whether we do a contract price. Passed to the manager.' },
  { type: 'note',      subject: 'Second key not returned',
    body: 'Spare key left at reception, customer to collect.' },
];

const SNOOZE_NOTES = [
  'Travelling this month, asked us to call back after.',
  'Waiting for the next salary before booking.',
  'Car is with a body shop for accident repair.',
];
const DISMISS_NOTES = [
  'Sold the vehicle.',
  'Moved to Abu Dhabi, servicing there now.',
  'Says they will call us when they are ready.',
];

/* ── Clean ─────────────────────────────────────────────────────────────── */

async function clean(ws) {
  console.log(`Removing ${TAG} data…`);
  // Authorship is the marker. Look the advisors up before deleting them.
  const advisors = await query(
    'SELECT id FROM users WHERE workshop_id = ? AND username LIKE ?', [ws, `${ADVISOR_TAG}%`]
  );
  const ids = advisors.map(a => a.id);
  const inList = ids.length ? `(${ids.map(() => '?').join(',')})` : '(NULL)';

  // The LIKE clauses stay as a fallback for rows seeded by the earlier
  // version, which did write the tag into the text.
  const t = await execute(
    `DELETE FROM crm_tasks WHERE workshop_id = ?
       AND (created_by IN ${inList} OR details LIKE ?)`, [ws, ...ids, `%${TAG}%`]);
  const a = await execute(
    `DELETE FROM customer_activities WHERE workshop_id = ?
       AND (created_by IN ${inList} OR body LIKE ?)`, [ws, ...ids, `%${TAG}%`]);
  // Reminders: only the lifecycle ones this script created or advanced.
  const r = await execute('DELETE FROM service_reminders WHERE workshop_id = ? AND notes LIKE ?', [ws, `%${TAG}%`]);
  const u = await execute('DELETE FROM users WHERE workshop_id = ? AND username LIKE ?', [ws, `${ADVISOR_TAG}%`]);
  console.log(`  tasks      : ${t.affectedRows || 0}`);
  console.log(`  activities : ${a.affectedRows || 0}`);
  console.log(`  reminders  : ${r.affectedRows || 0}`);
  console.log(`  advisors   : ${u.affectedRows || 0}`);
  console.log('\nReminders generated by the engine itself are left alone —');
  console.log('remove those with the Service Reminders page or by status.');
}

/* ── Seed ──────────────────────────────────────────────────────────────── */

async function seed(ws) {
  console.log(`Seeding CRM data for workshop ${ws}…\n`);

  /* 1. Service advisors, so tasks have somewhere to land. */
  const advisorIds = [];
  for (const a of ADVISORS) {
    const username = ADVISOR_TAG + a.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
    const [existing] = await query(
      'SELECT id FROM users WHERE workshop_id = ? AND username = ?', [ws, username]
    );
    if (existing) { advisorIds.push(existing.id); continue; }
    // A random password nobody holds: these exist to be assignable, not to
    // log in. Rotate or delete them before this database sees real use.
    const pw = await bcrypt.hash(crypto.randomBytes(16).toString('base64url'), 10);
    const res = await execute(
      `INSERT INTO users (workshop_id, full_name, username, email, password, role, is_active, email_verified)
       VALUES (?,?,?,?,?,?,1,1)`,
      [ws, a.name, username, `${username}@pioneeruae.com`, pw, a.role]
    );
    advisorIds.push(res.insertId);
  }
  console.log(`  advisors            : ${advisorIds.length} (login disabled — random passwords)`);

  /* 2. Customers who actually have a vehicle and a service history. */
  const people = await query(
    `SELECT c.id, c.full_name, c.phone,
            MIN(v.id) AS vehicle_id,
            MIN(CONCAT(v.make, ' ', v.model)) AS vehicle
       FROM customers c
       JOIN vehicles v ON v.customer_id = c.id AND v.workshop_id = c.workshop_id
      WHERE c.workshop_id = ?
      GROUP BY c.id, c.full_name, c.phone
      ORDER BY RAND() LIMIT 60`,
    [ws]
  );
  if (!people.length) {
    console.error('No customers with vehicles found — seed customers first.');
    process.exit(1);
  }

  /* 3. Reminder lifecycle.

     The engine only makes future-dated reminders. These are the ones a real
     workshop already has behind it: overdue, sent, won, declined. Statuses,
     dates and sent_at are set together so the conversion figure on the page
     is arithmetically honest rather than decorative. */
  const SERVICE_TYPES = ['oil_change', 'general_maintenance', 'brake_repair', 'tire_service', 'diagnostic'];
  const plan = [
    { status: 'due',       n: 16, dueDays: () => rint(-28, -1), sent: false },
    { status: 'sent',      n: 19, dueDays: () => rint(-21, 3),  sent: true  },
    { status: 'booked',    n: 8,  dueDays: () => rint(-18, -2), sent: true, won: true },
    { status: 'converted', n: 4,  dueDays: () => rint(-30, -6), sent: true, won: true },
    { status: 'snoozed',   n: 6,  dueDays: () => rint(-14, -1), sent: true, snooze: true },
    { status: 'dismissed', n: 5,  dueDays: () => rint(-25, -3), sent: true, dismissed: true },
  ];

  let remCreated = 0, remSkipped = 0;
  let pi = 0;
  for (const bucket of plan) {
    for (let k = 0; k < bucket.n; k++) {
      const p = people[pi++ % people.length];
      const due = dayOffset(bucket.dueDays());
      const svc = pick(SERVICE_TYPES);
      // Dates must be derived in the order the events actually happen, not
      // rolled independently: an earlier version produced bookings dated
      // before the reminder that caused them.
      const dueOffset = Math.round((due - new Date()) / 86400000);
      const sentOffset = bucket.sent ? Math.min(dueOffset + rint(0, 3), -1) : null;
      const sentAt = bucket.sent ? dt(past(dayOffset(sentOffset))) : null;
      // A booking lands after the send, and never in the future.
      const wonOffset = bucket.won ? Math.min(sentOffset + rint(1, 8), 0) : null;
      const notes = [
        TAG,
        bucket.snooze ? pick(SNOOZE_NOTES) : null,
        bucket.dismissed ? pick(DISMISS_NOTES) : null,
      ].filter(Boolean).join(' ');

      try {
        await execute(
          `INSERT INTO service_reminders
             (workshop_id, customer_id, vehicle_id, service_type, due_at,
              last_service_at, status, send_channel, sent_at, send_attempts,
              snoozed_until, converted_at, notes, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
          [
            ws, p.id, p.vehicle_id, svc, dd(due),
            dd(past(dayOffset(-rint(180, 400)))),
            bucket.status,
            pick(['whatsapp', 'sms', 'sms', 'email', 'call']),
            sentAt, bucket.sent ? rint(1, 2) : 0,
            bucket.snooze ? dd(dayOffset(rint(7, 45))) : null,
            bucket.won ? dt(past(dayOffset(wonOffset))) : null,
            notes,
          ]
        );
        remCreated++;
      } catch (e) {
        // The UNIQUE key on (workshop, vehicle, service_type, due_at).
        if (e.code === 'ER_DUP_ENTRY') { remSkipped++; continue; }
        throw e;
      }
    }
  }
  console.log(`  reminders           : ${remCreated} created${remSkipped ? `, ${remSkipped} duplicate dates skipped` : ''}`);

  /* 4. Tasks — a working week, not a flat list. */
  const taskPlan = [
    { n: 6, dueDays: () => rint(-9, -1),  status: 'open' },        // overdue
    { n: 5, dueDays: () => 0,             status: 'open' },        // due today
    { n: 6, dueDays: () => rint(1, 10),   status: 'open' },        // ahead
    { n: 3, dueDays: () => rint(-3, 2),   status: 'in_progress' },
    { n: 9, dueDays: () => rint(-7, 0),   status: 'done' },
    { n: 2, dueDays: () => rint(-6, -2),  status: 'cancelled' },
  ];
  let taskCount = 0, unassigned = 0;
  for (const bucket of taskPlan) {
    for (let k = 0; k < bucket.n; k++) {
      const p = people[pi++ % people.length];
      const tpl = pick(TASK_TEMPLATES);
      // A few genuinely unassigned, because that is the state the page's
      // "Unassigned" tab exists to surface.
      const assignTo = chance(0.18) ? null : pick(advisorIds);
      if (!assignTo) unassigned++;
      const dueOff = bucket.dueDays();
      const due = dayOffset(dueOff);
      const done = bucket.status === 'done';
      // Created before it was due, and completed after it was created but
      // never in the future.
      const createdOff = dueOff - rint(1, 5);
      const doneOff = done ? Math.min(createdOff + rint(1, 6), 0) : null;

      await execute(
        `INSERT INTO crm_tasks
           (workshop_id, title, details, task_type, priority, status,
            customer_id, vehicle_id, related_type, assigned_to, due_at,
            completed_at, completed_by, outcome, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,'none',?,?,?,?,?,?,?)`,
        [
          ws,
          tpl.title(p.full_name).slice(0, 200),
          tpl.detail,
          tpl.type,
          chance(0.15) ? 'urgent' : tpl.pri,
          bucket.status,
          p.id, p.vehicle_id,
          assignTo,
          dt(due),
          done ? dt(past(dayOffset(doneOff))) : null,
          done ? (assignTo || advisorIds[0]) : null,
          done ? pick([
            'Spoke to the customer, booked for Saturday.',
            'Payment collected in full.',
            'Part arrived, work approved.',
            'Left a message, will try again.',
            'Customer happy, no further action.',
          ]) : null,
          advisorIds[0] || null,
          dt(past(dayOffset(createdOff))),
        ]
      );
      taskCount++;
    }
  }
  console.log(`  tasks               : ${taskCount} (${unassigned} left unassigned on purpose)`);

  /* 5. Call and note history, so timelines read like a relationship. */
  let actCount = 0;
  for (const p of people.slice(0, 26)) {
    for (let k = 0; k < rint(1, 4); k++) {
      const tpl = pick(ACTIVITY_TEMPLATES);
      await execute(
        `INSERT INTO customer_activities
           (workshop_id, customer_id, vehicle_id, activity_type, subject, body,
            related_type, occurred_at, created_by)
         VALUES (?,?,?,?,?,?, 'none', ?, ?)`,
        [
          ws, p.id, p.vehicle_id, tpl.type, tpl.subject,
          tpl.body,
          dt(past(dayOffset(-rint(1, 75)))),
          pick(advisorIds),
        ]
      );
      actCount++;
    }
  }
  console.log(`  calls & notes       : ${actCount} across 26 customers`);

  /* 6. Read the numbers back from the same queries the pages use, so what is
        printed here is what staff will actually see. */
  const [r] = await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status='due'),0) AS due_now,
            COALESCE(SUM(status='scheduled'),0) AS upcoming,
            COALESCE(SUM(status='sent'),0) AS awaiting,
            COALESCE(SUM(status IN ('booked','converted')),0) AS won,
            COALESCE(SUM(status IN ('due','sent') AND due_at < CURDATE()),0) AS overdue,
            COALESCE(SUM(sent_at IS NOT NULL),0) AS sent_total,
            COALESCE(ROUND(100*SUM(status IN ('booked','converted'))
                  / NULLIF(SUM(sent_at IS NOT NULL),0),1),0) AS conversion
       FROM service_reminders WHERE workshop_id = ?`, [ws]
  );
  const [t] = await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status IN ('open','in_progress')),0) AS open_count,
            COALESCE(SUM(status IN ('open','in_progress') AND due_at <= NOW()),0) AS overdue,
            COALESCE(SUM(status IN ('open','in_progress') AND DATE(due_at)=CURDATE()),0) AS due_today,
            COALESCE(SUM(status IN ('open','in_progress') AND assigned_to IS NULL),0) AS unassigned
       FROM crm_tasks WHERE workshop_id = ?`, [ws]
  );

  console.log('\n  Service Reminders page will show:');
  console.log(`      Due now ${r.due_now} (${r.overdue} overdue) · Upcoming ${r.upcoming} · ` +
    `Awaiting reply ${r.awaiting} · Booked ${r.won}`);
  console.log(`      ${r.conversion}% of the ${r.sent_total} sent turned into a booking`);
  console.log('  Tasks page will show:');
  console.log(`      Overdue ${t.overdue} · Due today ${t.due_today} · Open ${t.open_count} ` +
    `(${t.unassigned} unassigned) · ${t.total} in total`);
  console.log(`\n  node scripts/seed-crm.js --clean removes exactly this.`);
}

/* ── Main ──────────────────────────────────────────────────────────────── */

(async () => {
  let ws = WORKSHOP;
  if (!ws) {
    const [w] = await query('SELECT id FROM workshops ORDER BY id ASC LIMIT 1');
    if (!w) { console.error('No workshop found.'); process.exit(1); }
    ws = w.id;
  }
  if (CLEAN) await clean(ws); else await seed(ws);
  process.exit(0);
})().catch(err => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
