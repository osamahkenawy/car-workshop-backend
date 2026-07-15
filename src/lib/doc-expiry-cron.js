/**
 * M15 — Mechanic document (certification/license) expiry reminders.
 * Runs daily at 08:00 server time. For each workshop, finds documents
 * expiring in <= 30 days (or already expired) and emails admins.
 *
 * Idempotent: a 'reminded_at' note is appended so we don't spam more than
 * once per stage (60d/30d/14d/7d/expired).
 */
import cron from 'node-cron';
import { query } from './database.js';
import { sendNotificationEmail } from './email.js';

let job = null;

const STAGES = [60, 30, 14, 7, 0]; // days before expiry (0 = already expired)

function stageFor(daysLeft) {
  if (daysLeft < 0)  return -1;          // expired
  for (const s of STAGES) if (daysLeft <= s) return s;
  return null;
}

async function runOnce() {
  try {
    const docs = await query(`
      SELECT dd.id, dd.workshop_id, dd.mechanic_id, dd.doc_type, dd.expiry_date, dd.notes,
             m.full_name AS mechanic_name, m.phone AS mechanic_phone, t.name AS workshop_name
        FROM mechanic_documents dd
        JOIN mechanics m  ON m.id = dd.mechanic_id
        JOIN workshops t  ON t.id = dd.workshop_id
       WHERE dd.expiry_date IS NOT NULL
         AND dd.status != 'rejected'
         AND dd.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 60 DAY)
       LIMIT 5000
    `);
    if (!docs.length) return;

    // Group by workshop
    const byWorkshop = new Map();
    for (const d of docs) {
      const days = Math.floor((new Date(d.expiry_date) - new Date()) / 86400000);
      const stage = stageFor(days);
      if (stage === null) continue;
      const tag = `[reminder:${stage}]`;
      if (d.notes && d.notes.includes(tag)) continue; // already reminded for this stage
      d._stage = stage; d._daysLeft = days; d._tag = tag;
      const list = byWorkshop.get(d.workshop_id) || [];
      list.push(d);
      byWorkshop.set(d.workshop_id, list);
    }

    for (const [workshopId, workshopDocs] of byWorkshop) {
      // Find workshop admins
      const admins = await query(
        `SELECT email, full_name FROM users
          WHERE workshop_id = ? AND role IN ('admin','super_admin','manager')
            AND is_active = 1 AND email IS NOT NULL LIMIT 20`,
        [workshopId]
      );
      if (!admins.length) continue;

      const rows = workshopDocs.map(d => `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${d.mechanic_name}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${d.doc_type}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">${d.expiry_date}</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;color:${d._daysLeft < 0 ? '#dc2626' : '#d97706'};font-weight:600;">
            ${d._daysLeft < 0 ? `Expired ${-d._daysLeft}d ago` : `${d._daysLeft}d left`}
          </td>
        </tr>`).join('');

      const html = `
        <p>${workshopDocs.length} mechanic document(s) need attention:</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;">
          <thead><tr style="background:#f8fafc;">
            <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Mechanic</th>
            <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Type</th>
            <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Expires</th>
            <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left;">Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;

      await Promise.all(admins.map(a =>
        sendNotificationEmail({
          to: a.email,
          tenantId: workshopId,
          subject: `Mechanic documents expiring soon (${workshopDocs.length})`,
          title: 'Document expiry reminder',
          body: html,
        }).catch(err => console.warn('[DocExpiry] email error:', err.message))
      ));

      // Mark each doc as reminded for this stage
      for (const d of workshopDocs) {
        const newNotes = `${d.notes || ''}\n${d._tag} ${new Date().toISOString().slice(0,10)}`.trim();
        await query('UPDATE mechanic_documents SET notes = ? WHERE id = ?', [newNotes, d.id]);
      }
    }
  } catch (err) {
    console.error('[DocExpiry] run error:', err);
  }
}

export function startDocExpiryCron() {
  if (job) return;
  // Daily at 08:00
  job = cron.schedule('0 8 * * *', runOnce, { timezone: process.env.CRON_TZ || 'UTC' });
  console.log('[DocExpiry] Cron started (daily 08:00)');
}

export function stopDocExpiryCron() {
  if (job) { job.stop(); job = null; }
}

// Allow manual trigger via CLI: node src/lib/doc-expiry-cron.js --run-now
if (process.argv.includes('--run-now')) {
  runOnce().then(() => process.exit(0)).catch(() => process.exit(1));
}
