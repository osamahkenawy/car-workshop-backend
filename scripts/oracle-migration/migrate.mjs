/**
 * Oracle → car-workshop data migration.
 *
 * Handles the CSVs in src/migrations/data/:
 *   customers.csv, vehicles.csv, invoices.csv (== work orders + invoice refs),
 *   invoice_items.csv, workorder_items.csv
 *
 * Every inserted row is tagged with a JSON `notes.src_id` so the whole
 * migration is idempotent (re-runnable) and rollback-able in one statement.
 *
 * Usage (all commands are safe to re-run):
 *   node scripts/oracle-migration/migrate.mjs check
 *   node scripts/oracle-migration/migrate.mjs customers
 *   node scripts/oracle-migration/migrate.mjs vehicles
 *   node scripts/oracle-migration/migrate.mjs work-orders
 *   node scripts/oracle-migration/migrate.mjs invoices
 *   node scripts/oracle-migration/migrate.mjs wo-items
 *   node scripts/oracle-migration/migrate.mjs inv-items
 *   node scripts/oracle-migration/migrate.mjs all
 *   node scripts/oracle-migration/migrate.mjs verify
 *   node scripts/oracle-migration/migrate.mjs rollback
 *
 * Env vars (optional):
 *   MIG_WORKSHOP_ID   default 1
 *   MIG_DATA_DIR      default src/migrations/data
 *   MIG_BATCH         default 500 (rows per INSERT)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, execute } from '../../src/lib/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSHOP_ID = Number(process.env.MIG_WORKSHOP_ID || 1);
const DATA_DIR = path.resolve(process.env.MIG_DATA_DIR || path.join(__dirname, '..', '..', 'src', 'migrations', 'data'));
const BATCH = Number(process.env.MIG_BATCH || 500);

// Marker embedded in `notes` on every migrated row — used for dedupe + rollback.
const SRC = 'oracle';

// ── 3-letter make code → human name. Add rows here as new codes appear. ─────
const MAKE_MAP = {
  TOY: 'Toyota', NIS: 'Nissan', MIT: 'Mitsubishi', JAC: 'JAC', MGM: 'MG',
  SUZ: 'Suzuki', HYN: 'Hyundai', CHE: 'Chevrolet', EXE: 'Exeed', GEE: 'Geely',
  ISU: 'Isuzu',  TAT: 'Tata',   ASH: 'Ashok Leyland', FOR: 'Ford', RAB: 'RAB',
  HON: 'Honda',  KIA: 'Kia',    MAX: 'Maxus',    GRE: 'GWM', SAI: 'SAIC',
  MAZ: 'Mazda',  FIA: 'Fiat',   REN: 'Renault',  PEU: 'Peugeot', BYD: 'BYD',
};

// ══════════════════════════════════════════════════════════════════════════
// CSV parser — RFC-4180-ish, handles quoted fields, embedded commas, escaped
// double-quotes ("") and both CRLF/LF line endings.
// ══════════════════════════════════════════════════════════════════════════
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"')          { inQuotes = false; }
      else                          { field += c; }
    } else {
      if (c === '"')               { inQuotes = true; }
      else if (c === ',')          { row.push(field); field = ''; }
      else if (c === '\r')         { /* skip */ }
      else if (c === '\n')         { row.push(field); rows.push(row); row = []; field = ''; }
      else                          { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => (v ?? '').trim().length)).map(r => {
    const o = {};
    header.forEach((h, i) => o[h] = r[i] ?? '');
    return o;
  });
}

function readCsv(name) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`Missing CSV: ${p}`);
  return parseCsv(fs.readFileSync(p, 'utf8'));
}

// ══════════════════════════════════════════════════════════════════════════
// Cleaners — every source value passes through nullish() or one of the
// specialised helpers before hitting the DB.
// ══════════════════════════════════════════════════════════════════════════

// Placeholder tokens seen throughout the Oracle export that mean "no value".
const NULLISH = new Set(['', '-', "'-", '0', 'NULL', 'null', 'N/A', 'n/a']);
function nullish(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return NULLISH.has(t) ? null : t;
}

// Company / note fields that also had literal "1" as placeholder.
function nullishName(v) {
  const t = nullish(v);
  if (!t) return null;
  return (t === '1' || t === 'd' || t === 'D') ? null : t;
}

// Emails only if they look like one — the same column carries junk otherwise.
function cleanEmail(v) {
  const t = nullish(v);
  return t && t.includes('@') ? t : null;
}

// Phone: strip spaces/dashes/NBSP, preserve leading '+'. Skip if < 6 digits.
function normalisePhone(raw) {
  const t = nullish(raw);
  if (!t) return null;
  const cleaned = t.replace(/\u00A0/g, ' ').trim();
  const hasPlus = cleaned.startsWith('+');
  const digits = cleaned.replace(/[^\d]/g, '');
  const p = hasPlus ? '+' + digits : digits;
  return p.length >= 6 ? p : null;
}

// Oracle exports dates as "2026-06-04 00:00:00.000" — MySQL DATETIME rejects
// the ".000" tail, so strip it. Anything else is passed through unchanged.
function normaliseDate(v) {
  const t = nullish(v);
  if (!t) return null;
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  return m ? `${m[1]} ${m[2]}` : t;
}

// Wrap a value in the standard notes envelope so all migrated rows can be
// found (or wiped) via JSON_EXTRACT(notes,'$.src').
function noteFor(srcId, extra = {}) {
  return JSON.stringify({ src: SRC, src_id: srcId, batch: today(), ...extra });
}
function today() { return new Date().toISOString().slice(0, 10); }

// ══════════════════════════════════════════════════════════════════════════
// Batched INSERT helper — chops rows into BATCH-sized chunks so 88k inserts
// don't blow past mysql's max_allowed_packet.
// ══════════════════════════════════════════════════════════════════════════
async function bulkInsert(table, columns, rows) {
  if (!rows.length) return 0;
  const placeholders = '(' + columns.map(() => '?').join(',') + ')';
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.flat();
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ` +
                chunk.map(() => placeholders).join(',');
    const r = await execute(sql, values);
    total += r.affectedRows ?? chunk.length;
    process.stdout.write(`   … ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  process.stdout.write(`   ✓ ${total} rows inserted into ${table}\n`);
  return total;
}

// ══════════════════════════════════════════════════════════════════════════
// Bridge caches — map source keys → target primary keys, so subsequent
// stages don't have to re-query the DB per row.
// ══════════════════════════════════════════════════════════════════════════
async function loadBridge(table, jsonPath) {
  // Reads back every row this migration has already inserted into `table`
  // (identified via the notes.src marker) and returns { src_id → new id }.
  const rows = await query(
    `SELECT id, JSON_EXTRACT(notes, '$.src_id') AS src_id
       FROM ${table}
      WHERE workshop_id = ?
        AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const map = new Map();
  for (const r of rows) {
    if (r.src_id) map.set(String(r.src_id).replace(/^"|"$/g, ''), r.id);
  }
  return map;
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK — a pre-flight of the CSVs. Reports what will be inserted vs skipped
// and surfaces the party-code linkage gap without touching the DB.
// ══════════════════════════════════════════════════════════════════════════
async function cmdCheck() {
  console.log(`\n══ Data check — workshop_id = ${WORKSHOP_ID} ══════════════════════════════\n`);
  const customers = readCsv('customers.csv');
  const vehicles  = readCsv('vehicles.csv');
  const invoices  = readCsv('invoices.csv');
  const woItems   = readCsv('workorder_items.csv');
  const invItems  = readCsv('invoice_items.csv');
  // mechanics.csv is optional — added later
  let mechanics = [];
  try { mechanics = readCsv('mechanics.csv'); } catch { /* absent = ok */ }

  console.log('Row counts:');
  console.log(`  customers.csv        ${customers.length}`);
  console.log(`  vehicles.csv         ${vehicles.length}`);
  console.log(`  invoices.csv (WOs)   ${invoices.length}`);
  console.log(`  workorder_items.csv  ${woItems.length}`);
  console.log(`  invoice_items.csv    ${invItems.length}`);
  console.log(`  mechanics.csv        ${mechanics.length}\n`);

  // ── Party-code linkage gap
  const custParty = new Set(customers.map(c => c.SOURCE_PARTY_CODE).filter(Boolean));
  const usedParty = new Set([
    ...vehicles.map(v => v.SOURCE_PARTY_CODE),
    ...invoices.map(i => i.SOURCE_INVOICE_PARTY),
  ].filter(Boolean));
  const missingParty = [...usedParty].filter(p => !custParty.has(p));

  console.log('Party-code linkage:');
  console.log(`  Referenced by vehicles/invoices: ${usedParty.size} unique codes`);
  console.log(`  Present in customers.csv:        ${custParty.size} unique codes`);
  console.log(`  MISSING (will auto-provision):   ${missingParty.length}`);
  if (missingParty.length) {
    console.log(`  Auto-created fleet customers will be named "Fleet <code>" and can`);
    console.log(`  be renamed later. First few: ${missingParty.slice(0, 8).join(', ')}\n`);
  }

  // ── Skipped rows (bad phone / missing name)
  let skipCust = 0, skipVeh = 0;
  for (const c of customers) {
    const name = nullishName(c.FULL_NAME) || nullishName(c.COMPANY_NAME);
    const phone = normalisePhone(c.PHONE);
    if (!name) skipCust++;
    else if (!phone) skipCust++;
  }
  for (const v of vehicles) {
    if (!nullish(v.SOURCE_VEHICLE_ID)) skipVeh++;
  }
  console.log('Rows that will be skipped:');
  console.log(`  customers with no name or usable phone: ${skipCust}`);
  console.log(`  vehicles with no source id: ${skipVeh}\n`);

  // ── Enum sanity — surfaces anything that would be rejected by MySQL
  const validStatus = new Set(['pending','confirmed','assigned','accepted','in_progress','inspection','ready_for_pickup','completed','cancelled']);
  const validCat = new Set(['oil_change','brake_repair','diagnostic','bodywork','tire_service','engine_repair','transmission','electrical','general_maintenance','other']);
  const badStatus = new Set(), badCat = new Set();
  for (const r of invoices) {
    if (r.STATUS && !validStatus.has(r.STATUS)) badStatus.add(r.STATUS);
    if (r.SERVICE_CATEGORY && !validCat.has(r.SERVICE_CATEGORY)) badCat.add(r.SERVICE_CATEGORY);
  }
  console.log(`Enum sanity: work_order status invalid=${badStatus.size}, service_category invalid=${badCat.size}`);
  if (badStatus.size) console.log(`  bad statuses: ${[...badStatus].join(', ')}`);
  if (badCat.size)    console.log(`  bad categories: ${[...badCat].join(', ')}`);

  console.log('\n✓ Check complete. If numbers look right, run: node scripts/oracle-migration/migrate.mjs all\n');
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// CUSTOMERS — load the CSV plus auto-provision one "Fleet <code>" customer
// per party code referenced by vehicles/invoices but not present in the CSV.
// ══════════════════════════════════════════════════════════════════════════
async function cmdCustomers() {
  console.log('\n══ Loading customers ══════════════════════════════════════════════════\n');
  const rows = readCsv('customers.csv');
  const existing = await loadBridge('customers');
  console.log(`Already imported: ${existing.size} customers`);

  // ── Real customers from the CSV. Composite key: source_customer_id OR party_code OR name+phone.
  const toInsert = [];
  let skipped = 0;
  for (const c of rows) {
    const srcId = nullish(c.SOURCE_CUSTOMER_ID);
    const partyCode = nullish(c.SOURCE_PARTY_CODE);
    // Prefer customer_id; fall back to party code for corporates without one.
    const key = srcId || (partyCode && partyCode !== 'C00002' ? partyCode : null)
              || `NAMED:${(nullish(c.FULL_NAME) || '').slice(0, 60)}`;
    if (existing.has(key)) continue;

    const name = nullishName(c.FULL_NAME) || nullishName(c.COMPANY_NAME) || null;
    const company = nullishName(c.COMPANY_NAME);
    const phone = normalisePhone(c.PHONE) || '-';  // schema requires phone NOT NULL
    if (!name) { skipped++; continue; }

    toInsert.push([
      WORKSHOP_ID, name, company, cleanEmail(c.EMAIL), phone, normalisePhone(c.PHONE_ALT),
      company ? 'business' : 'individual',
      nullish(c.ADDRESS_LINE1), nullish(c.ADDRESS_LINE2), 'Dubai',
      noteFor(key, { party_code: partyCode || null, kind: 'imported' }),
    ]);
  }
  await bulkInsert(
    'customers',
    ['workshop_id','full_name','company_name','email','phone','phone_alt','type','address_line1','address_line2','emirate','notes'],
    toInsert
  );
  if (skipped) console.log(`   ${skipped} rows skipped (no name)`);

  // ── Auto-provision "Fleet <code>" customers so vehicles have somewhere to land.
  const vehicles = readCsv('vehicles.csv');
  const invoices = readCsv('invoices.csv');
  const usedParty = new Set([
    ...vehicles.map(v => v.SOURCE_PARTY_CODE),
    ...invoices.map(i => i.SOURCE_INVOICE_PARTY),
  ].filter(Boolean));

  const bridge = await loadBridge('customers');
  const orphans = [...usedParty].filter(p => !bridge.has(p));
  const fleetRows = orphans.map(code => [
    WORKSHOP_ID, `Fleet ${code}`, `Fleet ${code}`, null, '-', null,
    'fleet', null, null, 'Dubai',
    noteFor(code, { party_code: code, kind: 'auto_fleet' }),
  ]);
  if (fleetRows.length) {
    console.log(`\nAuto-provisioning ${fleetRows.length} fleet customers for unmapped party codes …`);
    await bulkInsert(
      'customers',
      ['workshop_id','full_name','company_name','email','phone','phone_alt','type','address_line1','address_line2','emirate','notes'],
      fleetRows
    );
  }
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// VEHICLES — resolves party code → customer_id via the bridge, translates
// 3-letter make codes into human names via MAKE_MAP.
// ══════════════════════════════════════════════════════════════════════════
async function cmdVehicles() {
  console.log('\n══ Loading vehicles ═══════════════════════════════════════════════════\n');
  const bridge = await loadBridge('customers');
  console.log(`Customer bridge: ${bridge.size} entries`);

  const rows = readCsv('vehicles.csv');
  const existing = await loadBridge('vehicles');
  console.log(`Already imported: ${existing.size} vehicles`);

  const toInsert = [];
  let noCustomer = 0, badYear = 0;
  for (const v of rows) {
    const srcId = nullish(v.SOURCE_VEHICLE_ID);
    if (!srcId || existing.has(srcId)) continue;

    // Try direct source_customer_id first (empty in this export), then fall
    // back to party code — which is where all real linkage lives.
    const custKey = nullish(v.SOURCE_CUSTOMER_ID) || nullish(v.SOURCE_PARTY_CODE);
    const customerId = custKey && bridge.get(custKey);
    if (!customerId) { noCustomer++; continue; }

    const makeCode = nullish(v.MAKE) || 'UNK';
    const make = MAKE_MAP[makeCode] || makeCode;
    const model = nullish(v.MODEL) || makeCode;
    let year = nullish(v.VEHICLE_YEAR);
    if (year && !/^\d{4}$/.test(year)) { badYear++; year = null; }

    toInsert.push([
      WORKSHOP_ID, customerId, make, model,
      year ? parseInt(year, 10) : null,
      nullish(v.PLATE_NUMBER), null,  // vin not in source
      nullish(v.COLOR),
      Number.isFinite(+v.MILEAGE) ? Math.min(2147483647, Math.max(0, Math.round(+v.MILEAGE))) : null,
      ['petrol','diesel','hybrid','electric','other'].includes((v.FUEL_TYPE || '').toLowerCase())
        ? v.FUEL_TYPE.toLowerCase() : 'petrol',
      ['automatic','manual'].includes((v.TRANSMISSION || '').toLowerCase())
        ? v.TRANSMISSION.toLowerCase() : 'automatic',
      noteFor(srcId, { taxi_code: nullish(v.TAXI_CODE), party_code: nullish(v.SOURCE_PARTY_CODE) }),
    ]);
  }

  await bulkInsert(
    'vehicles',
    ['workshop_id','customer_id','make','model','year','plate_number','vin','color','mileage','fuel_type','transmission','notes'],
    toInsert
  );
  if (noCustomer) console.log(`   ${noCustomer} vehicles skipped (no matching customer — rerun 'customers' first)`);
  if (badYear)    console.log(`   ${badYear} bad year values set to NULL`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// WORK ORDERS — invoices.csv is a work-order export with invoice references
// mixed in. This step creates the work_orders row; a separate step handles
// the actual invoices.
// ══════════════════════════════════════════════════════════════════════════
async function cmdWorkOrders() {
  console.log('\n══ Loading work orders ════════════════════════════════════════════════\n');
  const custBridge = await loadBridge('customers');
  const vehBridge  = await loadBridge('vehicles');
  console.log(`Bridges: ${custBridge.size} customers, ${vehBridge.size} vehicles`);

  const rows = readCsv('invoices.csv');
  const existing = await query(
    `SELECT work_order_number FROM work_orders
      WHERE workshop_id = ? AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const done = new Set(existing.map(r => r.work_order_number));
  console.log(`Already imported: ${done.size} work orders`);

  const validStatus = new Set(['pending','confirmed','assigned','accepted','in_progress','inspection','ready_for_pickup','completed','cancelled']);
  const validCat = new Set(['oil_change','brake_repair','diagnostic','bodywork','tire_service','engine_repair','transmission','electrical','general_maintenance','other']);

  const toInsert = [];
  let noVeh = 0;
  for (const w of rows) {
    const wonum = nullish(w.SOURCE_JOB_NUMBER);
    if (!wonum || done.has(wonum)) continue;

    const status = validStatus.has(w.STATUS) ? w.STATUS : 'pending';
    const cat = validCat.has(w.SERVICE_CATEGORY) ? w.SERVICE_CATEGORY : 'general_maintenance';
    const createdAt = normaliseDate(w.CREATED_AT);
    const completedAt = status === 'completed' ? normaliseDate(w.COMPLETED_AT) : null;

    const vehicleId = vehBridge.get(nullish(w.SOURCE_VEHICLE_ID)) || null;
    if (!vehicleId) noVeh++;
    // customer_id comes from the invoice party (that's how the source models
    // fleet-billed jobs); job's own source_customer_id is empty in this export.
    const customerId = custBridge.get(nullish(w.SOURCE_INVOICE_PARTY)) || null;

    toInsert.push([
      WORKSHOP_ID, wonum, customerId, vehicleId,
      cat, status,
      createdAt || null,
      completedAt,
      noteFor(wonum, {
        loc:      nullish(w.SOURCE_LOCATION_CODE),
        job_type: nullish(w.SOURCE_JOB_TYPE),
        svc_type: nullish(w.SOURCE_SERVICE_TYPE),
        salesman: nullish(w.SOURCE_SALESMAN),
        operator: nullish(w.SOURCE_OPERATOR),
        inv:      nullish(w.SOURCE_INVOICE_NUMBER),
        opening_km: Number.isFinite(+w.OPENING_MILEAGE) ? +w.OPENING_MILEAGE : null,
      }),
    ]);
  }

  if (!toInsert.length) { console.log('Nothing to insert.'); process.exit(0); }

  // Custom bulk insert with explicit created_at column (schema DEFAULT NOW()
  // would override the historical dates if we let the default fire).
  const cols = ['workshop_id','work_order_number','customer_id','vehicle_id',
                'service_category','status','created_at','completed_at','notes'];
  await bulkInsert('work_orders', cols, toInsert);
  if (noVeh) console.log(`   ${noVeh} work orders had no linkable vehicle`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// INVOICES — same source file as work_orders. Now we create the invoices
// row too, linked back to work_order_id via the DocNumbr bridge.
// ══════════════════════════════════════════════════════════════════════════
async function cmdInvoices() {
  console.log('\n══ Loading invoices ═══════════════════════════════════════════════════\n');
  const custBridge = await loadBridge('customers');
  const woRows = await query(
    `SELECT id, work_order_number FROM work_orders
      WHERE workshop_id = ? AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const woBridge = new Map(woRows.map(r => [r.work_order_number, r.id]));

  const rows = readCsv('invoices.csv');
  const existing = await query(
    `SELECT invoice_number FROM invoices
      WHERE workshop_id = ? AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const done = new Set(existing.map(r => r.invoice_number));
  console.log(`Already imported: ${done.size} invoices`);

  const toInsert = [];
  let noCust = 0;
  for (const w of rows) {
    const invNum = nullish(w.SOURCE_INVOICE_NUMBER);
    if (!invNum || done.has(invNum)) continue;

    const customerId = custBridge.get(nullish(w.SOURCE_INVOICE_PARTY));
    if (!customerId) { noCust++; continue; }
    const workOrderId = woBridge.get(nullish(w.SOURCE_JOB_NUMBER)) || null;
    const createdAt = normaliseDate(w.CREATED_AT) || null;
    // Historical import — assume all are settled (Oracle marks them "closed")
    const status = w.STATUS === 'completed' ? 'paid' : 'sent';
    const paidAt = status === 'paid' ? (normaliseDate(w.COMPLETED_AT) || createdAt) : null;

    toInsert.push([
      WORKSHOP_ID, workOrderId, invNum, customerId,
      status, createdAt, paidAt,
      noteFor(invNum, {
        job:      nullish(w.SOURCE_JOB_NUMBER),
        party:    nullish(w.SOURCE_INVOICE_PARTY),
      }),
    ]);
  }

  if (!toInsert.length) { console.log('Nothing to insert.'); process.exit(0); }
  await bulkInsert(
    'invoices',
    ['workshop_id','work_order_id','invoice_number','customer_id','status','created_at','paid_at','notes'],
    toInsert
  );
  if (noCust) console.log(`   ${noCust} invoices skipped (no linkable customer — rerun 'customers' first)`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// WORK ORDER ITEMS — line items keyed by SOURCE_JOB_NUMBER.
// ══════════════════════════════════════════════════════════════════════════
async function cmdWoItems() {
  console.log('\n══ Loading work-order items ═══════════════════════════════════════════\n');
  const woRows = await query(
    `SELECT id, work_order_number FROM work_orders
      WHERE workshop_id = ? AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const bridge = new Map(woRows.map(r => [r.work_order_number, r.id]));

  const [{ c: haveCount }] = await query(
    `SELECT COUNT(*) AS c FROM work_order_items wi
      JOIN work_orders w ON wi.work_order_id = w.id
     WHERE w.workshop_id = ? AND w.notes IS NOT NULL AND JSON_VALID(w.notes) = 1
       AND JSON_EXTRACT(w.notes,'$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  if (haveCount > 0) {
    console.log(`Skip — work_order_items already has ${haveCount} rows from a previous run.`);
    console.log(`If you want to re-import, run: node migrate.mjs rollback wo-items`);
    process.exit(0);
  }

  const rows = readCsv('workorder_items.csv');
  const toInsert = [];
  let orphan = 0;
  for (const it of rows) {
    const woId = bridge.get(nullish(it.SOURCE_JOB_NUMBER));
    if (!woId) { orphan++; continue; }
    toInsert.push([
      woId,
      (nullish(it.NAME) || nullish(it.ITEM_CODE) || 'Item').slice(0, 255),
      Math.max(1, Math.round(+it.QUANTITY || 1)),
      Number.isFinite(+it.UNIT_PRICE) ? +it.UNIT_PRICE : 0,
      `${it.SOURCE_TYPE || ''} ${it.ITEM_CODE || ''}`.trim() || null,
    ]);
  }
  await bulkInsert('work_order_items', ['work_order_id','name','quantity','unit_price','notes'], toInsert);
  if (orphan) console.log(`   ${orphan} items had no matching work order`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// INVOICE ITEMS — line items keyed by SOURCE_INVOICE_NUMBER.
// ══════════════════════════════════════════════════════════════════════════
async function cmdInvItems() {
  console.log('\n══ Loading invoice items ══════════════════════════════════════════════\n');
  const invRows = await query(
    `SELECT id, invoice_number FROM invoices
      WHERE workshop_id = ? AND notes IS NOT NULL AND JSON_VALID(notes) = 1
        AND JSON_EXTRACT(notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  const bridge = new Map(invRows.map(r => [r.invoice_number, r.id]));

  const [{ c: haveCount }] = await query(
    `SELECT COUNT(*) AS c FROM invoice_items ii
      JOIN invoices iv ON ii.invoice_id = iv.id
     WHERE iv.workshop_id = ? AND iv.notes IS NOT NULL AND JSON_VALID(iv.notes) = 1
       AND JSON_EXTRACT(iv.notes,'$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  if (haveCount > 0) {
    console.log(`Skip — invoice_items already has ${haveCount} rows from a previous run.`);
    console.log(`If you want to re-import, run: node migrate.mjs rollback inv-items`);
    process.exit(0);
  }

  const rows = readCsv('invoice_items.csv');
  const toInsert = [];
  let orphan = 0;
  for (const it of rows) {
    const invId = bridge.get(nullish(it.SOURCE_INVOICE_NUMBER));
    if (!invId) { orphan++; continue; }
    const type = ['service','parts','cash_fee','discount'].includes(it.ITEM_TYPE) ? it.ITEM_TYPE : 'service';
    toInsert.push([
      invId, type,
      (nullish(it.DESCRIPTION) || nullish(it.ITEM_CODE) || 'Line').slice(0, 255),
      Math.max(1, Math.round(+it.QUANTITY || 1)),
      Number.isFinite(+it.UNIT_PRICE) ? +it.UNIT_PRICE : 0,
      Number.isFinite(+it.DISCOUNT) ? +it.DISCOUNT : 0,
      Number.isFinite(+it.TOTAL) ? +it.TOTAL : 0,
    ]);
  }
  await bulkInsert('invoice_items',
    ['invoice_id','item_type','description','quantity','unit_price','discount','total'],
    toInsert);
  if (orphan) console.log(`   ${orphan} items had no matching invoice`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY — post-import sanity check + KPI reconciliation.
// ══════════════════════════════════════════════════════════════════════════
async function cmdVerify() {
  console.log('\n══ Verify ═════════════════════════════════════════════════════════════\n');
  const q = (label, sql, params = []) => query(sql, params).then(r => {
    const val = r[0]?.n ?? r[0]?.c ?? '?';
    console.log(`  ${label.padEnd(45)} ${val}`);
  });
  await q('customers imported',   `SELECT COUNT(*) n FROM customers WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('  of which auto-provisioned fleet',
                                   `SELECT COUNT(*) n FROM customers WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.kind')='auto_fleet'`, [WORKSHOP_ID]);
  await q('mechanics imported',    `SELECT COUNT(*) n FROM mechanics WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('vehicles imported',     `SELECT COUNT(*) n FROM vehicles WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('work orders imported',  `SELECT COUNT(*) n FROM work_orders WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('invoices imported',     `SELECT COUNT(*) n FROM invoices WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('work_order_items rows', `SELECT COUNT(*) n FROM work_order_items wi JOIN work_orders w ON wi.work_order_id=w.id WHERE w.workshop_id=? AND w.notes IS NOT NULL AND JSON_VALID(w.notes)=1 AND JSON_EXTRACT(w.notes,'$.src')=?`, [WORKSHOP_ID, SRC]);
  await q('invoice_items rows',    `SELECT COUNT(*) n FROM invoice_items ii JOIN invoices iv ON ii.invoice_id=iv.id WHERE iv.workshop_id=? AND iv.notes IS NOT NULL AND JSON_VALID(iv.notes)=1 AND JSON_EXTRACT(iv.notes,'$.src')=?`, [WORKSHOP_ID, SRC]);

  console.log('\nWork-order status distribution (imported only):');
  const dist = await query(
    `SELECT status, COUNT(*) c FROM work_orders
      WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1
        AND JSON_EXTRACT(notes,'$.src')=?
      GROUP BY status ORDER BY c DESC`,
    [WORKSHOP_ID, SRC]
  );
  const total = dist.reduce((a, r) => a + r.c, 0);
  for (const r of dist) console.log(`  ${r.status.padEnd(20)} ${r.c}`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${total}`);
  console.log(`\n✓ Verify complete. Open http://localhost:5173/work-orders to see the data.\n`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// ROLLBACK — wipes everything this migration inserted, using the notes
// marker. Cascade FKs handle child rows (items, etc.).
// ══════════════════════════════════════════════════════════════════════════
async function cmdRollback(scope = 'all') {
  console.log(`\n══ Rollback (scope=${scope}) ══════════════════════════════════════════\n`);
  const targets = {
    'inv-items':   `DELETE ii FROM invoice_items ii JOIN invoices iv ON ii.invoice_id=iv.id
                     WHERE iv.workshop_id=? AND iv.notes IS NOT NULL AND JSON_VALID(iv.notes)=1
                       AND JSON_EXTRACT(iv.notes,'$.src')=?`,
    'wo-items':    `DELETE wi FROM work_order_items wi JOIN work_orders w ON wi.work_order_id=w.id
                     WHERE w.workshop_id=? AND w.notes IS NOT NULL AND JSON_VALID(w.notes)=1
                       AND JSON_EXTRACT(w.notes,'$.src')=?`,
    'invoices':    `DELETE FROM invoices WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`,
    'work-orders': `DELETE FROM work_orders WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`,
    'vehicles':    `DELETE FROM vehicles WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`,
    'customers':   `DELETE FROM customers WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`,
    'mechanics':   `DELETE FROM mechanics WHERE workshop_id=? AND notes IS NOT NULL AND JSON_VALID(notes)=1 AND JSON_EXTRACT(notes,'$.src')=?`,
  };
  const order = ['inv-items','wo-items','invoices','work-orders','vehicles','customers','mechanics'];
  const run = scope === 'all' ? order : [scope];
  for (const key of run) {
    if (!targets[key]) { console.log(`unknown scope: ${key}`); continue; }
    const r = await execute(targets[key], [WORKSHOP_ID, SRC]);
    console.log(`  ${key.padEnd(15)} deleted ${r.affectedRows ?? '?'} rows`);
  }
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// AMOUNTS — roll invoice-item totals up into invoices, and invoice totals
// into their work orders. Idempotent: safe to re-run after any stage.
// ══════════════════════════════════════════════════════════════════════════
async function cmdAmounts() {
  console.log('\n══ Rolling up amounts ═════════════════════════════════════════════════\n');

  const r1 = await execute(
    `UPDATE invoices iv
       JOIN (
         SELECT invoice_id,
                SUM(total) AS subtotal,
                ROUND(SUM(total) * 0.05, 2) AS tax_amount
           FROM invoice_items GROUP BY invoice_id
       ) t ON t.invoice_id = iv.id
        SET iv.subtotal     = t.subtotal,
            iv.tax_amount   = t.tax_amount,
            iv.total_amount = t.subtotal + t.tax_amount,
            iv.amount_paid  = IF(iv.status='paid', t.subtotal + t.tax_amount, iv.amount_paid)
      WHERE iv.workshop_id = ?
        AND iv.notes IS NOT NULL AND JSON_VALID(iv.notes) = 1
        AND JSON_EXTRACT(iv.notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  console.log(`   ✓ invoices updated: ${r1.affectedRows}`);

  const r2 = await execute(
    `UPDATE work_orders w
       JOIN invoices iv ON iv.work_order_id = w.id
        SET w.service_fee   = iv.total_amount,
            w.total_amount  = iv.total_amount,
            w.payment_status = IF(iv.status='paid', 'paid', w.payment_status)
      WHERE w.workshop_id = ?
        AND w.notes IS NOT NULL AND JSON_VALID(w.notes) = 1
        AND JSON_EXTRACT(w.notes, '$.src') = ?`,
    [WORKSHOP_ID, SRC]
  );
  console.log(`   ✓ work orders updated: ${r2.affectedRows}`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════
// MECHANICS — imports staff from mechanics.csv. Source has no phone column,
// so we insert '-' as a placeholder (the schema requires phone NOT NULL).
// Designation is mapped to the target `specialty` enum where possible.
// ══════════════════════════════════════════════════════════════════════════
const DESIGNATION_TO_SPECIALTY = {
  MECHANIC: 'general', MECHANICAL: 'general', 'TEAM LEADER - MECHANIC': 'general',
  FOREMAN: 'general', 'TEAM LEADER': 'general', SUPERVISOR: 'general', 'SUPRERVISOR': 'general',
  'WORKSHOP MANAGER': 'general', 'GENERAL MANAGER': 'general',
  PAINTER: 'bodywork', DENTER: 'bodywork',
  'BODYSHOP TEAM LEADER': 'bodywork', 'TEAM LEADER - BODYSHOP': 'bodywork',
  ELECTRICIAN: 'electrical', 'TEAM LEADER - ELECTRICIAN': 'electrical',
  'TYRE TECHNICIAN': 'tires',
  TESTER: 'diagnostics', ESTIMATOR: 'diagnostics',
};

async function cmdMechanics() {
  console.log('\n══ Loading mechanics ══════════════════════════════════════════════════\n');
  const rows = readCsv('mechanics.csv');
  const bridge = await loadBridge('mechanics');
  console.log(`Already imported: ${bridge.size} mechanics`);

  const validStatus = new Set(['available','busy','offline','on_break']);
  const toInsert = [];
  let skipped = 0;

  for (const m of rows) {
    const srcId = nullish(m.SOURCE_MECHANIC_ID);
    if (!srcId || bridge.has(srcId)) continue;

    const fullName = nullishName(m.FULL_NAME);
    if (!fullName) { skipped++; continue; }

    const designation = (nullish(m.DESIGNATION) || '').toUpperCase();
    const specialty = DESIGNATION_TO_SPECIALTY[designation] || 'general';
    const status = validStatus.has(nullish(m.TARGET_STATUS)) ? m.TARGET_STATUS : 'offline';
    const rate = Number.isFinite(+m.RATE_PER_HOUR) && +m.RATE_PER_HOUR > 0 ? +m.RATE_PER_HOUR : null;

    toInsert.push([
      WORKSHOP_ID, fullName,
      '-',                                   // phone (required by schema, not in source)
      null,                                  // email
      nullish(m.EMPLOYEE_CODE),              // license_number = employee code
      specialty, status, true,
      noteFor(srcId, {
        designation: nullish(m.DESIGNATION),
        employee_code: nullish(m.EMPLOYEE_CODE),
        shift:      nullish(m.SHIFT_CODE),
        cost_code:  nullish(m.COST_CODE),
        supervisor: nullish(m.SUPERVISOR_CODE),
        rate_per_hour: rate,
        user_code:  nullish(m.USER_CODE),
      }),
    ]);
  }

  await bulkInsert(
    'mechanics',
    ['workshop_id','full_name','phone','email','license_number','specialty','status','is_active','notes'],
    toInsert
  );
  if (skipped) console.log(`   ${skipped} rows skipped (no name)`);
  process.exit(0);
}

// ── entrypoint
const [cmd, arg] = process.argv.slice(2);
const dispatch = {
  check: cmdCheck, customers: cmdCustomers, vehicles: cmdVehicles,
  mechanics: cmdMechanics,
  'work-orders': cmdWorkOrders, invoices: cmdInvoices,
  'wo-items': cmdWoItems, 'inv-items': cmdInvItems,
  amounts: cmdAmounts,
  verify: cmdVerify, rollback: () => cmdRollback(arg || 'all'),
  all: async () => {
    // Run each stage in order by spawning ourselves — keeps memory bounded
    // across the big line-item files.
    const { spawnSync } = await import('node:child_process');
    for (const step of ['customers','mechanics','vehicles','work-orders','invoices','wo-items','inv-items','amounts','verify']) {
      console.log(`\n══════ ${step} ══════`);
      const r = spawnSync('node', [path.join(__dirname, 'migrate.mjs'), step], { stdio: 'inherit' });
      if (r.status !== 0) { console.error(`Step "${step}" failed`); process.exit(r.status); }
    }
    process.exit(0);
  },
};
const handler = dispatch[cmd];
if (!handler) {
  console.log(`Usage: node migrate.mjs [check|customers|vehicles|work-orders|invoices|wo-items|inv-items|all|verify|rollback [scope]]`);
  process.exit(1);
}
handler().catch(err => { console.error(err); process.exit(1); });
