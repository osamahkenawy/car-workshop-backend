/**
 * fix-identities.js — put real-looking identities on the demo staff.
 *
 * The seeded data carried placeholder domains: mechanics on
 * `@demo-workshop.local` and service advisors on `seedadv_<name>@seed.local`,
 * which read as obviously fake the moment anyone demos the product. This moves
 * every staff email onto @pioneeruae.com and gives the advisors real usernames.
 *
 * It also relabels the owner account as the workshop manager. The `role`
 * column is deliberately left as 'admin': the frontend sidebar gates every
 * nav item on roles ['admin','dispatcher'], so changing the role string would
 * empty the menu. Only the human-readable name and email change here; the
 * badge text comes from the roles.admin translation key.
 *
 * Idempotent — re-running it makes no further changes.
 *
 *   node scripts/fix-identities.js            # apply
 *   node scripts/fix-identities.js --dry-run  # show what would change
 */

import { query, execute } from '../src/lib/database.js';

const DOMAIN = 'pioneeruae.com';
const DRY = process.argv.includes('--dry-run');

/** "Ahmed Al Rashid" -> "ahmed.al.rashid" */
function slug(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join('.') || 'staff';
}

/**
 * Two people can share a name, and both `users.username` and the email
 * columns are unique, so a taken local-part gets a numeric suffix rather than
 * failing the whole run.
 */
function unique(base, taken) {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) candidate = `${base}${n++}`;
  taken.add(candidate);
  return candidate;
}

async function run() {
  const changes = [];

  /* ── Mechanics (technicians) ─────────────────────────────── */
  const mechanics = await query(
    'SELECT id, full_name, email FROM mechanics ORDER BY id'
  );
  const mechTaken = new Set();
  for (const m of mechanics) {
    const local = unique(slug(m.full_name), mechTaken);
    const email = `${local}@${DOMAIN}`;
    if (m.email === email) continue;
    changes.push({ table: 'mechanics', id: m.id, who: m.full_name, from: m.email, to: email });
    if (!DRY) await execute('UPDATE mechanics SET email = ? WHERE id = ?', [email, m.id]);
  }

  /* ── Staff users ─────────────────────────────────────────── */
  // Collect local-parts already in use so a rename cannot collide with a row
  // this run is not touching.
  const users = await query(
    'SELECT id, username, full_name, email, role, is_owner FROM users ORDER BY id'
  );
  const userTaken = new Set(
    users.map(u => String(u.email || '').split('@')[0]).filter(Boolean)
  );

  for (const u of users) {
    const isOwner = Number(u.is_owner) === 1 || u.username === 'admin';

    // The owner keeps the `admin` username and role — only the label moves.
    if (isOwner) {
      const email = `manager@${DOMAIN}`;
      const name = 'Workshop Manager';
      if (u.email === email && u.full_name === name) continue;
      changes.push({
        table: 'users', id: u.id, who: u.username,
        from: `${u.full_name} <${u.email}>`, to: `${name} <${email}>`,
      });
      if (!DRY) {
        await execute(
          'UPDATE users SET full_name = ?, email = ? WHERE id = ?',
          [name, email, u.id]
        );
      }
      continue;
    }

    // Advisors seeded as `seedadv_nadiakhoury` become `nadia.khoury`. Nobody
    // logs in as these accounts (they were created with random unusable
    // passwords), so renaming the username is safe.
    const base = slug(u.full_name);
    userTaken.delete(String(u.email || '').split('@')[0]);
    const local = unique(base, userTaken);
    const email = `${local}@${DOMAIN}`;
    if (u.email === email && u.username === local) continue;
    changes.push({
      table: 'users', id: u.id, who: u.full_name,
      from: `${u.username} <${u.email}>`, to: `${local} <${email}>`,
    });
    if (!DRY) {
      await execute(
        'UPDATE users SET username = ?, email = ? WHERE id = ?',
        [local, email, u.id]
      );
    }
  }

  /* ── Report ──────────────────────────────────────────────── */
  if (!changes.length) {
    console.log('Nothing to change — identities are already correct.');
  } else {
    console.log(`${DRY ? '[dry run] would change' : 'Changed'} ${changes.length} row(s):\n`);
    for (const c of changes) {
      console.log(`  ${c.table}#${String(c.id).padEnd(4)} ${c.who}`);
      console.log(`      ${c.from}`);
      console.log(`   -> ${c.to}`);
    }
  }

  // The owner login is unchanged; say so, because "admin -> manager" invites
  // the assumption that the username moved too.
  console.log('\nLogin is unchanged: username `admin`, same password, role `admin`.');
  console.log('The MANAGER badge comes from the roles.admin translation key.');
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('[fix-identities] failed:', err.message); process.exit(1); });
