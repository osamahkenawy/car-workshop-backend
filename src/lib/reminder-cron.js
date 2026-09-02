/**
 * reminder-cron.js — raise service reminders once a day, per workshop.
 *
 * The engine itself lives in routes/crm-reminders.js and is imported rather
 * than reimplemented, so the scheduled run and the "Generate now" button in the
 * UI can never drift apart.
 *
 * It only creates and promotes reminders. Sending is deliberately left to a
 * person, or to a later opt-in: a cron that messages customers unattended is
 * how a workshop accidentally texts three hundred people at 3am. The UI shows
 * what is due and staff send from there.
 */

import cron from 'node-cron';
import { query } from './database.js';
import { generateReminders } from '../routes/crm-reminders.js';

/** 07:30 daily — before the shop opens, so the day's list is ready. */
const SCHEDULE = process.env.REMINDER_CRON || '30 7 * * *';

export async function runReminderSweep() {
  const started = Date.now();
  let workshops = [];
  try {
    workshops = await query('SELECT id, name FROM workshops WHERE is_active = 1');
  } catch {
    // Older schemas may not have is_active on workshops.
    workshops = await query('SELECT id, name FROM workshops').catch(() => []);
  }

  let totalCreated = 0, totalDue = 0;
  for (const w of workshops) {
    try {
      const r = await generateReminders(w.id, { horizonDays: 45 });
      totalCreated += r.created;
      totalDue += r.promoted_to_due;
      if (r.created || r.promoted_to_due) {
        console.log(`[Reminders] ${w.name || w.id}: +${r.created} created, ` +
          `${r.promoted_to_due} now due, ${r.skipped} skipped`);
      }
    } catch (e) {
      // One workshop's failure must not stop the others.
      console.error(`[Reminders] workshop ${w.id} failed:`, e.message);
    }
  }

  console.log(`[Reminders] sweep finished in ${Date.now() - started}ms — ` +
    `${workshops.length} workshop(s), ${totalCreated} created, ${totalDue} became due`);
  return { workshops: workshops.length, created: totalCreated, became_due: totalDue };
}

export function startReminderCron() {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[Reminders] invalid cron expression "${SCHEDULE}" — not scheduling`);
    return;
  }
  cron.schedule(SCHEDULE, () => {
    runReminderSweep().catch(e => console.error('[Reminders] sweep error:', e.message));
  });
  console.log(`[Reminders] Cron scheduled — ${SCHEDULE}`);
}

export default startReminderCron;
