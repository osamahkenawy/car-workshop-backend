import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { query } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Singleton transporter ──────────────────────────────────
let transporter = null;

/**
 * Get or create the Nodemailer transporter.
 * Handles Office 365, Gmail, and generic SMTP.
 */
function getTransporter() {
  if (transporter) return transporter;

  const { host, port, user, pass, secure, tls } = config.smtp;

  if (!host) {
    console.warn('⚠️  Email not configured — no EMAIL_HOST in .env');
    return null;
  }

  const opts = {
    host,
    port,
    secure,                         // true for 465, false for 587
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };

  // Only add auth if credentials are provided
  if (user && pass) {
    opts.auth = { user, pass };
  }

  // For secure (port 465) — just allow self-signed certs in dev
  if (secure) {
    opts.tls = { rejectUnauthorized: false };
  }
  // STARTTLS (port 587) — Office 365, Namecheap, etc.
  else if (tls) {
    opts.requireTLS = true;
    opts.tls = {
      rejectUnauthorized: false,
    };
  }

  transporter = nodemailer.createTransport(opts);

  // Verify connection on first creation (non-blocking)
  transporter.verify()
    .then(() => console.log('✅ Email transporter verified — ready to send'))
    .catch((err) => {
      console.error('❌ Email transporter verification failed:', err.message);
      if (err.code === 'EAUTH' || err.message.includes('535') || err.message.includes('Authentication')) {
        console.error('\n═══════════════════════════════════════════════════════════');
        console.error('  EMAIL AUTH FAILED — check your EMAIL_USER / EMAIL_PASS');
        console.error('═══════════════════════════════════════════════════════════');
        console.error('  For Office 365:');
        console.error('  1. admin.microsoft.com → Users → Active users → noreply@traseallo.com');
        console.error('  2. Mail tab → Manage email apps → Enable "Authenticated SMTP"');
        console.error('  OR use App Password if MFA is enabled');
        console.error('═══════════════════════════════════════════════════════════\n');
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.error('  💡 Network issue — cannot reach', host + ':' + port);
      }
    });

  return transporter;
}

/**
 * Get the "From" display name for a workshop.
 * Falls back to: workshop.name → EMAIL_NAME env → "Trasealla Solutions"
 */
async function getFromName(workshopId) {
  if (workshopId) {
    try {
      const rows = await query('SELECT name, settings FROM workshops WHERE id = ?', [workshopId]);
      if (rows.length > 0) {
        let settings = {};
        try {
          settings = rows[0].settings
            ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings)
            : {};
        } catch (e) { /* ignore */ }
        if (settings.company_name) return settings.company_name;
        if (rows[0].name) return rows[0].name;
      }
    } catch (e) { /* ignore, use fallback */ }
  }
  return config.smtp.fromName || 'Trasealla Solutions';
}

/**
 * Get the public base URL for constructing absolute links.
 * In production uses FRONTEND_URL; locally falls back to localhost.
 */
function getBaseUrl() {
  if (config.frontendUrl && config.frontendUrl !== 'http://localhost:5173') return config.frontendUrl;
  if (process.env.NODE_ENV === 'production') return 'https://delivery.traseallo.com';
  return config.frontendUrl || 'http://localhost:5173';
}

/**
 * Get the backend API base URL (for serving uploaded files like logos).
 */
function getApiBaseUrl() {
  return process.env.BACKEND_URL || (process.env.NODE_ENV === 'production'
    ? 'https://delivery.traseallo.com'
    : `http://localhost:${config.port || 4001}`);
}

/**
 * Default Traseallo logo URL — hosted from backend uploads so it works
 * in all email clients regardless of frontend state.
 */
function getDefaultTraseAlloLogo() {
  return `${getApiBaseUrl()}/uploads/logos/email/traseallo-logo.png`;
}

/**
 * Get the Traseallo logo as a CID attachment for embedding in emails.
 * Returns { src, attachment } where:
 *   - src = 'cid:traseallo-logo' (use in <img src="...">)
 *   - attachment = Nodemailer attachment object to include in the email
 */
function getLogoCidAttachment() {
  const logoPath = path.resolve(__dirname, '../../uploads/logos/email/traseallo-logo.png');
  return {
    src: 'cid:traseallo-logo',
    attachment: {
      filename: 'traseallo-logo.png',
      path: logoPath,
      cid: 'traseallo-logo',
      contentDisposition: 'inline',
    },
  };
}

/**
 * Convert a stored logo path (e.g. /uploads/logos/xxx.png) to an
 * absolute URL that works inside email clients.
 */
function absoluteLogoUrl(rawUrl) {
  if (!rawUrl) return null;
  // Already absolute
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return rawUrl;
  const base = getBaseUrl();
  // /uploads/logos/xxx.png  →  /api/file?path=logos/xxx.png
  if (rawUrl.startsWith('/uploads/')) {
    const relPath = rawUrl.replace(/^\/uploads\//, '');
    return `${base}/api/file?path=${encodeURIComponent(relPath)}`;
  }
  // Any other relative path — just prepend base
  return `${base}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
}

/**
 * Get workshop branding (name + logo URL).
 * Falls back to Traseallo logo when workshop has no logo set.
 */
async function getWorkshopBranding(workshopId) {
  const defaultLogo = getDefaultTraseAlloLogo();
  if (workshopId) {
    try {
      const rows = await query('SELECT name, logo_url, settings FROM workshops WHERE id = ?', [workshopId]);
      if (rows.length > 0) {
        let settings = {};
        try {
          settings = rows[0].settings
            ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings)
            : {};
        } catch (e) { /* ignore */ }
        const name = settings.company_name || rows[0].name || 'Trasealla Solutions';

        // Only use workshop logo if it's a non-empty string
        const rawLogo = rows[0].logo_url;
        const hasLogo = rawLogo && typeof rawLogo === 'string' && rawLogo.trim().length > 0;
        const logoUrl = hasLogo ? (absoluteLogoUrl(rawLogo) || defaultLogo) : defaultLogo;
        const isSystem = !hasLogo;

        return { name, logoUrl, isSystem };
      }
    } catch (e) { /* ignore */ }
  }
  return { name: 'Trasealla Solutions', logoUrl: defaultLogo, isSystem: true };
}

/**
 * Build a branded HTML email template for work-order notifications.
 *
 * Accepts either explicit params or a `branding` shortcut:
 *   buildEmailTemplate({ logoUrl, logoAlt, title, bodyHtml, ... })
 *   buildEmailTemplate({ branding, title, bodyHtml, ... })
 *   buildEmailTemplate({ branding, title, body, ... })   // body = alias for bodyHtml
 */
function buildEmailTemplate(opts, legacyBodyHtml) {
  // Legacy 2-arg call:  buildEmailTemplate(branding, htmlString)
  if (legacyBodyHtml !== undefined && typeof legacyBodyHtml === 'string') {
    const branding = opts || {};
    return buildEmailTemplate({
      logoUrl: branding.logoUrl,
      logoAlt: branding.name || 'Traseallo',
      title: '',
      bodyHtml: legacyBodyHtml,
      footerName: branding.name || 'Trasealla Solutions',
      isSystem: branding.isSystem !== false,
    });
  }

  // Support `branding` object shortcut
  const branding = opts.branding || {};
  const cidLogo = getLogoCidAttachment();
  const {
    logoUrl  = branding.logoUrl  || cidLogo.src,
    logoAlt  = branding.name     || 'Traseallo',
    accentColor = '#f97316',
    title, subtitle,
    bodyHtml = opts.body || '',
    ctaText, ctaUrl, copyLink, expiryNote,
    footerName = branding.name || 'Trasealla Solutions',
    isSystem   = branding.isSystem !== undefined ? branding.isSystem : true,
  } = opts;
  // Use CID for the system logo (when branding has no custom logo)
  const effectiveLogoUrl = (isSystem || logoUrl === cidLogo.src) ? cidLogo.src : logoUrl;
  const logoBlock = `
    <table cellpadding="0" cellspacing="0" style="display:inline-table;">
      <tr>
        <td style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;
                   box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:14px 28px;text-align:center;">
          <img src="${effectiveLogoUrl}" alt="${logoAlt}" height="44"
               style="display:block;height:44px;width:auto;max-width:220px;" />
        </td>
      </tr>
    </table>`;

  const ctaBlock = ctaText && ctaUrl ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 32px;">
      <tr>
        <td align="center">
          <table cellpadding="0" cellspacing="0" style="border-radius:10px;" bgcolor="${accentColor}">
            <tr>
              <td align="center" style="padding:15px 44px;border-radius:10px;" bgcolor="${accentColor}">
                <a href="${ctaUrl}"
                   style="display:inline-block;color:#ffffff;
                          text-decoration:none;
                          font-size:15px;font-weight:700;letter-spacing:0.02em;
                          font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
                  &#8594;&nbsp; ${ctaText}
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>` : '';

  const copyLinkBlock = copyLink ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="background:#f8fafc;border:1px solid #e9edf2;border-radius:10px;padding:14px 18px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;">Or copy this link</p>
          <p style="margin:0;font-size:12px;color:#475569;word-break:break-all;font-family:'Courier New',monospace;">${copyLink}</p>
        </td>
      </tr>
    </table>` : '';

  const expiryBlock = expiryNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr>
        <td style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#92400e;">
            &#9203; This link expires in <strong>${expiryNote}</strong>.
          </p>
        </td>
      </tr>
    </table>` : '';

  const footerHtml = isSystem
    ? `Trasealla Solutions &nbsp;&bull;&nbsp; <a href="https://traseallo.com" style="color:#f97316;text-decoration:none;font-weight:500;">traseallo.com</a>`
    : `${footerName} &nbsp;&bull;&nbsp; Powered by <a href="https://traseallo.com" style="color:#f97316;text-decoration:none;font-weight:500;">Trasealla Solutions</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr><td align="center" style="padding:0 0 28px;">${logoBlock}</td></tr>
        <tr>
          <td style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;
                     box-shadow:0 4px 24px rgba(0,0,0,0.06);overflow:hidden;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="height:6px;font-size:0;line-height:0;" bgcolor="${accentColor}">&nbsp;</td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:40px 40px 32px;">
                  <h1 style="margin:0 0 ${subtitle ? '8' : '28'}px;font-size:22px;font-weight:700;color:#111827;">${title}</h1>
                  ${subtitle ? `<p style="margin:0 0 28px;font-size:14px;color:#6b7280;">${subtitle}</p>` : ''}
                  <div style="font-size:14px;color:#6b7280;line-height:1.75;">${bodyHtml}</div>
                  ${ctaBlock}
                  ${copyLinkBlock}
                  ${expiryBlock}
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">${footerHtml}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Send an email.
 *
 * @param {Object} opts
 * @param {string}  opts.to          – Recipient email
 * @param {string}  opts.subject     – Subject line
 * @param {string}  opts.html        – HTML body
 * @param {string}  [opts.text]      – Plain-text body (auto-strips HTML if omitted)
 * @param {number}  [opts.tenantId]  – Workshop ID for dynamic "From" name
 * @param {string}  [opts.fromName]  – Override "From" display name
 * @param {Array}   [opts.attachments] – Nodemailer attachment array
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, tenantId, fromName, attachments }) {
  const transport = getTransporter();
  if (!transport) {
    console.log(`📧 EMAIL (not configured — dev mode):\n   To: ${to}\n   Subject: ${subject}\n`);
    return { success: false, error: 'Email not configured (no SMTP credentials)' };
  }

  const displayName = fromName || await getFromName(tenantId);
  const fromAddress = config.smtp.from || config.smtp.user;

  // Auto-attach the Traseallo CID logo when the HTML references it
  const allAttachments = Array.isArray(attachments) ? [...attachments] : [];
  if (html && html.includes('cid:traseallo-logo')) {
    const hasCidAlready = allAttachments.some(a => a.cid === 'traseallo-logo');
    if (!hasCidAlready) {
      allAttachments.push(getLogoCidAttachment().attachment);
    }
  }

  try {
    const info = await transport.sendMail({
      from: `"${displayName}" <${fromAddress}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
    });
    console.log(`✅ Email sent to ${to} (messageId: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a branded notification email (work order updates, service confirmations, etc.)
 */
export async function sendNotificationEmail({ to, subject, title, body, ctaText, ctaUrl, tenantId, attachments, copyLink, expiryNote }) {
  const branding = await getWorkshopBranding(tenantId);
  const cidLogo = getLogoCidAttachment();

  const html = buildEmailTemplate({
    logoUrl: branding.isSystem ? cidLogo.src : branding.logoUrl,
    logoAlt: branding.name,
    accentColor: '#f97316',
    title: title || subject,
    bodyHtml: `<div style="color:#6b7280;line-height:1.75;">${body}</div>`,
    ctaText,
    ctaUrl,
    copyLink,
    expiryNote,
    footerName: branding.name,
    isSystem: branding.isSystem,
  });

  // Always include the CID logo attachment when using system branding
  const allAttachments = [...(Array.isArray(attachments) ? attachments : [])];
  if (branding.isSystem) allAttachments.push(cidLogo.attachment);

  return sendEmail({ to, subject, html, tenantId, fromName: branding.name, attachments: allAttachments.length ? allAttachments : undefined });
}

/**
 * Build a work-order-status email with a nice status timeline table.
 */
export function buildWorkOrderStatusEmail({ order, status, trackingUrl, branding, currency = 'AED' }) {
  const statusEmoji = {
    pending:    '🕐', confirmed: '✅', assigned: '👤', accepted: '✅', picked_up: '📦',
    in_transit: '🚗', delivered: '🎉', failed: '❌', returned: '↩️', cancelled: '🚫',
  };
  const statusLabel = {
    pending: 'Pending', confirmed: 'Confirmed', assigned: 'Assigned', accepted: 'Accepted',
    picked_up: 'Vehicle Picked Up', in_transit: 'In Progress',
    delivered: 'Completed', failed: 'Service Failed',
    returned: 'Returned', cancelled: 'Cancelled',
  };
  const statusColor = {
    pending: '#f59e0b', confirmed: '#10b981', assigned: '#6366f1', accepted: '#7c3aed',
    picked_up: '#3b82f6', in_transit: '#f97316',
    delivered: '#16a34a', failed: '#dc2626',
    returned: '#8b5cf6', cancelled: '#94a3b8',
  };

  const emoji  = statusEmoji[status]  || '&#128203;';
  const label  = statusLabel[status]  || status;
  const color  = statusColor[status]  || '#f97316';

  // Map status colors to safe light backgrounds (email clients don't support hex-alpha)
  const statusBg = {
    pending: '#fef3c7', confirmed: '#d1fae5', assigned: '#e0e7ff', accepted: '#f3e8ff',
    picked_up: '#dbeafe', in_transit: '#ffedd5',
    delivered: '#dcfce7', failed: '#fee2e2',
    returned: '#ede9fe', cancelled: '#f1f5f9',
  };
  const bgColor = statusBg[status] || '#fff7ed';

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Hi <strong>${order.recipient_name || 'there'}</strong>,
    </p>
    <div style="background:${bgColor};border-left:4px solid ${color};border-radius:0 8px 8px 0;padding:16px 20px;margin:0 0 20px;">
      <p style="margin:0;font-size:18px;font-weight:700;color:${color};">
        ${emoji} ${label}
      </p>
      <p style="margin:6px 0 0;font-size:14px;color:#475569;">
        Work order <strong>${order.order_number}</strong> is now <strong>${label.toLowerCase()}</strong>.
      </p>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;font-size:13px;">
      <tr>
        <td style="padding:8px 0;color:#94a3b8;width:120px;">Work Order Number</td>
        <td style="padding:8px 0;font-weight:600;color:#1e293b;">${order.order_number}</td>
      </tr>
      ${order.tracking_token ? `<tr>
        <td style="padding:8px 0;color:#94a3b8;">Tracking ID</td>
        <td style="padding:8px 0;font-weight:600;color:#1e293b;">${order.tracking_token}</td>
      </tr>` : ''}
      <tr>
        <td style="padding:8px 0;color:#94a3b8;">Service Address</td>
        <td style="padding:8px 0;color:#1e293b;">${order.recipient_address || '—'}${order.recipient_emirate ? ', ' + order.recipient_emirate : ''}</td>
      </tr>
      ${order.payment_method === 'cod' && parseFloat(order.cod_amount) > 0 ? `<tr>
        <td style="padding:8px 0;color:#94a3b8;">Cash Payment Amount</td>
        <td style="padding:8px 0;font-weight:700;color:#d97706;">${currency} ${parseFloat(order.cod_amount).toFixed(2)}</td>
      </tr>` : ''}
      ${order.driver_name ? `<tr>
        <td style="padding:8px 0;color:#94a3b8;">Mechanic</td>
        <td style="padding:8px 0;color:#1e293b;">${order.driver_name}${order.driver_phone ? ' · ' + order.driver_phone : ''}</td>
      </tr>` : ''}
    </table>`;

  return buildEmailTemplate({
    logoUrl: branding.logoUrl,
    logoAlt: branding.name,
    accentColor: color,
    title: `${emoji} Your Work Order is ${label}`,
    subtitle: `Work Order ${order.order_number}`,
    bodyHtml,
    ctaText: trackingUrl ? 'Track Your Work Order' : undefined,
    ctaUrl: trackingUrl || undefined,
    footerName: branding.name,
    isSystem: branding.isSystem,
  });
}

export { buildEmailTemplate, getWorkshopBranding, getFromName, getDefaultTraseAlloLogo, getLogoCidAttachment };
export default { sendEmail, sendNotificationEmail, buildWorkOrderStatusEmail, buildEmailTemplate, getWorkshopBranding, getDefaultTraseAlloLogo, getLogoCidAttachment };
