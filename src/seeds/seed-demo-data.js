/**
 * Car Workshop Platform — Demo Data Seeder
 *
 * NOTE: the original source seed file (seed-demo-data.js) in the delivery-service
 * sample was itself stale — it seeded an unrelated earlier CRM schema (accounts,
 * leads, deals, quotes, pipelines) that doesn't match the delivery schema, let
 * alone the car-workshop schema. It has been replaced entirely with a seeder
 * written against car_workshop.sql: workshops, mechanics, customers, vehicles,
 * work orders, service bays, service pricing rules, and a wallet.
 *
 * Run with: node src/seeds/seed-demo-data.js
 */

import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import crypto from 'node:crypto';

const random = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

const mechanicNames = [
  { name: 'Ahmed Al Rashid', specialty: 'engine' },
  { name: 'Hassan Ibrahim', specialty: 'electrical' },
  { name: 'Youssef Khalifa', specialty: 'bodywork' },
  { name: 'Tariq Hassan', specialty: 'diagnostics' },
  { name: 'Omar Abdullah', specialty: 'transmission' },
  { name: 'Rashid Ahmad', specialty: 'tires' },
  { name: 'Khalid Saeed', specialty: 'general' },
  { name: 'Ali Mohammed', specialty: 'general' },
];

const customerNames = [
  'John Smith', 'Sarah Johnson', 'Mohammed Al Maktoum', 'Fatima Hassan', 'David Brown',
  'Aisha Ibrahim', 'Michael Davis', 'Noura Khalifa', 'Robert Wilson', 'Mariam Abdullah',
  'James Miller', 'Layla Ahmad', 'Raj Patel', 'Priya Kumar', 'Chen Wei',
  'Emily Garcia', 'Reem Saeed', 'Vikram Singh', 'Huda Rashid', 'Jennifer Lee',
];

const vehicleCatalog = [
  { make: 'Toyota', model: 'Land Cruiser' },
  { make: 'Toyota', model: 'Camry' },
  { make: 'Nissan', model: 'Patrol' },
  { make: 'Nissan', model: 'Altima' },
  { make: 'Honda', model: 'Accord' },
  { make: 'Ford', model: 'Explorer' },
  { make: 'Chevrolet', model: 'Tahoe' },
  { make: 'BMW', model: 'X5' },
  { make: 'Mercedes-Benz', model: 'E-Class' },
  { make: 'Lexus', model: 'RX 350' },
  { make: 'Hyundai', model: 'Elantra' },
  { make: 'Kia', model: 'Sportage' },
  { make: 'Mitsubishi', model: 'Pajero' },
  { make: 'Mazda', model: 'CX-5' },
  { make: 'Audi', model: 'Q7' },
];

const serviceCategories = ['oil_change', 'brake_repair', 'diagnostic', 'bodywork', 'tire_service', 'engine_repair', 'transmission', 'electrical', 'general_maintenance', 'other'];
const workOrderStatuses = ['pending', 'confirmed', 'assigned', 'accepted', 'in_progress', 'ready_for_pickup', 'completed', 'cancelled'];
const cities = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah'];
const colors = ['White', 'Black', 'Silver', 'Grey', 'Blue', 'Red'];
const fuelTypes = ['petrol', 'diesel', 'hybrid', 'electric'];

async function seed() {
  console.log('Starting car-workshop demo data seeding...\n');

  const connection = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    // ── 1. Ensure at least one demo workshop exists ──────────────────────
    let [workshops] = await connection.query('SELECT id FROM workshops LIMIT 1');
    let workshopId;
    if (workshops.length === 0) {
      console.log('No workshop found — creating a demo workshop branch...');
      const trialEnds = daysFromNow(365);
      const [result] = await connection.query(
        `INSERT INTO workshops (name, slug, subdomain, email, phone, address, city, emirate, status, trial_ends_at, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          'Demo Auto Workshop',
          'demo-auto-workshop',
          'demo',
          'info@demo-workshop.local',
          '+97141234567',
          'Al Quoz Industrial Area 3',
          'Dubai',
          'Dubai',
          trialEnds,
          JSON.stringify({ seeded: true }),
        ]
      );
      workshopId = result.insertId;
      console.log(`   Created workshop id=${workshopId}\n`);
    } else {
      workshopId = workshops[0].id;
      console.log(`Using existing workshop id=${workshopId}\n`);
    }

    // ── 2. Admin user for the workshop ───────────────────────────────────
    const [existingAdmin] = await connection.query(
      'SELECT id FROM users WHERE workshop_id = ? AND role = ? LIMIT 1',
      [workshopId, 'admin']
    );
    let adminUserId;
    if (existingAdmin.length === 0) {
      // SR-02 — the seeded password used to be the literal 'Demo@12345', which
      // is documented in a public repo and is therefore a known credential on
      // every deployment that ran this seed. Generate one instead and print it
      // once, so the operator can log in and change it. Set SEED_ADMIN_PASSWORD
      // to choose your own.
      const adminPassword = process.env.SEED_ADMIN_PASSWORD
        || `Pnr-${crypto.randomBytes(12).toString('base64url')}`;
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      const [result] = await connection.query(
        `INSERT INTO users (workshop_id, full_name, username, email, phone, password, role, is_active, is_owner, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, 1, 1)`,
        [workshopId, 'Workshop Admin', 'admin', 'admin@demo-workshop.local', '+971501234567', passwordHash]
      );
      adminUserId = result.insertId;
      console.log(`Created admin user id=${adminUserId} (username: admin)`);
      console.log(`  password: ${adminPassword}`);
      console.log('  ^ shown once. Store it now and change it after first login.');
    } else {
      adminUserId = existingAdmin[0].id;
    }

    // ── 3. Service bays ───────────────────────────────────────────────────
    console.log('Creating service bays...');
    const bayDefs = [
      { name: 'Bay 1 - Quick Service', bay_number: '1', bay_type: 'quick_service' },
      { name: 'Bay 2 - General', bay_number: '2', bay_type: 'general' },
      { name: 'Bay 3 - Diagnostics', bay_number: '3', bay_type: 'diagnostic' },
      { name: 'Bay 4 - Bodywork', bay_number: '4', bay_type: 'bodywork' },
      { name: 'Bay 5 - Tire & Alignment', bay_number: '5', bay_type: 'tire' },
    ];
    const bayIds = [];
    for (const bay of bayDefs) {
      const [result] = await connection.query(
        `INSERT INTO service_bays (workshop_id, name, bay_number, bay_type, capacity, is_active)
         VALUES (?, ?, ?, ?, 1, 1)`,
        [workshopId, bay.name, bay.bay_number, bay.bay_type]
      );
      bayIds.push(result.insertId);
    }
    console.log(`   Created ${bayIds.length} service bays\n`);

    // ── 4. Service pricing rules ──────────────────────────────────────────
    console.log('Creating service pricing rules...');
    await connection.query(
      `INSERT INTO service_pricing_rules (workshop_id, name, base_price, travel_fee_per_km, min_price, max_price, cash_fee_pct, express_surcharge, description, is_active)
       VALUES (?, 'Standard Rate', 75.00, 3.50, 50.00, 5000.00, 0.00, 50.00, 'Default workshop labor rate', 1)`,
      [workshopId]
    );
    console.log('   Created default pricing rule\n');

    // ── 5. Mechanics ───────────────────────────────────────────────────────
    console.log('Creating mechanics...');
    const mechanicIds = [];
    for (const m of mechanicNames) {
      const [result] = await connection.query(
        `INSERT INTO mechanics (workshop_id, full_name, phone, email, license_number, specialty, status, is_active, rating, total_jobs_completed, service_bay_id, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [
          workshopId,
          m.name,
          `+9715${randomInt(0, 9)}${randomInt(1000000, 9999999)}`,
          `${m.name.toLowerCase().replace(/\s+/g, '.')}@demo-workshop.local`,
          `MECH-${randomInt(10000, 99999)}`,
          m.specialty,
          random(['available', 'busy', 'offline']),
          (Math.random() * 1.5 + 3.5).toFixed(2),
          randomInt(20, 400),
          random(bayIds),
          daysAgo(randomInt(60, 900)).split(' ')[0],
        ]
      );
      mechanicIds.push(result.insertId);
    }
    console.log(`   Created ${mechanicIds.length} mechanics\n`);

    // ── 6. Customers + vehicles ───────────────────────────────────────────
    console.log('Creating customers and vehicles...');
    const customerIds = [];
    const vehicleIds = [];
    for (const name of customerNames) {
      const [result] = await connection.query(
        `INSERT INTO customers (workshop_id, full_name, email, phone, type, address_line1, city, emirate, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          workshopId,
          name,
          `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
          `+9715${randomInt(0, 9)}${randomInt(1000000, 9999999)}`,
          random(['individual', 'individual', 'individual', 'business', 'fleet']),
          `${randomInt(1, 200)} Sheikh Zayed Road`,
          random(cities),
          random(cities),
        ]
      );
      const customerId = result.insertId;
      customerIds.push(customerId);

      // 1-2 vehicles per customer
      const vehicleCount = randomInt(1, 2);
      for (let v = 0; v < vehicleCount; v++) {
        const vdef = random(vehicleCatalog);
        const [vResult] = await connection.query(
          `INSERT INTO vehicles (workshop_id, customer_id, make, model, year, plate_number, vin, color, mileage, fuel_type, transmission, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'automatic', 1)`,
          [
            workshopId,
            customerId,
            vdef.make,
            vdef.model,
            randomInt(2012, 2024),
            `${random(['A', 'B', 'D', 'F'])}${randomInt(10000, 99999)}`,
            `VIN${randomInt(100000000, 999999999)}`,
            random(colors),
            randomInt(5000, 180000),
            random(fuelTypes),
          ]
        );
        vehicleIds.push({ id: vResult.insertId, customerId });
      }
    }
    console.log(`   Created ${customerIds.length} customers and ${vehicleIds.length} vehicles\n`);

    // ── 7. Work orders ─────────────────────────────────────────────────────
    console.log('Creating work orders...');
    let workOrderCount = 0;
    for (let i = 0; i < 60; i++) {
      const vehicle = random(vehicleIds);
      const [[customerRow]] = await connection.query('SELECT full_name, phone, email FROM customers WHERE id = ?', [vehicle.customerId]);
      const status = random(workOrderStatuses);
      const mechanicId = ['pending'].includes(status) ? null : random(mechanicIds);
      const bayId = random(bayIds);
      const serviceFee = randomInt(75, 1200);
      const vatRate = 5.0;
      const vatAmount = +(serviceFee * (vatRate / 100)).toFixed(2);
      const totalAmount = +(serviceFee + vatAmount).toFixed(2);
      const workOrderNumber = `WO-${new Date().getFullYear()}-${String(i + 1).padStart(5, '0')}`;
      const serviceStatusToken = crypto.randomBytes(16).toString('hex'); // SR-08 — was Math.random()

      const [result] = await connection.query(
        `INSERT INTO work_orders
           (workshop_id, work_order_number, customer_id, vehicle_id, mechanic_id, service_bay_id,
            customer_name, customer_phone, customer_email,
            work_order_type, service_category, description,
            scheduled_at, payment_method, payment_status, service_fee, vat_rate, vat_amount, total_amount,
            status, service_status_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workshopId,
          workOrderNumber,
          vehicle.customerId,
          vehicle.id,
          mechanicId,
          bayId,
          customerRow.full_name,
          customerRow.phone,
          customerRow.email,
          random(['standard', 'express', 'scheduled']),
          random(serviceCategories),
          'Routine service and inspection',
          daysFromNow(randomInt(-10, 10)),
          random(['cash', 'prepaid', 'credit']),
          random(['pending', 'paid']),
          serviceFee,
          vatRate,
          vatAmount,
          totalAmount,
          status,
          serviceStatusToken,
          daysAgo(randomInt(0, 90)),
        ]
      );
      workOrderCount++;

      await connection.query(
        `INSERT INTO work_order_status_logs (work_order_id, status, changed_by, note) VALUES (?, ?, ?, ?)`,
        [result.insertId, status, adminUserId, `Status set to ${status} (seed data)`]
      );
    }
    console.log(`   Created ${workOrderCount} work orders\n`);

    // ── 8. Wallet ──────────────────────────────────────────────────────────
    const [existingWallet] = await connection.query('SELECT id FROM wallets WHERE workshop_id = ?', [workshopId]);
    if (existingWallet.length === 0) {
      await connection.query(
        `INSERT INTO wallets (workshop_id, balance, cash_pending, currency) VALUES (?, ?, ?, 'AED')`,
        [workshopId, randomInt(1000, 20000), randomInt(0, 2000)]
      );
      console.log('Created workshop wallet\n');
    }

    console.log('===============================================');
    console.log('DEMO DATA SUMMARY');
    console.log('===============================================');
    console.log(`   Workshop:      ${workshopId}`);
    console.log(`   Service bays:  ${bayIds.length}`);
    console.log(`   Mechanics:     ${mechanicIds.length}`);
    console.log(`   Customers:     ${customerIds.length}`);
    console.log(`   Vehicles:      ${vehicleIds.length}`);
    console.log(`   Work orders:   ${workOrderCount}`);
    console.log('===============================================');
    console.log('\nDemo data seeding complete.');
  } catch (error) {
    console.error('Error seeding data:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
