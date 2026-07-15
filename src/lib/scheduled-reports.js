/**
 * Scheduled Email Reports (#58)
 * ─────────────────────────────
 * Uses node-cron to send daily / weekly summary report emails
 * to configured admin users.
 *
 * Schedules are stored in the `report_schedules` table.
 * Each workshop can have its own schedule.
 */
import cron from 'node-cron';
import { query } from './database.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding } from '../lib/email.js';

const jobs = new Map(); // workshopId → cron.ScheduledTask

/* ── Helper: run report SQL for a workshop ───────────────────── */
async function generateReportData(workshopId, days = 1) {
  const [totals] = await query(
    `SELECT
       COUNT(*) as total_work_orders,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as failed,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN service_fee - discount ELSE 0 END), 0) as revenue,
       COALESCE(SUM(CASE WHEN payment_method = 'cash' AND status = 'completed' THEN cash_amount ELSE 0 END), 0) as cash_collected,
       COALESCE(SUM(CASE WHEN payment_method = 'cash' AND (cash_settled = 0 OR cash_settled IS NULL) AND status = 'completed' THEN cash_amount ELSE 0 END), 0) as cash_pending
     FROM work_orders
     WHERE workshop_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [workshopId, days]
  );

  const topBays = await query(
    `SELECT z.name as service_bay, COUNT(o.id) as work_orders,
            SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM work_orders o JOIN service_bays z ON o.service_bay_id = z.id
     WHERE o.workshop_id = ? AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY z.id ORDER BY work_orders DESC LIMIT 5`,
    [workshopId, days]
  );

  const topMechanics = await query(
    `SELECT m.full_name, COUNT(o.id) as jobs,
            SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM work_orders o JOIN mechanics m ON o.mechanic_id = m.id
     WHERE o.workshop_id = ? AND o.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY m.id ORDER BY jobs DESC LIMIT 5`,
    [workshopId, days]
  );

  return {
    total_work_orders: totals.total_work_orders || 0,
    completed: parseInt(totals.completed) || 0,
    failed: parseInt(totals.failed) || 0,
    revenue: parseFloat(totals.revenue) || 0,
    cash_collected: parseFloat(totals.cash_collected) || 0,
    cash_pending: parseFloat(totals.cash_pending) || 0,
    successRate: totals.total_work_orders > 0
      ? ((parseInt(totals.completed) / totals.total_work_orders) * 100).toFixed(1)
      : '0.0',
    topBays,
    topMechanics,
  };
}

/* ── Build HTML email body ───────────────────────────────────── */
function buildReportHTML(data, periodLabel, branding, currency = 'AED') {
  const fmtAED = v => `${currency} ${parseFloat(v || 0).toFixed(2)}`;

  const bayRows = data.topBays.map(z =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${z.service_bay}</td>
         <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center">${z.work_orders}</td>
         <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center">${z.completed}</td></tr>`
  ).join('');

  const mechanicRows = data.topMechanics.map(d =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${d.full_name}</td>
         <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center">${d.jobs}</td>
         <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center">${d.completed}</td></tr>`
  ).join('');

  const content = `
    <h2 style="color:#244066;margin:0 0 8px">${periodLabel} Workshop Report</h2>
    <p style="color:#64748b;font-size:14px;margin:0 0 24px">
      ${branding.name} — Generated ${new Date().toLocaleDateString('en-AE', { dateStyle: 'long' })}
    </p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr>
        <td style="padding:16px;background:#244066;color:#fff;border-radius:8px 0 0 0;text-align:center;width:33%">
          <div style="font-size:28px;font-weight:800">${data.total_work_orders}</div>
          <div style="font-size:12px;opacity:.8;margin-top:4px">Total Work Orders</div>
        </td>
        <td style="padding:16px;background:#16a34a;color:#fff;text-align:center;width:34%">
          <div style="font-size:28px;font-weight:800">${data.completed}</div>
          <div style="font-size:12px;opacity:.8;margin-top:4px">Completed (${data.successRate}%)</div>
        </td>
        <td style="padding:16px;background:#ef4444;color:#fff;border-radius:0 8px 0 0;text-align:center;width:33%">
          <div style="font-size:28px;font-weight:800">${data.failed}</div>
          <div style="font-size:12px;opacity:.8;margin-top:4px">Cancelled</div>
        </td>
      </tr>
      <tr>
        <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#244066">${fmtAED(data.revenue)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px">Revenue</div>
        </td>
        <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#f97316">${fmtAED(data.cash_collected)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px">Cash Collected</div>
        </td>
        <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 8px 0;text-align:center">
          <div style="font-size:20px;font-weight:700;color:#dc2626">${fmtAED(data.cash_pending)}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px">Cash Pending</div>
        </td>
      </tr>
    </table>

    ${data.topBays.length > 0 ? `
    <h3 style="color:#244066;margin:0 0 12px;font-size:16px">Top Service Bays</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:8px 12px;text-align:left">Service Bay</th>
          <th style="padding:8px 12px;text-align:center">Work Orders</th>
          <th style="padding:8px 12px;text-align:center">Completed</th>
        </tr>
      </thead>
      <tbody>${bayRows}</tbody>
    </table>` : ''}

    ${data.topMechanics.length > 0 ? `
    <h3 style="color:#244066;margin:0 0 12px;font-size:16px">Top Mechanics</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:8px 12px;text-align:left">Mechanic</th>
          <th style="padding:8px 12px;text-align:center">Assigned</th>
          <th style="padding:8px 12px;text-align:center">Completed</th>
        </tr>
      </thead>
      <tbody>${mechanicRows}</tbody>
    </table>` : ''}
  `;

  return buildEmailTemplate({
    title: `${periodLabel} Workshop Report`,
    body: content,
    branding,
  });
}

/* ── Send report for a single schedule ───────────────────────── */
async function executeSchedule(schedule) {
  try {
    const days = schedule.frequency === 'weekly' ? 7 : 1;
    const periodLabel = schedule.frequency === 'weekly' ? 'Weekly' : 'Daily';
    const data = await generateReportData(schedule.workshop_id, days);
    const branding = await getWorkshopBranding(schedule.workshop_id);
    const [_t] = await query('SELECT currency FROM workshops WHERE id = ?', [schedule.workshop_id]);
    const currency = _t?.currency || 'AED';
    const html = buildReportHTML(data, periodLabel, branding, currency);

    const recipients = schedule.recipients
      ? (typeof schedule.recipients === 'string' ? JSON.parse(schedule.recipients) : schedule.recipients)
      : [];

    for (const email of recipients) {
      await sendEmail({
        to: email,
        subject: `${periodLabel} Workshop Report — ${branding.name}`,
        html,
        tenantId: schedule.workshop_id,
      });
    }

    // Update last_sent
    await query('UPDATE report_schedules SET last_sent = NOW() WHERE id = ?', [schedule.id]);
    console.log(`✅ Sent ${periodLabel} report for workshop ${schedule.workshop_id} to ${recipients.length} recipients`);
  } catch (err) {
    console.error(`❌ Failed to send scheduled report (id=${schedule.id}):`, err.message);
  }
}

/* ── Start all active schedules ──────────────────────────────── */
export async function startScheduledReports() {
  try {
    // Ensure table exists
    await query(`
      CREATE TABLE IF NOT EXISTS report_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        frequency ENUM('daily','weekly') NOT NULL DEFAULT 'daily',
        cron_expression VARCHAR(50) DEFAULT '0 7 * * *',
        recipients JSON,
        is_active BOOLEAN DEFAULT TRUE,
        last_sent DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
      )
    `);

    const schedules = await query('SELECT * FROM report_schedules WHERE is_active = TRUE');

    for (const s of schedules) {
      if (jobs.has(s.id)) {
        jobs.get(s.id).stop();
      }

      const cronExpr = s.cron_expression || (s.frequency === 'weekly' ? '0 7 * * 1' : '0 7 * * *');

      if (cron.validate(cronExpr)) {
        const task = cron.schedule(cronExpr, () => executeSchedule(s), { timezone: 'Asia/Dubai' });
        jobs.set(s.id, task);
        console.log(`📧 Scheduled ${s.frequency} report #${s.id} — cron: ${cronExpr}`);
      } else {
        console.warn(`⚠️  Invalid cron for schedule #${s.id}: ${cronExpr}`);
      }
    }

    console.log(`📧 Report scheduler started — ${jobs.size} active schedule(s)`);
  } catch (err) {
    console.error('Report scheduler init error:', err.message);
  }
}

/* ── Refresh a single schedule (after create/update) ─────────── */
export function refreshSchedule(schedule) {
  if (jobs.has(schedule.id)) {
    jobs.get(schedule.id).stop();
    jobs.delete(schedule.id);
  }

  if (!schedule.is_active) return;

  const cronExpr = schedule.cron_expression || (schedule.frequency === 'weekly' ? '0 7 * * 1' : '0 7 * * *');
  if (cron.validate(cronExpr)) {
    const task = cron.schedule(cronExpr, () => executeSchedule(schedule), { timezone: 'Asia/Dubai' });
    jobs.set(schedule.id, task);
  }
}

/* ── Stop a schedule ─────────────────────────────────────────── */
export function stopSchedule(id) {
  if (jobs.has(id)) {
    jobs.get(id).stop();
    jobs.delete(id);
  }
}

/* ── Send a test/preview report now ──────────────────────────── */
export { generateReportData, buildReportHTML, executeSchedule };
