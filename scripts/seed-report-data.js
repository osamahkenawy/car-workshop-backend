#!/usr/bin/env node
/**
 * Seed realistic workshop activity so every Reports tab has something to show.
 *
 * The Reports page reads almost everything off work_orders, so one well-shaped
 * set of work orders fills Overview, Daily Volume, By ServiceBay, Mechanic
 * Performance, Customers, WorkOrder Types, Delivery Time, Payments and
 * Financial at once. Email Schedules comes from report_schedules, seeded too.
 *
 * The data is shaped rather than uniform-random, because a flat distribution
 * makes every chart a straight line and hides whether the report is actually
 * working:
 *   - weekday volume is higher than the Fri/Sat UAE weekend
 *   - a mild upward trend over the period, so the trend charts have a slope
 *   - status depends on age: old jobs are finished, the last few days are
 *     still moving through the workshop
 *   - turnaround varies by service category, with a minority breaching SLA so
 *     the on-time percentage is not a meaningless 100%
 *
 * Usage (from car-workshop-backend/):
 *   node scripts/seed-report-data.js                 # 120 days, workshop 1
 *   node scripts/seed-report-data.js --days=180
 *   node scripts/seed-report-data.js --workshop=2
 *   node scripts/seed-report-data.js --clean         # remove seeded rows only
 *
 * Every row it writes is tagged in work_orders.notes with SEED_TAG, so --clean
 * removes exactly what this script added and never touches real jobs.
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';

const SEED_TAG = '[seed:reports]';

// ── CLI ────────────────────────────────────────────────────────────────────
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const DAYS       = Math.max(1, parseInt(arg('days', '120'), 10));
const WORKSHOP   = parseInt(arg('workshop', '1'), 10);
const CLEAN_ONLY = process.argv.includes('--clean');

// ── Shape of the data ──────────────────────────────────────────────────────
// Weighted so the charts have a recognisable profile instead of noise.
const CATEGORIES = [
  { key: 'oil_change',          weight: 22, fee: [180, 420],   hours: [0.5, 1.5] },
  { key: 'general_maintenance', weight: 18, fee: [350, 1200],  hours: [1.5, 4] },
  { key: 'brake_repair',        weight: 12, fee: [450, 1600],  hours: [2, 5] },
  { key: 'tire_service',        weight: 11, fee: [200, 1800],  hours: [0.5, 2] },
  { key: 'diagnostic',          weight: 10, fee: [150, 500],   hours: [1, 3] },
  { key: 'electrical',          weight:  8, fee: [300, 2200],  hours: [2, 7] },
  { key: 'engine_repair',       weight:  7, fee: [1500, 9000], hours: [8, 40] },
  { key: 'bodywork',            weight:  6, fee: [900, 7500],  hours: [12, 60] },
  { key: 'transmission',        weight:  4, fee: [2000, 11000],hours: [10, 48] },
  { key: 'other',               weight:  2, fee: [150, 800],   hours: [1, 4] },
];

const ORDER_TYPES   = [['standard', 58], ['scheduled', 18], ['express', 12], ['same_day', 8], ['warranty', 4]];
const PAY_METHODS   = [['cash', 46], ['credit', 30], ['prepaid', 14], ['wallet', 10]];
const PRIORITIES    = [['normal', 72], ['urgent', 16], ['express', 8], ['vip', 4]];
const EMIRATES      = [['Dubai', 44], ['Abu Dhabi', 24], ['Sharjah', 18], ['Ajman', 8], ['Ras Al Khaimah', 6]];

/** Pick from [value, weight] pairs. */
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}
function weightedObj(list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of list) { if ((r -= x.weight) < 0) return x; }
  return list[list.length - 1];
}
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const money = (n) => Math.round(n * 100) / 100;
const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Status depends on how long ago the job was booked. Anything older than a few
 * days should have reached a terminal state; only the last few days still hold
 * work in progress. Without this the reports show implausible piles of
 * "pending" jobs from three months ago.
 */
function statusForAge(daysAgo) {
  if (daysAgo <= 0) return weighted([['pending', 30], ['confirmed', 20], ['assigned', 20], ['in_progress', 25], ['completed', 5]]);
  if (daysAgo === 1) return weighted([['in_progress', 30], ['ready_for_pickup', 20], ['completed', 40], ['assigned', 10]]);
  if (daysAgo === 2) return weighted([['completed', 65], ['ready_for_pickup', 15], ['in_progress', 12], ['cancelled', 4], ['failed', 4]]);
  return weighted([['completed', 88], ['cancelled', 6], ['failed', 6]]);
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? 'root',
    database: process.env.DB_NAME || 'car_workshop',
    multipleStatements: false,
  });

  // conn.query resolves to [rows, fields]; this returns just the first row.
  const one = async (sql, params) => { const [r] = await conn.query(sql, params); return r[0]; };

  try {
    // ── Clean mode ─────────────────────────────────────────────────────────
    const before = await one(
      'SELECT COUNT(*) AS n FROM work_orders WHERE workshop_id = ? AND notes LIKE ?',
      [WORKSHOP, `%${SEED_TAG}%`]
    );
    if (CLEAN_ONLY) {
      const [wo] = await conn.execute(
        'DELETE FROM work_orders WHERE workshop_id = ? AND notes LIKE ?',
        [WORKSHOP, `%${SEED_TAG}%`]
      );
      const [sch] = await conn.execute(
        'DELETE FROM report_schedules WHERE workshop_id = ? AND recipients LIKE ?',
        [WORKSHOP, '%seed.reports%']
      );
      console.log(`removed ${wo.affectedRows} seeded work orders and ${sch.affectedRows} seeded schedules`);
      return;
    }
    if (before.n > 0) {
      console.log(`note: ${before.n} previously seeded work orders already exist.`);
      console.log('      run with --clean first if you want to replace rather than add to them.\n');
    }

    // ── Reference data ─────────────────────────────────────────────────────
    const [customers] = await conn.query('SELECT id, full_name, phone FROM customers WHERE workshop_id = ?', [WORKSHOP]);
    const [mechanics] = await conn.query('SELECT id FROM mechanics WHERE workshop_id = ?', [WORKSHOP]);
    const [bays]      = await conn.query('SELECT id FROM service_bays WHERE workshop_id = ?', [WORKSHOP]);
    const [vehicles]  = await conn.query('SELECT id, customer_id FROM vehicles WHERE workshop_id = ?', [WORKSHOP]);

    if (!customers.length || !mechanics.length || !bays.length) {
      throw new Error(
        `workshop ${WORKSHOP} needs customers, mechanics and service bays before reports can be filled ` +
        `(found ${customers.length} / ${mechanics.length} / ${bays.length})`
      );
    }

    // The by-emirate breakdown reads customers.emirate; blank it out and that
    // chart is a single "Unspecified" bar.
    const [emiratesFixed] = await conn.execute(
      `UPDATE customers SET emirate = ELT(1 + FLOOR(RAND() * 5), 'Dubai','Abu Dhabi','Sharjah','Ajman','Ras Al Khaimah')
       WHERE workshop_id = ? AND (emirate IS NULL OR emirate = '')`,
      [WORKSHOP]
    );

    // Mechanic Performance shows a rating column; give anyone missing one a
    // plausible value so the grade/rating column is not all zeros.
    const [ratingsFixed] = await conn.execute(
      `UPDATE mechanics SET rating = ROUND(3.4 + RAND() * 1.6, 2)
       WHERE workshop_id = ? AND (rating IS NULL OR rating = 0)`,
      [WORKSHOP]
    );

    const seq = await one(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(work_order_number, '-', -1) AS UNSIGNED)), 0) AS m
       FROM work_orders WHERE workshop_id = ?`, [WORKSHOP]
    );
    let nextSeq = Number(seq.m) + 1;
    if (!Number.isFinite(nextSeq)) throw new Error('could not determine the next work order number');

    // ── Build the rows ─────────────────────────────────────────────────────
    const rows = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
      const day = new Date(today);
      day.setDate(day.getDate() - daysAgo);
      const dow = day.getDay();                       // 0 Sun .. 6 Sat

      // UAE weekend is Fri/Sat, and volume grows slightly over the period so
      // the trend lines have direction.
      const weekendFactor = (dow === 5) ? 0.35 : (dow === 6) ? 0.55 : 1;
      const growth = 0.75 + (0.5 * (DAYS - daysAgo) / DAYS);
      const base = between(4, 9) * weekendFactor * growth;
      const count = Math.max(0, Math.round(base));

      for (let i = 0; i < count; i++) {
        const cat    = weightedObj(CATEGORIES);
        const status = statusForAge(daysAgo);
        const isDone = status === 'completed';

        // Booked during working hours, 8am-7pm.
        const created = new Date(day);
        created.setHours(8 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60), 0, 0);

        const vehicle  = vehicles.length ? pick(vehicles) : null;
        const customer = (vehicle && customers.find(c => c.id === vehicle.customer_id)) || pick(customers);

        const fee      = money(between(cat.fee[0], cat.fee[1]));
        // Discounts are the exception, not the rule.
        const discount = Math.random() < 0.18 ? money(fee * between(0.05, 0.2)) : 0;
        const payment  = weighted(PAY_METHODS);
        const net      = money(fee - discount);

        // Roughly one in seven jobs overruns, so on-time% is realistic.
        const overran  = Math.random() < 0.14;
        const hours    = between(cat.hours[0], cat.hours[1]) * (overran ? between(1.6, 2.6) : 1);
        let completedAt = null;
        if (isDone) {
          completedAt = new Date(created.getTime() + hours * 3600 * 1000);
          if (completedAt > new Date()) completedAt = new Date();
        }

        rows.push([
          WORKSHOP,
          `WO-2026-${String(nextSeq++).padStart(5, '0')}`,
          customer.id,
          vehicle ? vehicle.id : null,
          customer.full_name,
          customer.phone,
          pick(mechanics).id,
          pick(bays).id,
          cat.key,
          weighted(ORDER_TYPES),
          weighted(PRIORITIES),
          status,
          payment,
          fee,
          discount,
          payment === 'cash' && isDone ? net : 0,
          payment === 'cash' && isDone ? 1 : 0,
          fmt(created),
          completedAt ? fmt(completedAt) : null,
          fmt(created),
          `${cat.key.replace(/_/g, ' ')} service ${SEED_TAG}`,
        ]);
      }
    }

    // ── Insert ─────────────────────────────────────────────────────────────
    const SQL = `INSERT INTO work_orders
      (workshop_id, work_order_number, customer_id, vehicle_id, customer_name, customer_phone,
       mechanic_id, service_bay_id, service_category, work_order_type, priority, status,
       payment_method, service_fee, discount, cash_amount, cash_collected,
       scheduled_at, completed_at, created_at, notes)
      VALUES ?`;

    const CHUNK = 250;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const [r] = await conn.query(SQL, [rows.slice(i, i + CHUNK)]);
      inserted += r.affectedRows;
    }

    // ── Email Schedules tab ────────────────────────────────────────────────
    const schedCount = await one(
      'SELECT COUNT(*) AS n FROM report_schedules WHERE workshop_id = ?', [WORKSHOP]
    );
    let schedulesAdded = 0;
    if (schedCount.n === 0) {
      // frequency is enum('daily','weekly') — there is no monthly option.
      const schedules = [
        ['daily',  '0 7 * * *', 'ops.seed.reports@pioneercarservice.com'],
        ['weekly', '0 8 * * 1', 'management.seed.reports@pioneercarservice.com'],
      ];
      for (const [frequency, cron, recipients] of schedules) {
        await conn.execute(
          `INSERT INTO report_schedules (workshop_id, frequency, cron_expression, recipients, is_active)
           VALUES (?,?,?,?,1)`,
          // recipients is a JSON column, so it needs an array not a bare string.
          [WORKSHOP, frequency, cron, JSON.stringify([recipients])]
        );
        schedulesAdded++;
      }
    }

    // ── Summary ────────────────────────────────────────────────────────────
    const chk = await one(
      `SELECT COUNT(*) AS total,
              SUM(status = 'completed') AS completed,
              SUM(status IN ('failed','cancelled')) AS lost,
              SUM(status NOT IN ('completed','failed','cancelled')) AS open,
              ROUND(SUM(CASE WHEN status='completed' THEN service_fee - discount ELSE 0 END)) AS revenue,
              COUNT(DISTINCT DATE(created_at)) AS days_covered,
              COUNT(DISTINCT mechanic_id) AS mechanics,
              COUNT(DISTINCT service_bay_id) AS bays,
              COUNT(DISTINCT customer_id) AS customers
       FROM work_orders
       WHERE workshop_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [WORKSHOP, DAYS]
    );
    const l30 = await one(
      `SELECT COUNT(*) AS n FROM work_orders
       WHERE workshop_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [WORKSHOP]
    );

    console.log(`inserted ${inserted} work orders across ${DAYS} days (workshop ${WORKSHOP})`);
    if (emiratesFixed.affectedRows) console.log(`  set emirate on ${emiratesFixed.affectedRows} customers`);
    if (ratingsFixed.affectedRows)  console.log(`  set rating on ${ratingsFixed.affectedRows} mechanics`);
    if (schedulesAdded)             console.log(`  added ${schedulesAdded} report schedules`);
    console.log('');
    console.log(`  in range : ${chk.total} orders over ${chk.days_covered} distinct days`);
    console.log(`  last 30d : ${l30.n} orders  <- what the default Reports filter shows`);
    console.log(`  completed: ${chk.completed}   open: ${chk.open}   failed/cancelled: ${chk.lost}`);
    console.log(`  revenue  : AED ${Number(chk.revenue).toLocaleString()}`);
    console.log(`  spread   : ${chk.mechanics} mechanics, ${chk.bays} bays, ${chk.customers} customers`);
    console.log('');
    console.log(`to undo:  node scripts/seed-report-data.js --clean --workshop=${WORKSHOP}`);
  } finally {
    await conn.end();
  }
}

main().catch(err => { console.error('seed failed:', err.message); process.exit(1); });
