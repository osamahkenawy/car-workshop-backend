/**
 * seed-all-modules.js — fill the empty modules with data that reconciles.
 *
 * The demo database had 914 work orders, 202 customers and 182 enquiries, but
 * most other modules were empty: no parts, no inventory, no invoices, no
 * appointments, no warranty claims, no feedback, and — least believable of all
 * — only 20 of 202 customers owned a vehicle.
 *
 * The point here is not row count. It is that the numbers agree with each
 * other: line items sum to the work order total, invoices sum to their items,
 * VAT is 5% of subtotal, stock movements match the parts fitted, and every
 * date sits in a plausible order. A demo falls apart when someone adds up a
 * column, so these are generated from the existing work orders rather than
 * invented alongside them.
 *
 * Idempotent. Each module is skipped if it already holds rows for the
 * workshop, so re-running is safe.
 *
 *   node scripts/seed-all-modules.js                  # fill whatever is empty
 *   node scripts/seed-all-modules.js --only=vehicles,invoices
 *   node scripts/seed-all-modules.js --force          # re-seed even if present
 *   node scripts/seed-all-modules.js --dry-run        # report, change nothing
 */

import { query, execute } from '../src/lib/database.js';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const FORCE = ARGS.includes('--force');
const ONLY = (ARGS.find(a => a.startsWith('--only=')) || '').split('=')[1];
const ONLY_SET = ONLY ? new Set(ONLY.split(',').map(s => s.trim())) : null;

/* ── deterministic randomness ────────────────────────────────
   A fixed seed means two runs produce the same data, so a bug found in a
   demo can actually be reproduced. */
let _s = 20260903;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
const chance = p => rnd() < p;

/** MySQL DATETIME is naive; toISOString() would shift it by the local offset. */
const sqlDt = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const sqlDate = d => sqlDt(d).slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000);
const daysAhead = n => new Date(Date.now() + n * 86400000);

const log = [];
const note = (mod, msg) => { log.push(`  ${mod.padEnd(22)} ${msg}`); };

/* ── UAE fleet, weighted the way a Sharjah workshop actually sees it ── */
const FLEET = [
  ['Toyota', 'Land Cruiser', 8], ['Toyota', 'Corolla', 10], ['Toyota', 'Camry', 9],
  ['Toyota', 'Hilux', 6], ['Toyota', 'Prado', 6],
  ['Nissan', 'Patrol', 7], ['Nissan', 'Altima', 6], ['Nissan', 'Sunny', 7],
  ['Mitsubishi', 'Pajero', 5], ['Mitsubishi', 'Lancer', 4],
  ['Hyundai', 'Elantra', 6], ['Hyundai', 'Tucson', 5], ['Hyundai', 'Accent', 5],
  ['Kia', 'Sportage', 4], ['Kia', 'Cerato', 4],
  ['Ford', 'Explorer', 3], ['Ford', 'F-150', 2],
  ['Chevrolet', 'Tahoe', 3], ['Chevrolet', 'Malibu', 2],
  ['Lexus', 'LX 570', 2], ['Lexus', 'ES 350', 2],
  ['Honda', 'Civic', 4], ['Honda', 'Accord', 3],
  ['Mazda', 'CX-5', 3], ['Nissan', 'X-Trail', 3],
];
const FLEET_BAG = FLEET.flatMap(([mk, md, w]) => Array(w).fill([mk, md]));

const COLORS = ['White', 'Silver', 'Black', 'Grey', 'Pearl White', 'Beige',
  'Dark Blue', 'Red', 'Bronze'];
const EMIRATE_CODE = [
  ['Dubai', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']],
  ['Abu Dhabi', ['4', '5', '6', '7', '8', '9', '10', '11']],
  ['Sharjah', ['1', '2', '3']],
];

function plate(taken) {
  for (let i = 0; i < 500; i += 1) {
    const [, codes] = pick(EMIRATE_CODE);
    const p = `${pick(codes)}${int(10000, 99999)}`;
    if (!taken.has(p)) { taken.add(p); return p; }
  }
  return `X${Date.now() % 1000000}`;
}

/* ── the parts catalogue ─────────────────────────────────────
   Real part numbers are manufacturer-formatted; these follow the same shape
   so the column does not look like filler. */
const CATALOGUE = [
  ['90915-YZZD2', 'Oil filter — Toyota genuine', 18, 26, 40],
  ['04152-YZZA1', 'Oil filter cartridge — Lexus', 22, 34, 25],
  ['17801-38030', 'Air filter element — Land Cruiser', 45, 72, 20],
  ['87139-0N010', 'Cabin air filter — Camry/Corolla', 30, 48, 30],
  ['04465-42160', 'Front brake pad set — RAV4/Camry', 120, 195, 24],
  ['04466-33160', 'Rear brake pad set — Camry', 105, 168, 18],
  ['43512-0K020', 'Front brake disc — Hilux', 180, 285, 12],
  ['90919-01253', 'Ignition coil — Toyota 1GR', 210, 330, 10],
  ['90919-01247', 'Spark plug iridium — Nissan VQ', 38, 62, 48],
  ['28800-3T105', 'Battery 12V 70Ah — AC Delco', 260, 395, 14],
  ['28800-3T160', 'Battery 12V 90Ah — Varta AGM', 420, 640, 8],
  ['16400-0P210', 'Radiator assembly — Prado', 620, 980, 5],
  ['16620-31020', 'Drive belt tensioner — 2GR-FE', 340, 520, 6],
  ['90916-02660', 'Serpentine belt — Corolla', 65, 105, 22],
  ['04152-31090', 'Transmission filter kit — Aisin', 155, 245, 9],
  ['08886-81221', 'ATF WS automatic fluid 1L', 42, 68, 60],
  ['08880-83816', 'Engine oil 5W-30 synthetic 1L', 26, 42, 120],
  ['08880-80846', 'Engine oil 0W-20 synthetic 1L', 32, 52, 80],
  ['GT-2056V', 'Turbocharger cartridge — Patrol', 1450, 2200, 2],
  ['DENSO-4T', 'AC compressor — Nissan Sunny', 890, 1350, 3],
  ['BOSCH-0242', 'Wiper blade pair 24in/18in', 48, 82, 35],
  ['DUNLOP-SP31', 'Tyre 265/65R17 SP Sport', 340, 495, 16],
  ['BRIDGE-DUELER', 'Tyre 275/60R18 Dueler H/T', 420, 610, 12],
  ['COOL-G12', 'Coolant G12+ concentrate 1L', 22, 38, 45],
  ['90430-12031', 'Drain plug gasket', 3, 7, 200],
];

const LABOUR = [
  ['Engine oil and filter service', 60, 140],
  ['Front brake pad replacement', 120, 260],
  ['Rear brake pad replacement', 110, 240],
  ['Brake disc machining', 90, 180],
  ['Full diagnostic scan', 100, 200],
  ['AC service and regas', 180, 340],
  ['Wheel alignment (4-wheel)', 90, 160],
  ['Tyre fitting and balancing', 40, 90],
  ['Battery test and replacement', 40, 80],
  ['Timing belt replacement', 480, 900],
  ['Transmission fluid flush', 220, 420],
  ['Suspension inspection', 80, 150],
  ['Radiator flush and refill', 150, 280],
  ['Periodic maintenance (major)', 320, 620],
  ['Periodic maintenance (minor)', 140, 280],
  ['Electrical fault tracing', 130, 300],
];

/* ── helpers ────────────────────────────────────────────────── */
async function count(table, where = '1=1', params = []) {
  // Some callers need an alias ("work_order_items wi") to reach the workshop
  // through a join, so only a bare name gets quoted.
  const from = /^[A-Za-z0-9_]+$/.test(table) ? `\`${table}\`` : table;
  const [r] = await query(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, params);
  return Number(r.n);
}

function shouldRun(name, existing) {
  if (ONLY_SET && !ONLY_SET.has(name)) return false;
  if (existing > 0 && !FORCE) { note(name, `skipped — ${existing} row(s) already present`); return false; }
  return true;
}

/**
 * Split a total into n line amounts that sum to exactly the total.
 * Rounding drift is pushed onto the last line, because an invoice whose items
 * do not add up to its total is the first thing a finance person spots.
 */
function splitTotal(total, n) {
  const t = Math.round(Number(total) * 100);
  if (t <= 0 || n < 1) return [];
  const weights = Array.from({ length: n }, () => 0.5 + rnd());
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map(w => Math.max(1, Math.round((w / sum) * t)));
  const drift = t - parts.reduce((a, b) => a + b, 0);
  parts[parts.length - 1] = Math.max(1, parts[parts.length - 1] + drift);
  return parts.map(c => c / 100);
}

/* ═══════════════════════════════════════════════════════════════
   Modules
   ═══════════════════════════════════════════════════════════════ */

/** Every customer with history should own the car that history is about. */
async function seedVehicles(ws) {
  const name = 'vehicles';
  const existingAll = await count('vehicles', 'workshop_id = ?', [ws]);
  if (ONLY_SET && !ONLY_SET.has(name)) return;

  // Unlike the other modules this one tops up rather than skipping: the table
  // is not empty, it is just implausibly thin.
  const orphans = await query(
    `SELECT c.id, c.full_name
       FROM customers c
       LEFT JOIN vehicles v ON v.customer_id = c.id
      WHERE c.workshop_id = ? AND v.id IS NULL
      ORDER BY c.id`, [ws]);
  if (!orphans.length) { note(name, `skipped — all customers already own a vehicle (${existingAll})`); return; }

  const plates = new Set(
    (await query('SELECT plate_number FROM vehicles')).map(r => r.plate_number)
  );
  let made = 0;
  for (const c of orphans) {
    // A minority of customers run two cars, which is what makes the vehicle
    // list look like a real book of business rather than a 1:1 mapping.
    const howMany = chance(0.18) ? 2 : 1;
    for (let i = 0; i < howMany; i += 1) {
      const [make, model] = pick(FLEET_BAG);
      const year = int(2011, 2025);
      // Older cars have more kilometres on them; roughly 14k/year here.
      const age = Math.max(0, 2026 - year);
      const mileage = Math.max(1200, Math.round((age * int(9000, 21000) + int(0, 9000)) / 100) * 100);
      if (!DRY) {
        await execute(
          `INSERT INTO vehicles
             (workshop_id, customer_id, make, model, year, plate_number, vin,
              color, mileage, fuel_type, transmission, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
          [ws, c.id, make, model, year, plate(plates),
           `VIN${String(int(10000000, 99999999))}${String(int(1000, 9999))}`,
           pick(COLORS), mileage,
           chance(0.05) ? 'diesel' : 'petrol',
           chance(0.9) ? 'automatic' : 'manual']
        );
      }
      made += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${made} vehicle(s) for ${orphans.length} customer(s) with none`);
}

/** Line items, generated so they sum to the work order's own total. */
async function seedWorkOrderItems(ws) {
  const name = 'work_order_items';
  const existing = await count(
    'work_order_items wi', 'EXISTS (SELECT 1 FROM work_orders o WHERE o.id = wi.work_order_id AND o.workshop_id = ?)', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT id, COALESCE(NULLIF(total_amount,0), NULLIF(service_fee,0), 0) AS amount, service_category
       FROM work_orders WHERE workshop_id = ? ORDER BY id`, [ws]);

  let lines = 0, skipped = 0;
  for (const o of orders) {
    const amount = Number(o.amount);
    if (amount <= 0) { skipped += 1; continue; }  // nothing to apportion
    const n = amount > 3000 ? int(3, 5) : amount > 800 ? int(2, 4) : int(1, 2);
    const parts = splitTotal(amount, n);

    // Build the lines first, then close any rounding gap, because
    // unit = round(lineTotal / qty) means qty * unit can drift a few fils and
    // a job sheet whose lines do not add up to its total is worse than one
    // with less variety in it.
    const built = [];
    for (let i = 0; i < parts.length; i += 1) {
      // First line is labour, the rest are parts — that is how a job sheet
      // actually reads.
      const label = i === 0 ? pick(LABOUR)[0] : CATALOGUE[Math.floor(rnd() * CATALOGUE.length)][1];
      const qty = i === 0 ? 1 : (chance(0.25) ? int(2, 4) : 1);
      built.push({ label, qty, unit: Math.round((parts[i] / qty) * 100) / 100 });
    }
    const cents = l => Math.round(l.qty * l.unit * 100);
    const drift = Math.round(amount * 100) - built.reduce((a, l) => a + cents(l), 0);
    if (drift !== 0) {
      // The last line takes the difference at quantity one, which is the only
      // way to land on the total exactly for any quantity.
      const last = built[built.length - 1];
      const target = cents(last) + drift;
      if (target > 0) { last.qty = 1; last.unit = target / 100; }
      else { built.pop(); if (built.length) { const b = built[built.length - 1]; b.qty = 1; b.unit = (cents(b) + target) / 100; } }
    }

    for (const l of built) {
      if (l.unit <= 0) continue;
      if (!DRY) {
        await execute(
          'INSERT INTO work_order_items (work_order_id, name, quantity, unit_price) VALUES (?,?,?,?)',
          [o.id, l.label, l.qty, l.unit]
        );
      }
      lines += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${lines} line(s) across ${orders.length - skipped} order(s)`
    + (skipped ? `; ${skipped} had no value to apportion` : ''));
}

/** A stock room: locations, a catalogue with real levels, some under reorder. */
async function seedInventory(ws) {
  const name = 'inventory';
  const existing = await count('inventory_stock', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const LOCATIONS = [
    ['Main Store — Industrial Area 4', 'main_store'],
    ['Workshop Floor Trolley', 'workshop_sub'],
    ['Tyre Bay Rack', 'workshop_sub'],
    ['Consignment — Al Futtaim', 'external'],
  ];
  const ids = [];
  for (const [n, ty] of LOCATIONS) {
    if (DRY) { ids.push(0); continue; }
    const r = await execute(
      'INSERT INTO inventory_locations (workshop_id, name, location_type, is_active) VALUES (?,?,?,1)',
      [ws, n, ty]);
    ids.push(r.insertId);
  }

  let rows = 0, low = 0;
  for (const [pn, desc, costLo, , typicalQty] of CATALOGUE) {
    // Most stock sits in the main store; fast-movers also sit on the floor.
    const spread = chance(0.35) ? ids.slice(0, 2) : [ids[0]];
    for (const loc of spread) {
      const reorder = Math.max(2, Math.round(typicalQty * 0.25));
      // Roughly one in five lines is under its reorder level, so the
      // low-stock view has something real to show.
      const onHand = chance(0.2) ? int(0, reorder) : int(reorder + 1, typicalQty + 10);
      if (onHand <= reorder) low += 1;
      const avg = money(costLo * 0.95, costLo * 1.12);
      if (!DRY) {
        await execute(
          `INSERT INTO inventory_stock
             (workshop_id, location_id, part_number, description, quantity_on_hand,
              quantity_reserved, avg_cost, last_purchase_cost, reorder_level)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [ws, loc, pn, desc, onHand, chance(0.25) ? int(1, 3) : 0,
           avg, Math.round(avg * 1.04 * 100) / 100, reorder]
        );
      }
      rows += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${LOCATIONS.length} location(s), ${rows} stock line(s), ${low} under reorder`);
}

/** Parts fitted to jobs — priced from the catalogue, not invented. */
async function seedParts(ws) {
  const name = 'parts';
  const existing = await count('parts', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  // Only jobs that actually consumed parts; a diagnostic-only job did not.
  const orders = await query(
    `SELECT id, status, completed_at, created_at FROM work_orders
      WHERE workshop_id = ? AND status IN ('completed','in_progress','ready_for_pickup','assigned','accepted')
      ORDER BY id`, [ws]);

  let rows = 0;
  for (const o of orders) {
    if (chance(0.35)) continue;                       // labour-only job
    for (let i = 0; i < int(1, 3); i += 1) {
      const [pn, desc, lo, hi] = CATALOGUE[Math.floor(rnd() * CATALOGUE.length)];
      const qty = chance(0.3) ? int(2, 4) : 1;
      const unit = money(lo, hi);
      const fitted = o.status === 'completed';
      if (!DRY) {
        await execute(
          `INSERT INTO parts
             (workshop_id, work_order_id, part_number, name, quantity,
              unit_cost, total_cost, warranty_period_days, status, installed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [ws, o.id, pn, desc, qty, unit,
           Math.round(unit * qty * 100) / 100,
           pick([0, 90, 180, 365]),
           fitted ? 'installed' : pick(['ordered', 'in_stock']),
           fitted ? (o.completed_at || o.created_at) : null]
        );
      }
      rows += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${rows} part line(s)`);
}

/** Who worked on what. */
async function seedAssignments(ws) {
  const name = 'work_order_assignments';
  const existing = await count(
    'work_order_assignments a',
    'EXISTS (SELECT 1 FROM work_orders o WHERE o.id = a.work_order_id AND o.workshop_id = ?)', [ws]);
  if (!shouldRun(name, existing)) return;

  const mechanics = (await query('SELECT id FROM mechanics WHERE workshop_id = ?', [ws])).map(r => r.id);
  if (!mechanics.length) { note(name, 'skipped — no mechanics'); return; }
  const [owner] = await query('SELECT id FROM users WHERE workshop_id = ? AND username = ? LIMIT 1', [ws, 'admin']);

  const orders = await query(
    `SELECT id, mechanic_id, status, created_at, started_at FROM work_orders
      WHERE workshop_id = ? AND status NOT IN ('pending','confirmed') ORDER BY id`, [ws]);

  let rows = 0;
  for (const o of orders) {
    const mech = o.mechanic_id || pick(mechanics);
    const assignedAt = o.created_at;
    // A rejected-then-reassigned job is common enough to be worth showing,
    // and it is the only way the assignment history looks lived-in.
    const bounced = chance(0.08);
    if (bounced && !DRY) {
      const other = pick(mechanics.filter(m => m !== mech)) || mech;
      await execute(
        `INSERT INTO work_order_assignments
           (work_order_id, mechanic_id, assigned_by, assigned_at, rejected_at, rejection_reason, is_current)
         VALUES (?,?,?,?,?,?,0)`,
        [o.id, other, owner?.id || null, assignedAt,
         o.started_at || assignedAt, pick([
           'Already on a gearbox strip-down',
           'Not certified for hybrid high-voltage work',
           'Finishing an urgent warranty job',
         ])]);
    }
    if (bounced) rows += 1;
    if (!DRY) {
      await execute(
        `INSERT INTO work_order_assignments
           (work_order_id, mechanic_id, assigned_by, assigned_at, accepted_at, is_current)
         VALUES (?,?,?,?,?,1)`,
        [o.id, mech, owner?.id || null, assignedAt, o.started_at || assignedAt]);
    }
    rows += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${rows} assignment(s) over ${orders.length} order(s)`);
}

/** Invoices raised from completed work, with a believable payment mix. */
async function seedInvoices(ws) {
  const name = 'invoices';
  const existing = await count('invoices', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT o.id, o.customer_id, o.completed_at, o.created_at,
            COALESCE(NULLIF(o.total_amount,0), NULLIF(o.service_fee,0), 0) AS amount
       FROM work_orders o
      WHERE o.workshop_id = ? AND o.status = 'completed' AND o.customer_id IS NOT NULL
      ORDER BY o.id`, [ws]);

  const [owner] = await query('SELECT id FROM users WHERE workshop_id = ? AND username = ? LIMIT 1', [ws, 'admin']);
  let n = 0, seq = 0;
  const byStatus = {};

  for (const o of orders) {
    const gross = Number(o.amount);
    if (gross <= 0) continue;
    if (chance(0.12)) continue;             // not everything got invoiced yet

    const issued = new Date(o.completed_at || o.created_at);
    // total_amount already includes VAT, so work backwards to the subtotal
    // rather than adding 5% on top and inflating every figure by 5%.
    const subtotal = Math.round((gross / 1.05) * 100) / 100;
    const tax = Math.round((gross - subtotal) * 100) / 100;
    const due = new Date(issued.getTime() + 30 * 86400000);
    const ageDays = Math.floor((Date.now() - issued.getTime()) / 86400000);

    let status, paid, paidAt = null, method = null;
    const roll = rnd();
    if (roll < 0.72) {
      status = 'paid'; paid = gross;
      paidAt = sqlDt(new Date(issued.getTime() + int(0, 6) * 86400000));
      method = pick(['cash', 'card', 'bank_transfer', 'cheque']);
    } else if (roll < 0.80) {
      status = 'partially_paid'; paid = Math.round(gross * (0.3 + rnd() * 0.4) * 100) / 100;
      method = pick(['cash', 'card']);
    } else if (roll < 0.90 && ageDays > 30) {
      status = 'overdue'; paid = 0;
    } else if (roll < 0.96) {
      status = 'sent'; paid = 0;
    } else {
      status = 'draft'; paid = 0;
    }
    byStatus[status] = (byStatus[status] || 0) + 1;

    seq += 1;
    const num = `INV-${issued.getFullYear()}-${String(seq).padStart(5, '0')}`;
    if (!DRY) {
      const r = await execute(
        `INSERT INTO invoices
           (workshop_id, work_order_id, invoice_number, customer_id, subtotal,
            tax_rate, tax_amount, total_amount, amount_paid, currency, status,
            payment_method, paid_at, due_date, created_by, created_at)
         VALUES (?,?,?,?,?,5.00,?,?,?, 'AED', ?,?,?,?,?,?)`,
        [ws, o.id, num, o.customer_id, subtotal, tax, gross, paid, status,
         method, paidAt, sqlDate(due), owner?.id || null, sqlDt(issued)]);

      // Items copied from the work order so the two documents agree.
      const items = await query(
        'SELECT name, quantity, unit_price FROM work_order_items WHERE work_order_id = ?', [o.id]);
      const rows = items.length ? items : [{ name: 'Workshop service', quantity: 1, unit_price: subtotal }];
      let acc = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const it = rows[i];
        // The last line absorbs rounding so the items total the subtotal.
        const lineTotal = i === rows.length - 1
          ? Math.round((subtotal - acc) * 100) / 100
          : Math.round(Number(it.quantity) * Number(it.unit_price) / 1.05 * 100) / 100;
        acc = Math.round((acc + lineTotal) * 100) / 100;
        await execute(
          `INSERT INTO invoice_items
             (invoice_id, item_type, description, quantity, unit_price, total)
           VALUES (?,?,?,?,?,?)`,
          [r.insertId, i === 0 ? 'service' : 'parts', it.name,
           it.quantity, Math.round((lineTotal / Math.max(1, it.quantity)) * 100) / 100, lineTotal]);
      }
    }
    n += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} invoice(s) — `
    + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
}

/** The booking diary: recent history plus a populated week ahead. */
async function seedAppointments(ws) {
  const name = 'appointments';
  const existing = await count('appointments', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const bays = (await query('SELECT id FROM service_bays WHERE workshop_id = ?', [ws])).map(r => r.id);
  const cust = await query(
    `SELECT c.id, c.full_name, c.phone,
            (SELECT v.id FROM vehicles v WHERE v.customer_id = c.id LIMIT 1) AS vehicle_id
       FROM customers c WHERE c.workshop_id = ? ORDER BY RAND() LIMIT 90`, [ws]);
  const [owner] = await query('SELECT id FROM users WHERE workshop_id = ? AND username = ? LIMIT 1', [ws, 'admin']);

  const CATS = ['Oil change', 'Periodic maintenance', 'Brake inspection',
    'AC service', 'Tyre replacement', 'Diagnostic check', 'Battery replacement'];
  // A workshop books mornings heavily and thins out after 4pm.
  const SLOTS = ['08:00:00', '08:30:00', '09:00:00', '09:30:00', '10:00:00',
    '10:30:00', '11:00:00', '11:30:00', '13:00:00', '14:00:00', '15:00:00', '16:00:00'];

  let n = 0;
  const byStatus = {};
  for (const c of cust) {
    for (let k = 0; k < (chance(0.25) ? 2 : 1); k += 1) {
      const future = chance(0.45);
      const when = future ? daysAhead(int(0, 13)) : daysAgo(int(1, 45));
      let status;
      if (future) status = chance(0.7) ? 'confirmed' : 'pending';
      else status = pick(['completed', 'completed', 'completed', 'no_show', 'cancelled']);
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (!DRY) {
        await execute(
          `INSERT INTO appointments
             (workshop_id, customer_id, vehicle_id, customer_name, customer_phone,
              service_bay_id, appointment_date, appointment_time, slot_duration_min,
              service_category, source, status, booked_by_user_id, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [ws, c.id, c.vehicle_id, c.full_name, c.phone,
           bays.length ? pick(bays) : null,
           sqlDate(when), pick(SLOTS), pick([30, 60, 60, 90, 120]),
           pick(CATS), pick(['call_centre', 'call_centre', 'walk_in', 'self_service', 'app']),
           status, owner?.id || null,
           status === 'cancelled' ? 'Customer rescheduled by phone'
             : status === 'no_show' ? 'Did not arrive; no answer on the mobile' : null]);
      }
      n += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} appointment(s) — `
    + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
}

/** Warranty claims against completed jobs, at a realistic rate. */
async function seedWarranty(ws) {
  const name = 'warranty_claims';
  const existing = await count('warranty_claims', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT id, customer_id, completed_at, created_at FROM work_orders
      WHERE workshop_id = ? AND status = 'completed' AND customer_id IS NOT NULL
      ORDER BY RAND() LIMIT 26`, [ws]);
  const mechanics = (await query('SELECT id FROM mechanics WHERE workshop_id = ?', [ws])).map(r => r.id);
  const [owner] = await query('SELECT id FROM users WHERE workshop_id = ? AND username = ? LIMIT 1', [ws, 'admin']);

  const REASONS = [
    ['Brake noise returned within two weeks of pad replacement', 'our_workmanship'],
    ['Oil seepage from the sump plug after a service', 'our_workmanship'],
    ['AC blowing warm again ten days after regas', 'our_workmanship'],
    ['Battery will not hold charge — replaced under supplier warranty', 'different_fault'],
    ['Rattle from the front suspension after strut work', 'our_workmanship'],
    ['Check-engine light back on after the diagnostic clear', 'different_fault'],
    ['Alignment pulling to the left after new tyres', 'our_workmanship'],
    ['Coolant loss traced to a cracked expansion tank', 'different_fault'],
    ['Clutch judder reported after gearbox service', 'wear_and_tear'],
    ['Wiper linkage seized shortly after replacement', 'customer_induced'],
  ];
  const FLOW = ['requested', 'requested', 'approved', 'in_progress', 'resolved', 'resolved', 'closed', 'rejected'];

  let n = 0;
  const byStatus = {};
  for (const o of orders) {
    const [reason, determination] = pick(REASONS);
    const status = pick(FLOW);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const opened = new Date(new Date(o.completed_at || o.created_at).getTime() + int(3, 25) * 86400000);
    if (opened > new Date()) continue;
    const decided = ['approved', 'in_progress', 'resolved', 'closed', 'rejected'].includes(status);
    const done = ['resolved', 'closed'].includes(status);
    if (!DRY) {
      await execute(
        `INSERT INTO warranty_claims
           (workshop_id, work_order_id, original_work_order_id, customer_id, reason, status,
            resolution_notes, requested_by, approved_by, approved_at, resolved_at,
            determination, determination_at, determination_by, chargeable,
            responsible_mechanic_id, queue_priority, diagnostic_fee_waived, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ws, o.id, o.id, o.customer_id, reason, status,
         done ? pick([
           'Re-machined the discs and refitted at no charge.',
           'Replaced the faulty part under supplier warranty; no labour charged.',
           'Re-sealed and pressure-tested; held overnight to confirm.',
         ]) : null,
         owner?.id || null,
         decided ? owner?.id || null : null,
         decided ? sqlDt(new Date(opened.getTime() + 86400000)) : null,
         done ? sqlDt(new Date(opened.getTime() + int(2, 9) * 86400000)) : null,
         decided ? determination : 'pending',
         decided ? sqlDt(new Date(opened.getTime() + 86400000)) : null,
         decided ? owner?.id || null : null,
         determination === 'customer_induced' || determination === 'wear_and_tear' ? 1 : 0,
         mechanics.length ? pick(mechanics) : null,
         pick(['standard', 'priority', 'priority', 'urgent']),
         determination === 'our_workmanship' ? 1 : 0,
         sqlDt(opened)]);
    }
    n += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} claim(s) — `
    + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
}

/** Post-service follow-up calls, ratings and NPS. */
async function seedFeedback(ws) {
  const name = 'customer_feedback';
  const existing = await count('customer_feedback', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT id, customer_id, completed_at, created_at FROM work_orders
      WHERE workshop_id = ? AND status = 'completed' AND customer_id IS NOT NULL
      ORDER BY RAND() LIMIT 180`, [ws]);
  const [owner] = await query('SELECT id FROM users WHERE workshop_id = ? AND username = ? LIMIT 1', [ws, 'admin']);

  const GOOD = [
    'Very happy — car was ready before the promised time.',
    'Good service, clear explanation of what was replaced.',
    'Fair pricing and the car was washed. Will return.',
    'Second visit here, consistent quality.',
  ];
  const MEH = [
    'Work was fine but I waited longer than quoted.',
    'No update call; I had to phone twice to check progress.',
    'Job done well, reception area was very busy.',
  ];
  const BAD = [
    'Car came back with a warning light still on.',
    'Quoted one price on the phone, charged more at pickup.',
    'Had to bring it back the next day for the same noise.',
  ];

  let n = 0; const byStatus = {};
  for (const o of orders) {
    const scheduled = new Date(new Date(o.completed_at || o.created_at).getTime() + int(1, 3) * 86400000);
    const future = scheduled > new Date();
    const status = future ? 'scheduled'
      : pick(['completed', 'completed', 'completed', 'completed', 'attempted', 'skipped']);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const done = status === 'completed';
    // Skewed positive, the way real CSAT is, with a genuine unhappy tail.
    const roll = rnd();
    const rating = !done ? null : roll < 0.62 ? 5 : roll < 0.82 ? 4 : roll < 0.92 ? 3 : roll < 0.97 ? 2 : 1;
    const nps = rating === null ? null
      : rating >= 5 ? int(9, 10) : rating === 4 ? int(7, 8) : rating === 3 ? int(5, 6) : int(0, 4);
    if (!DRY) {
      await execute(
        `INSERT INTO customer_feedback
           (workshop_id, work_order_id, customer_id, scheduled_at, status, channel,
            attempts, contacted_at, satisfied, rating, nps_score, comments,
            issue_raised, review_requested, review_left, handled_by, completed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ws, o.id, o.customer_id, sqlDt(scheduled), status,
         pick(['phone', 'phone', 'whatsapp', 'sms']),
         status === 'attempted' ? int(1, 3) : done ? 1 : 0,
         done ? sqlDt(scheduled) : null,
         rating === null ? null : rating >= 4 ? 1 : 0,
         rating, nps,
         rating === null ? null : rating >= 4 ? pick(GOOD) : rating === 3 ? pick(MEH) : pick(BAD),
         rating !== null && rating <= 2 ? 1 : 0,
         done && rating >= 4 ? 1 : 0,
         done && rating >= 4 && chance(0.4) ? 1 : 0,
         owner?.id || null,
         done ? sqlDt(scheduled) : null,
         sqlDt(new Date(o.completed_at || o.created_at))]);
    }
    n += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} feedback record(s) — `
    + Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
}

/* ═══════════════════════════════════════════════════════════════ */


/** Technician pay, derived from the labour share of each completed job. */
async function seedEarnings(ws) {
  const name = 'mechanic_earnings';
  const existing = await count('mechanic_earnings', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT o.id, o.mechanic_id, o.completed_at, o.created_at,
            COALESCE(NULLIF(o.total_amount,0), NULLIF(o.service_fee,0), 0) AS amount
       FROM work_orders o
      WHERE o.workshop_id = ? AND o.status = 'completed' AND o.mechanic_id IS NOT NULL
      ORDER BY o.id`, [ws]);

  // "Paid" is decided relative to the newest job in the data, not to today.
  // Judging by the wall clock made every row paid, because the most recent
  // completed job is already older than a payroll cycle.
  const [latest] = await query(
    `SELECT MAX(COALESCE(completed_at, created_at)) AS t FROM work_orders
      WHERE workshop_id = ? AND status = 'completed'`, [ws]);
  const cutoff = latest?.t ? new Date(latest.t).getTime() - 14 * 86400000 : Date.now();

  let n = 0; const byType = {};
  for (const o of orders) {
    const gross = Number(o.amount);
    if (gross <= 0) continue;
    const when = new Date(o.completed_at || o.created_at);
    // Labour share of the ticket, which is what a technician is actually paid
    // on — not the parts.
    const base = Math.round(gross * (0.28 + rnd() * 0.12) * 100) / 100;
    const bonus = chance(0.18) ? Math.round(base * (0.05 + rnd() * 0.1) * 100) / 100 : 0;
    const deductions = chance(0.06) ? Math.round(base * 0.05 * 100) / 100 : 0;
    const net = Math.round((base + bonus - deductions) * 100) / 100;
    // Older work has been paid out; the last fortnight is still pending, so
    // the payroll screen has both states to show.
    const paid = when.getTime() < cutoff;
    byType.labour = (byType.labour || 0) + 1;
    if (!DRY) {
      await execute(
        `INSERT INTO mechanic_earnings
           (workshop_id, mechanic_id, work_order_id, earning_type, amount,
            base_amount, bonus, deductions, net_amount, status, paid_at, created_at)
         VALUES (?,?,?,'labor',?,?,?,?,?,?,?,?)`,
        [ws, o.mechanic_id, o.id, net, base, bonus, deductions, net,
         paid ? 'paid' : 'pending',
         paid ? sqlDt(new Date(when.getTime() + 7 * 86400000)) : null,
         sqlDt(when)]);
    }
    n += 1;

    if (chance(0.07)) {
      const tip = money(20, 120);
      byType.tip = (byType.tip || 0) + 1;
      if (!DRY) {
        await execute(
          `INSERT INTO mechanic_earnings
             (workshop_id, mechanic_id, work_order_id, earning_type, amount,
              net_amount, status, notes, paid_at, created_at)
           VALUES (?,?,?,'tip',?,?,?,?,?,?)`,
          [ws, o.mechanic_id, o.id, tip, tip, paid ? 'paid' : 'pending',
           'Cash tip handed over at pickup',
           paid ? sqlDt(new Date(when.getTime() + 7 * 86400000)) : null,
           sqlDt(when)]);
      }
      n += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} earning(s) — `
    + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', '));
}

/** Workshop wallet: a running ledger whose closing balance matches its rows. */
async function seedWallet(ws) {
  const name = 'wallet_transactions';
  const existing = await count('wallet_transactions', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  let [wallet] = await query('SELECT id FROM wallets WHERE workshop_id = ? LIMIT 1', [ws]);
  if (!wallet) {
    if (DRY) { note(name, 'would create a wallet first'); return; }
    const r = await execute(
      'INSERT INTO wallets (workshop_id, balance, currency) VALUES (?,0,?)', [ws, 'AED']);
    wallet = { id: r.insertId };
  }

  // Built from paid invoices so the ledger explains the cash position rather
  // than contradicting it. balance_before/after are carried forward row by
  // row, because a ledger that does not chain is obviously fabricated.
  const paid = await query(
    `SELECT id, work_order_id, total_amount, paid_at, payment_method, invoice_number
       FROM invoices
      WHERE workshop_id = ? AND status = 'paid' AND paid_at IS NOT NULL
      ORDER BY paid_at ASC LIMIT 260`, [ws]);

  let balance = 0, n = 0, payouts = 0;
  for (let idx = 0; idx < paid.length; idx += 1) {
    const inv = paid[idx];
    const amt = Number(inv.total_amount);
    const before = balance;
    balance = Math.round((balance + amt) * 100) / 100;
    if (!DRY) {
      await execute(
        `INSERT INTO wallet_transactions
           (wallet_id, workshop_id, type, earning_type, amount, balance_before,
            balance_after, reference, work_order_id, description, created_at)
         VALUES (?,?,'credit','service',?,?,?,?,?,?,?)`,
        [wallet.id, ws, amt, before, balance, inv.invoice_number, inv.work_order_id,
         `Payment received (${inv.payment_method || 'cash'}) for ${inv.invoice_number}`,
         sqlDt(new Date(inv.paid_at))]);
    }
    n += 1;

    // Periodic settlement out to the bank, so the balance does not climb
    // forever the way no real account does.
    if (chance(0.22) && balance > 4000) {
      const out = Math.round(balance * (0.5 + rnd() * 0.4) * 100) / 100;
      const after = Math.round((balance - out) * 100) / 100;
      // The payout has to land strictly between this credit and the next
      // one. A flat +1 hour could overtake the next credit, and then the
      // ledger no longer chains when it is sorted by date — which is how
      // anyone actually reads it.
      const thisAt = new Date(inv.paid_at).getTime();
      const nextAt = idx + 1 < paid.length ? new Date(paid[idx + 1].paid_at).getTime() : thisAt + 7200000;
      const at = nextAt > thisAt + 2000
        ? new Date(thisAt + Math.floor((nextAt - thisAt) / 2))
        : new Date(thisAt + 1000);
      if (!DRY) {
        await execute(
          `INSERT INTO wallet_transactions
             (wallet_id, workshop_id, type, amount, balance_before, balance_after,
              reference, description, created_at)
           VALUES (?,?,'debit',?,?,?,?,?,?)`,
          [wallet.id, ws, out, balance, after,
           `PAYOUT-${String(int(100000, 999999))}`,
           'Settlement transfer to Emirates NBD ****4417',
           sqlDt(at)]);
      }
      balance = after;
      n += 1; payouts += 1;
    }
  }
  if (!DRY) {
    await execute(
      'UPDATE wallets SET balance = ?, last_transaction_at = ? WHERE id = ?',
      [balance, paid.length ? sqlDt(new Date(paid[paid.length - 1].paid_at)) : null, wallet.id]);
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} ledger row(s) (${payouts} payout(s)); closing balance AED ${balance.toFixed(2)}`);
}

/** The published price book. */
async function seedPricing(ws) {
  const name = 'service_pricing_rules';
  const existing = await count('service_pricing_rules', 'workshop_id = ?', [ws]);
  // Tops up rather than skipping: one lone rule is not a price book.
  if (ONLY_SET && !ONLY_SET.has(name)) return;
  if (existing > 4 && !FORCE) { note(name, `skipped — ${existing} rule(s) already present`); return; }

  const RULES = [
    ['Express oil service — walk-in', 'all', 149, 99, 320, 25],
    ['Periodic maintenance — minor', 'all', 349, 249, 700, 0],
    ['Periodic maintenance — major', 'all', 899, 650, 1800, 0],
    ['Brake service — per axle', 'all', 420, 300, 900, 0],
    ['AC service and regas', 'all', 289, 200, 600, 0],
    ['Diagnostic scan — fixed fee', 'all', 150, 150, 150, 0],
    ['Wheel alignment — four wheel', 'all', 129, 99, 250, 0],
    ['Fleet contract rate — labour hour', 'fleet', 95, 80, 140, 0],
    ['Corporate account — labour hour', 'business', 110, 95, 160, 0],
    ['Recovery and towing — within Sharjah', 'all', 250, 180, 500, 40],
  ];
  const bays = (await query('SELECT id FROM service_bays WHERE workshop_id = ?', [ws])).map(r => r.id);
  let n = 0;
  for (let i = 0; i < RULES.length; i += 1) {
    const [nm, ctype, base, min, max, express] = RULES[i];
    if (!DRY) {
      await execute(
        `INSERT INTO service_pricing_rules
           (workshop_id, name, service_bay_id, customer_type, base_price,
            min_price, max_price, cash_fee_pct, express_surcharge, priority,
            description, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        [ws, nm, chance(0.4) && bays.length ? pick(bays) : null, ctype,
         base, min, max, ctype === 'fleet' ? 0 : 2.5, express, i + 1,
         'Standard published rate. VAT charged at 5% on top.']);
    }
    n += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} pricing rule(s)`);
}

/** In-app notifications, so the bell has a real unread count behind it. */
async function seedNotifications(ws) {
  const name = 'user_notifications';
  const existing = await count('user_notifications', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const users = await query('SELECT id FROM users WHERE workshop_id = ? AND is_active = 1', [ws]);
  if (!users.length) { note(name, 'skipped — no active users'); return; }

  const recent = await query(
    `SELECT id, work_order_number, customer_name FROM work_orders
      WHERE workshop_id = ? ORDER BY created_at DESC LIMIT 40`, [ws]);

  const TEMPLATES = [
    ['New job booked',        o => `${o.customer_name} booked ${o.work_order_number}.`, 'work_order', '\u{1F527}', '/work-orders'],
    ['Job completed',         o => `${o.work_order_number} is finished and ready for pickup.`, 'work_order', '✅', '/work-orders'],
    ['Payment received',      o => `Payment cleared for ${o.work_order_number}.`, 'payment', '\u{1F4B0}', '/invoices'],
    ['Warranty claim raised', o => `${o.customer_name} raised a claim against ${o.work_order_number}.`, 'warranty', '⚠', '/warranty-claims'],
    ['Low stock',             () => 'Brake pad set 04465-42160 is below its reorder level.', 'inventory', '\u{1F4E6}', '/inventory'],
    ['Reminders due',         () => 'Service reminders are due to be sent today.', 'reminder', '\u{1F514}', '/crm/reminders'],
  ];

  let n = 0, unread = 0;
  for (const u of users) {
    for (let i = 0; i < int(5, 11); i += 1) {
      const o = pick(recent) || { work_order_number: 'WO-2026-00001', customer_name: 'A customer' };
      const [title, body, type, icon, link] = pick(TEMPLATES);
      // Only the newest few are unread, which is what puts a small number on
      // the bell rather than an implausible hundred.
      const isRead = i > 2 ? 1 : (chance(0.3) ? 1 : 0);
      if (!isRead) unread += 1;
      const when = daysAgo(int(0, 21));
      if (!DRY) {
        await execute(
          `INSERT INTO user_notifications
             (workshop_id, user_id, title, body, type, icon, link, work_order_id,
              is_read, created_at, read_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [ws, u.id, title, body(o), type, icon, link, o.id || null, isRead,
           sqlDt(when), isRead ? sqlDt(new Date(when.getTime() + 3600000)) : null]);
      }
      n += 1;
    }
  }
  note(name, `${DRY ? 'would add' : 'added'} ${n} notification(s) across ${users.length} user(s); ${unread} unread`);
}


/**
 * The customer survey — what the Customer Feedback screen actually reads.
 *
 * Note this is a different table from `customer_feedback`: that one is the
 * follow-up call list, while the survey page reads `survey_responses`. Both
 * exist, so both are seeded.
 *
 * The derived columns are computed from their components rather than rolled
 * independently: csat_avg is the mean of the six CSAT answers, ces_avg the
 * mean of the two effort answers, and nps_category follows nps_score. The
 * page charts all three, so a response whose average contradicts its own
 * answers would show up immediately.
 */
async function seedSurvey(ws) {
  const name = 'survey_responses';
  const existing = await count('survey_responses', 'workshop_id = ?', [ws]);
  if (!shouldRun(name, existing)) return;

  const orders = await query(
    `SELECT o.id, o.customer_id, o.completed_at, o.created_at, o.service_category,
            c.full_name, c.phone, c.email
       FROM work_orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.workshop_id = ? AND o.status = 'completed' AND o.customer_id IS NOT NULL
      ORDER BY RAND() LIMIT 210`, [ws]);

  const REASONS_PROMOTER = [
    'Quick, honest and they showed me the old parts.',
    'Fair price and the car was ready when promised.',
    'Third time here — the same technician remembers the car.',
    'They called before doing extra work instead of just charging me.',
  ];
  const REASONS_PASSIVE = [
    'Work was fine, the waiting area could be better.',
    'Good job but I had to chase for an update.',
    'Slightly more expensive than the garage near me.',
  ];
  const REASONS_DETRACTOR = [
    'Came back twice for the same noise.',
    'Quoted on the phone, then the bill was higher.',
    'Nobody called me; I waited all day for the car.',
    'Warning light was still on when I collected it.',
  ];

  const BRANCHES = ['Industrial Area 4 — Sharjah', 'Al Quoz — Dubai', 'Mussafah — Abu Dhabi'];
  const SERVICES = ['Oil change', 'Periodic maintenance', 'Brake repair',
    'AC service', 'Tyre replacement', 'Diagnostics', 'Battery replacement'];

  let invites = 0, responses = 0;
  const byCat = {};
  for (const o of orders) {
    const sent = new Date(new Date(o.completed_at || o.created_at).getTime() + int(1, 2) * 86400000);
    if (sent > new Date()) continue;
    const channel = pick(['whatsapp', 'whatsapp', 'sms', 'email', 'link']);
    const service = o.service_category || pick(SERVICES);
    const branch = pick(BRANCHES);

    // Not every invite is answered — a response rate near 100% is the
    // giveaway that a dataset was fabricated.
    const answered = chance(0.62);
    const respondedAt = answered
      ? new Date(sent.getTime() + int(1, 72) * 3600000)
      : null;

    let inviteId = null;
    if (!DRY) {
      const r = await execute(
        `INSERT INTO survey_invites
           (workshop_id, token, work_order_id, customer_id, contact_name,
            contact_phone, contact_email, branch, service_requested, channel,
            sent_at, expires_at, responded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ws,
         `sv_${Date.now().toString(36)}${Math.floor(rnd() * 1e9).toString(36)}${o.id}`,
         o.id, o.customer_id, o.full_name, o.phone, o.email, branch, service,
         channel, sqlDt(sent), sqlDt(new Date(sent.getTime() + 30 * 86400000)),
         respondedAt ? sqlDt(respondedAt) : null]);
      inviteId = r.insertId;
    }
    invites += 1;
    if (!answered) continue;

    // One underlying sentiment drives every answer, so a five-star review
    // does not sit next to "nothing was resolved".
    const roll = rnd();
    const mood = roll < 0.58 ? 'high' : roll < 0.80 ? 'good' : roll < 0.92 ? 'mid' : 'low';
    const band = { high: [5, 5], good: [4, 5], mid: [3, 4], low: [1, 3] }[mood];
    const score = () => int(band[0], band[1]);

    const csat = {
      csat_overall: score(), csat_as_advertised: score(), csat_expectations: score(),
      csat_rep_knowledge: score(), csat_communication: score(), csat_response_time: score(),
    };
    const csatVals = Object.values(csat);
    const csatAvg = Math.round((csatVals.reduce((a, b) => a + b, 0) / csatVals.length) * 100) / 100;

    const ces = { ces_find_channel: score(), ces_easy_handle: score() };
    const cesAvg = Math.round(((ces.ces_find_channel + ces.ces_easy_handle) / 2) * 100) / 100;

    const nps = mood === 'high' ? int(9, 10) : mood === 'good' ? int(7, 8)
      : mood === 'mid' ? int(5, 6) : int(0, 4);
    const cat = nps >= 9 ? 'promoter' : nps >= 7 ? 'passive' : 'detractor';
    byCat[cat] = (byCat[cat] || 0) + 1;

    const resolution = mood === 'low' ? pick(['no', 'partially'])
      : mood === 'mid' ? pick(['partially', 'yes']) : 'yes';
    const reason = cat === 'promoter' ? pick(REASONS_PROMOTER)
      : cat === 'passive' ? pick(REASONS_PASSIVE) : pick(REASONS_DETRACTOR);

    // Detractors get flagged, and most of those have been called back.
    const flagged = cat === 'detractor' ? 1 : 0;
    const followedUp = flagged && chance(0.7);

    if (!DRY) {
      await execute(
        `INSERT INTO survey_responses
           (workshop_id, invite_id, work_order_id, customer_id,
            ces_find_channel, ces_easy_handle, resolution, nps_score, nps_reason,
            csat_overall, csat_as_advertised, csat_expectations, csat_rep_knowledge,
            csat_communication, csat_response_time, ces_avg, csat_avg, nps_category,
            contact_name, contact_phone, contact_email, branch, service_requested,
            language, source, is_flagged, followed_up_at, follow_up_notes, submitted_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [ws, inviteId, o.id, o.customer_id,
         ces.ces_find_channel, ces.ces_easy_handle, resolution, nps, reason,
         csat.csat_overall, csat.csat_as_advertised, csat.csat_expectations,
         csat.csat_rep_knowledge, csat.csat_communication, csat.csat_response_time,
         cesAvg, csatAvg, cat,
         o.full_name, o.phone, o.email, branch, service,
         chance(0.28) ? 'ar' : 'en',
         channel === 'link' ? 'link' : channel === 'email' ? 'link' : pick(['link', 'qr', 'portal']),
         flagged,
         followedUp ? sqlDt(new Date(respondedAt.getTime() + int(2, 48) * 3600000)) : null,
         followedUp ? pick([
           'Called back, offered a free re-check. Customer accepted.',
           'Apologised for the delay; booked them in for a courtesy inspection.',
           'Explained the extra charge; customer satisfied with the breakdown.',
         ]) : null,
         sqlDt(respondedAt)]);
    }
    responses += 1;
  }
  note(name, `${DRY ? 'would add' : 'added'} ${invites} invite(s), ${responses} response(s) — `
    + Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', '));
}

async function run() {
  const [wsRow] = await query('SELECT id, name FROM workshops ORDER BY id LIMIT 1');
  if (!wsRow) throw new Error('No workshop found — seed the demo workshop first.');
  const ws = wsRow.id;

  console.log(`\nWorkshop: ${wsRow.name} (id ${ws})`);
  console.log(DRY ? 'Mode: dry run — nothing will be written\n' : 'Mode: applying\n');

  // Order matters: items feed invoices, vehicles feed appointments.
  await seedVehicles(ws);
  await seedWorkOrderItems(ws);
  await seedInventory(ws);
  await seedParts(ws);
  await seedAssignments(ws);
  await seedInvoices(ws);
  await seedAppointments(ws);
  await seedWarranty(ws);
  await seedFeedback(ws);
  await seedEarnings(ws);
  await seedWallet(ws);
  await seedPricing(ws);
  await seedNotifications(ws);
  await seedSurvey(ws);

  console.log(log.join('\n'));
  console.log('');
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n[seed-all-modules] failed:', err.message); process.exit(1); });
