/**
 * fix-identities.js — put real-looking identities on the demo staff.
 *
 * The seeded data carried placeholder domains: mechanics on
 * `@demo-workshop.local` and service advisors on `seedadv_<name>@seed.local`,
 * which read as obviously fake the moment anyone demos the product. This moves
 * every staff email onto @pioneeruae.com and gives the advisors real usernames.
 *
 * It also renames the workshop itself off "Demo Auto Workshop" and
 * info@demo-workshop.local. The slug is deliberately left alone — see
 * WORKSHOP below.
 *
 * It also relabels the owner account as the workshop manager. The `role`
 * column is deliberately left as 'admin': the frontend sidebar gates every
 * nav item on roles ['admin','dispatcher'], so changing the role string would
 * empty the menu. Only the human-readable name and email change here; the
 * badge text comes from the roles.admin translation key.
 *
 * Idempotent — re-running it makes no further changes.
 *
 * Scoped to ONE workshop. Staging has four (three left over from security
 * testing), and an earlier version treated every is_owner=1 user across all of
 * them as "the owner", handing them all the same manager@ address and dying on
 * the unique index. It also offered to rename VAPT probe accounts and real
 * addresses on other domains, neither of which it has any business touching.
 *
 *   node scripts/fix-identities.js                       # the seeded workshop
 *   node scripts/fix-identities.js --workshop=2          # by id
 *   node scripts/fix-identities.js --workshop=some-slug  # by slug
 *   node scripts/fix-identities.js --dry-run
 */

import { query, execute } from '../src/lib/database.js';

const DOMAIN = 'pioneeruae.com';
const DRY = process.argv.includes('--dry-run');
const WS_ARG = (process.argv.find(a => a.startsWith('--workshop=')) || '').split('=')[1];

/**
 * Domains that are placeholders and safe to rewrite. Anything else — a real
 * company address like @mwasalat.ae — is left alone: it is somebody's actual
 * mailbox, and rewriting it silently breaks their notifications and their
 * password reset.
 */
// DOMAIN itself is included so a row already on @pioneeruae.com runs through
// the normal path and falls out as "nothing to change", rather than being
// reported as skipped for having a real domain — which reads like a failure.
const REWRITABLE_DOMAINS = [DOMAIN, 'demo-workshop.local', 'seed.local', 'example.com'];
const isRewritable = email => {
  const at = String(email || '').toLowerCase().split('@')[1];
  return !email || REWRITABLE_DOMAINS.includes(at);
};

/**
 * Accounts created by security testing. Renaming one to
 * img.srcx.onerroralert1@pioneeruae.com is worse than leaving it: it makes a
 * probe account look like staff. They are reported for deletion instead.
 */
const isProbeAccount = u => {
  const hay = `${u.full_name || ''} ${u.username || ''} ${u.email || ''}`.toLowerCase();
  return /vapt|xss|probe\.local|test\.local|redteam|onerror|<img/.test(hay);
};

/**
 * The workshop's own identity.
 *
 * `slug` is NOT changed. It is not shown anywhere in the UI, but it is the
 * key three other things resolve against:
 *   - WORKSHOP_SLUG in the Google Form Apps Script, which posts survey
 *     responses and would start failing with "could not determine the
 *     workshop"
 *   - PUBLIC_SURVEY_WORKSHOP in .env
 *   - any public /survey?workshop=<slug> link already shared or printed on a QR
 * Renaming it is a coordinated change across all of those, not a tidy-up, so
 * it is left as it is and only the display name moves.
 */
const WORKSHOP = {
  name: 'Pioneer Car Service Center',
  email: `info@${DOMAIN}`,
};

/** Placeholder domains the seed data shipped with. */
const PLACEHOLDER_DOMAINS = ['demo-workshop.local', 'seed.local'];
const isPlaceholder = email =>
  PLACEHOLDER_DOMAINS.some(d => String(email || '').toLowerCase().endsWith('@' + d));

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
  const skipped = [];

  /* ── Pick exactly one workshop ────────────────────────────── */
  let ws;
  if (WS_ARG) {
    [ws] = await query(
      'SELECT id, name, slug, email FROM workshops WHERE id = ? OR slug = ? LIMIT 1',
      [Number(WS_ARG) || 0, WS_ARG]);
    if (!ws) { console.error(`No workshop matches "${WS_ARG}".`); process.exit(1); }
  } else {
    // Default to the seeded one rather than "the first", so running this on a
    // multi-tenant box cannot rename somebody else's workshop by accident.
    [ws] = await query(
      `SELECT id, name, slug, email FROM workshops
        WHERE name LIKE '%Demo%' OR email LIKE '%demo-workshop.local'
           OR slug LIKE '%demo%' ORDER BY id LIMIT 1`);
    if (!ws) [ws] = await query('SELECT id, name, slug, email FROM workshops ORDER BY id LIMIT 1');
    if (!ws) { console.error('No workshop found.'); process.exit(1); }
  }
  console.log(`Workshop: ${ws.name} (id ${ws.id}, slug ${ws.slug})\n`);

  /* ── The workshop itself ──────────────────────────────────── */
  if (/demo/i.test(ws.name || '') || isPlaceholder(ws.email)) {
    if (ws.name !== WORKSHOP.name || ws.email !== WORKSHOP.email) {
      changes.push({
        table: 'workshops', id: ws.id, who: ws.slug,
        from: `${ws.name} <${ws.email}>`, to: `${WORKSHOP.name} <${WORKSHOP.email}>`,
      });
      if (!DRY) {
        await execute('UPDATE workshops SET name = ?, email = ? WHERE id = ?',
          [WORKSHOP.name, WORKSHOP.email, ws.id]);
      }
    }
  }

  /* ── Mechanics (technicians) ─────────────────────────────── */
  const mechanics = await query(
    'SELECT id, full_name, email FROM mechanics WHERE workshop_id = ? ORDER BY id', [ws.id]
  );
  const mechTaken = new Set();
  for (const m of mechanics) {
    if (!isRewritable(m.email)) {
      skipped.push(`mechanics#${m.id} ${m.full_name} <${m.email}> — real domain, left alone`);
      // Reserve the local-part so a rename below cannot collide with it.
      mechTaken.add(String(m.email).split('@')[0]);
      continue;
    }
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
    'SELECT id, username, full_name, email, role, is_owner FROM users WHERE workshop_id = ? ORDER BY id',
    [ws.id]
  );
  const userTaken = new Set(
    users.map(u => String(u.email || '').split('@')[0]).filter(Boolean)
  );

  // Exactly one account becomes the manager. Several rows can carry
  // is_owner = 1, and giving them all manager@ collides on the unique index.
  const ownerRow = users.find(u => u.username === 'admin')
    || users.find(u => Number(u.is_owner) === 1 && !isProbeAccount(u));

  for (const u of users) {
    if (isProbeAccount(u)) {
      skipped.push(`users#${u.id} ${u.username} <${u.email}> — security-probe account, consider deleting`);
      continue;
    }
    if (!isRewritable(u.email)) {
      skipped.push(`users#${u.id} ${u.full_name} <${u.email}> — real domain, left alone`);
      userTaken.add(String(u.email).split('@')[0]);
      continue;
    }
    const isOwner = ownerRow && u.id === ownerRow.id;

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

  if (skipped.length) {
    console.log(`\nLeft alone (${skipped.length}):`);
    for (const line of skipped) console.log('  ' + line);
  }

  const stillDemo = (await query(
    "SELECT slug FROM workshops WHERE slug LIKE '%demo%'"
  )).map(w => w.slug);
  if (stillDemo.length) {
    console.log(`\nSlug left unchanged on purpose: ${stillDemo.join(', ')}`);
    console.log('It is not shown in the UI, and the Google Form Apps Script,');
    console.log('PUBLIC_SURVEY_WORKSHOP and any shared /survey links all resolve');
    console.log('against it. Changing it means updating those together.');
  }

  // The owner login is unchanged; say so, because "admin -> manager" invites
  // the assumption that the username moved too.
  console.log('\nLogin is unchanged: username `admin`, same password, role `admin`.');
  console.log('The MANAGER badge comes from the roles.admin translation key.');
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('[fix-identities] failed:', err.message); process.exit(1); });
