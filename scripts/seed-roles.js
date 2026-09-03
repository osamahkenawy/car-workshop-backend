/**
 * seed-roles.js — the workshop's staff roles, and one user for each.
 *
 * Module lists come from the roles matrix supplied by the business. Each entry
 * below quotes the line it came from, because "what can a Part Advisor see?"
 * is a question that gets re-asked and the answer should not have to be
 * guessed from the code.
 *
 * How access actually works here: `roles.modules` is a list of sidebar module
 * keys. On login, auth.js matches `roles.slug` to `users.role` and returns the
 * list as `permitted_modules`; Layout.jsx then shows only nav items whose
 * `moduleKey` is in it. So a role grants pages by listing them, and the keys
 * have to match the ones in Layout.jsx exactly — a typo silently hides a page
 * rather than erroring, so this script validates them against a known list.
 *
 * Requires migration 20260903_staff_roles.sql, which widens the users.role
 * enum. Without it every insert fails on a truncated-value error.
 *
 *   node scripts/seed-roles.js            # create/update roles and users
 *   node scripts/seed-roles.js --dry-run
 *   node scripts/seed-roles.js --reset-passwords
 */

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../src/lib/database.js';

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const RESET_PW = ARGS.includes('--reset-passwords');

const DOMAIN = 'pioneeruae.com';

/**
 * Every module key Layout.jsx knows about. A key not in here would never
 * match a nav item, so the role would be quietly missing a page.
 */
const KNOWN_MODULES = new Set([
  'dashboard', 'enquiries', 'work-orders', 'customers', 'vehicles', 'parts',
  'mechanics', 'job-assignment', 'service-status', 'warranty-claims',
  'crm-customers', 'crm-reminders', 'crm-tasks', 'service-bays', 'pricing',
  'inventory', 'invoices', 'cash-payment', 'wallet', 'reports', 'performance',
  'customer-feedback', 'notifications', 'settings', 'integrations',
  // technician app — deliberately not granted to office roles
  'mechanic-dashboard', 'my-work-orders', 'mechanic-scan',
]);

/** Shared by every office role: the home screen and their own alerts. */
const BASE = ['dashboard', 'notifications'];

const ROLES = [
  {
    slug: 'general_manager',
    name: 'General Manager',
    name_ar: 'المدير العام',
    description: 'Full access across every module, including settings and finance.',
    // Not in the supplied matrix; the business asked for it alongside the
    // others. Everything except the technician-app screens, which only make
    // sense for a mechanic signed in on the shop floor.
    modules: [
      ...BASE, 'enquiries', 'work-orders', 'job-assignment', 'service-status',
      'customers', 'vehicles', 'mechanics', 'service-bays', 'parts', 'inventory',
      'invoices', 'cash-payment', 'wallet', 'pricing', 'warranty-claims',
      'customer-feedback', 'reports', 'performance',
      'crm-customers', 'crm-reminders', 'crm-tasks', 'settings', 'integrations',
    ],
    user: { full_name: 'General Manager', username: 'general.manager' },
  },
  {
    slug: 'workshop_manager',
    name: 'Workshop Manager',
    name_ar: 'مدير الورشة',
    // Matrix: "Workshop Manager — Weal ... no need to part and access"
    description: 'Runs the workshop. Everything operational except parts and stock.',
    modules: [
      ...BASE, 'enquiries', 'work-orders', 'job-assignment', 'service-status',
      'customers', 'vehicles', 'mechanics', 'service-bays', 'invoices',
      'warranty-claims', 'customer-feedback', 'reports', 'performance',
      'crm-customers', 'crm-reminders', 'crm-tasks',
    ],
    // "no need to part and access" — parts and inventory are left out on
    // purpose, not by omission.
    user: { full_name: 'Wael', username: 'wael' },
  },
  {
    slug: 'service_advisor',
    name: 'Service Advisor',
    name_ar: 'مستشار الخدمة',
    // Matrix: "can create and assign the jobs" / "History and create new job
    // card" / "Invoice, Quotation" / people: RJ and Vino
    description: 'Front desk. Creates and assigns jobs, raises invoices and quotations.',
    modules: [
      ...BASE, 'enquiries', 'work-orders', 'job-assignment', 'service-status',
      'customers', 'vehicles', 'invoices', 'customer-feedback',
      'crm-customers', 'crm-reminders', 'crm-tasks',
    ],
    user: { full_name: 'RJ', username: 'rj' },
  },
  {
    slug: 'part_advisor',
    name: 'Part Advisor',
    name_ar: 'مستشار قطع الغيار',
    // Matrix: "he can assign the parts only and Stock" / "No access to labors"
    description: 'Parts and stock only. No access to labour or technician assignment.',
    modules: [
      ...BASE, 'parts', 'inventory',
      // Work orders are included read-side because a part is fitted to a job;
      // job-assignment and mechanics are the "labors" the matrix excludes.
      'work-orders',
    ],
    user: { full_name: 'Nahaf', username: 'nahaf' },
  },
  {
    slug: 'supervisor',
    name: 'Supervisor',
    name_ar: 'مشرف',
    // Matrix: "Operations, Analytics, Dashboard, Delivered vehicle, Work In
    // progres, waiting for card, Job card, Customer data"
    description: 'Operations and analytics: job progress, delivered vehicles, customer data.',
    modules: [
      // "Delivered vehicle", "work in progress" and "waiting for card" are all
      // views of a work order's status, so they come from work-orders plus
      // service-status rather than being separate modules.
      ...BASE, 'work-orders', 'job-assignment', 'service-status',
      'customers', 'vehicles', 'reports', 'performance',
    ],
    user: { full_name: 'Supervisor', username: 'supervisor' },
  },
  {
    slug: 'customer',
    name: 'Customer',
    name_ar: 'عميل',
    description: 'Vehicle owner. Sees only their own jobs through the customer portal.',
    // Customers do NOT sign in through `users` — customer-auth.js
    // authenticates against `customers.password_hash`. This row exists so the
    // role is listed and named consistently; the portal login is created
    // separately below.
    modules: ['my-work-orders', 'service-status'],
    user: null,
  },
  {
    slug: 'super_admin',
    name: 'Super Admin',
    name_ar: 'مدير النظام',
    description: 'Platform owner. Cross-workshop access through the super-admin console.',
    // Likewise not a `users` login in practice: super-admin.js authenticates
    // against the separate `super_admins` table. Kept here so the slug
    // resolves to a name, and the console account is created below.
    modules: [
      'dashboard', 'notifications', 'reports', 'performance', 'settings', 'integrations',
    ],
    user: null,
  },
  {
    slug: 'workshop_foreman',
    name: 'Workshop Foreman',
    name_ar: 'رئيس عمال الورشة',
    // Matrix: "Workshop Forman — Foreman"
    description: 'Shop floor lead: assigns technicians, manages bays and job progress.',
    modules: [
      ...BASE, 'work-orders', 'job-assignment', 'service-status',
      'mechanics', 'service-bays',
    ],
    user: { full_name: 'Workshop Foreman', username: 'workshop.foreman' },
  },
];

/**
 * A password nobody has to be told twice: printed once here, never stored in
 * the repo. Ambiguous characters are left out so it survives being read off a
 * screen and typed by hand.
 */
function makePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // A symbol and a digit so it satisfies any policy that demands them.
  return `${out.slice(0, 6)}-${out.slice(6, 10)}-${out.slice(10)}${crypto.randomInt(10)}`;
}

async function run() {
  const [ws] = await query('SELECT id, name FROM workshops ORDER BY id LIMIT 1');
  if (!ws) throw new Error('No workshop found.');

  // Fail loudly rather than creating roles that grant a page that does not
  // exist.
  const bad = [];
  for (const r of ROLES) {
    for (const m of r.modules) if (!KNOWN_MODULES.has(m)) bad.push(`${r.slug} -> ${m}`);
    const dupes = r.modules.filter((m, i) => r.modules.indexOf(m) !== i);
    if (dupes.length) bad.push(`${r.slug} -> duplicate ${dupes.join(', ')}`);
  }
  if (bad.length) {
    console.error('Unknown or duplicated module keys:\n  ' + bad.join('\n  '));
    process.exit(1);
  }

  // The enum has to accept the new slugs or every user insert fails.
  const [col] = await query(
    `SELECT COLUMN_TYPE t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role'`);
  const missing = ROLES.map(r => r.slug).filter(s => !String(col?.t || '').includes(`'${s}'`));
  if (missing.length) {
    console.error(
      'users.role does not accept: ' + missing.join(', ')
      + '\nRun the migration first:\n'
      + '  mysql -u <user> -p <db> < src/migrations/20260903_staff_roles.sql');
    process.exit(1);
  }

  console.log(`\nWorkshop: ${ws.name} (id ${ws.id})`);
  console.log(DRY ? 'Mode: dry run — nothing will be written\n' : 'Mode: applying\n');

  const credentials = [];

  for (const r of ROLES) {
    // ── the role ──────────────────────────────────────────────
    const [existingRole] = await query(
      'SELECT id FROM roles WHERE workshop_id = ? AND slug = ?', [ws.id, r.slug]);
    let roleId = existingRole?.id || null;
    const modulesJson = JSON.stringify(r.modules);

    if (!DRY) {
      if (roleId) {
        await execute(
          `UPDATE roles SET name = ?, name_ar = ?, description = ?, modules = ?,
                            is_system = 0, is_active = 1
            WHERE id = ?`,
          [r.name, r.name_ar, r.description, modulesJson, roleId]);
      } else {
        const res = await execute(
          `INSERT INTO roles (workshop_id, name, name_ar, slug, description, modules, is_system, is_active)
           VALUES (?,?,?,?,?,?,0,1)`,
          [ws.id, r.name, r.name_ar, r.slug, r.description, modulesJson]);
        roleId = res.insertId;
      }
    }
    console.log(`  ${r.name.padEnd(18)} ${existingRole ? 'updated' : 'created'}  `
      + `${String(r.modules.length).padStart(2)} module(s)`);

    // ── its user ──────────────────────────────────────────────
    // customer and super_admin authenticate elsewhere; their accounts are
    // created after this loop, against the tables they actually use.
    if (!r.user) {
      credentials.push({
        role: r.name, username: '(see below)', name: '—',
        password: '(separate login)', modules: r.modules.length,
      });
      continue;
    }
    const email = `${r.user.username}@${DOMAIN}`;
    const [existingUser] = await query(
      'SELECT id, username FROM users WHERE workshop_id = ? AND username = ?',
      [ws.id, r.user.username]);

    let password = null;
    if (!existingUser || RESET_PW) {
      password = makePassword();
    }

    if (!DRY) {
      const hash = password ? await bcrypt.hash(password, 10) : null;
      if (existingUser) {
        await execute(
          `UPDATE users SET full_name = ?, email = ?, role = ?, role_id = ?, is_active = 1
             ${hash ? ', password = ?' : ''}
            WHERE id = ?`,
          hash
            ? [r.user.full_name, email, r.slug, roleId, hash, existingUser.id]
            : [r.user.full_name, email, r.slug, roleId, existingUser.id]);
      } else {
        await execute(
          `INSERT INTO users
             (workshop_id, full_name, username, email, password, role, role_id,
              is_active, is_owner, email_verified)
           VALUES (?,?,?,?,?,?,?,1,0,1)`,
          [ws.id, r.user.full_name, r.user.username, email, hash, r.slug, roleId]);
      }
    }

    credentials.push({
      role: r.name,
      username: r.user.username,
      name: r.user.full_name,
      password: password || '(unchanged)',
      modules: r.modules.length,
    });
  }

  /* ── Customer portal login ──────────────────────────────────
     Rather than invent a customer, this promotes an existing one that already
     has jobs, invoices and a vehicle behind them — a portal with an empty
     history demonstrates nothing. */
  let portal = null;
  const [cust] = await query(
    `SELECT c.id, c.full_name, c.email
       FROM customers c
      WHERE c.workshop_id = ? AND c.email IS NOT NULL AND c.email <> ''
        AND (SELECT COUNT(*) FROM work_orders o WHERE o.customer_id = c.id) > 3
      ORDER BY (SELECT COUNT(*) FROM work_orders o WHERE o.customer_id = c.id) DESC
      LIMIT 1`, [ws.id]);
  if (cust) {
    const pw = makePassword();
    if (!DRY) {
      // is_verified must be set too: customer-auth.js refuses the login with
      // EMAIL_NOT_VERIFIED before it ever checks the password, and there is no
      // mail delivery on a demo box to complete the loop.
      await execute(
        `UPDATE customers SET password_hash = ?, is_verified = 1,
                              verification_token = NULL, verification_expires = NULL
          WHERE id = ?`,
        [await bcrypt.hash(pw, 10), cust.id]);
    }
    portal = { who: cust.full_name, login: cust.email, password: pw };
  }

  /* ── Super-admin console account ────────────────────────────
     The `super_admins` table was empty, so the platform console had no way in
     at all. This is deliberately a separate credential from the workshop
     `admin`: it is cross-workshop and outranks every role above. */
  let superAdmin = null;
  const [existingSA] = await query(
    'SELECT id FROM super_admins WHERE username = ? LIMIT 1', ['superadmin']);
  const saPw = (!existingSA || RESET_PW) ? makePassword() : null;
  if (!DRY && saPw) {
    const hash = await bcrypt.hash(saPw, 10);
    if (existingSA) {
      await execute('UPDATE super_admins SET password = ?, is_active = 1 WHERE id = ?',
        [hash, existingSA.id]);
    } else {
      await execute(
        `INSERT INTO super_admins (username, email, password, full_name, role, is_active)
         VALUES (?,?,?,?, 'super_admin', 1)`,
        ['superadmin', `superadmin@${DOMAIN}`, hash, 'Platform Super Admin']);
    }
  }
  superAdmin = { login: 'superadmin', password: saPw || '(unchanged)' };

  console.log('\n' + '─'.repeat(74));
  console.log('SIGN-IN DETAILS — shown once, not stored anywhere. Save them now.');
  console.log('─'.repeat(74));
  for (const c of credentials) {
    console.log(`  ${c.role.padEnd(18)} ${c.username.padEnd(18)} ${c.password}`);
  }
  console.log('─'.repeat(74));

  if (portal) {
    console.log('\nCUSTOMER PORTAL (separate login — customers table, not staff users)');
    console.log(`  ${portal.who}`);
    console.log(`  ${portal.login.padEnd(38)} ${portal.password}`);
  }
  if (superAdmin) {
    console.log('\nSUPER ADMIN CONSOLE (separate login — super_admins table)');
    console.log(`  ${superAdmin.login.padEnd(38)} ${superAdmin.password}`);
    console.log('  Cross-workshop platform access. Treat this as the most');
    console.log('  privileged credential here and do not reuse it.');
  }

  console.log('\nRe-run with --reset-passwords to issue new ones.');
  console.log('The workshop `admin` account is untouched.\n');
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n[seed-roles] failed:', err.message); process.exit(1); });
