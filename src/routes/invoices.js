import express from 'express';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { getFinancialConfig } from '../lib/financial.js';
import { logAudit } from '../lib/audit.js';
import https from 'https';
import http from 'http';

const router = express.Router();

/**
 * Ported from delivery-service-backend/src/routes/invoices.js.
 * The `invoices` and `invoice_items` tables already exist in car_workshop.sql
 * with the final shape (workshop_id, work_order_id, customer_id, item_type
 * ENUM('service','parts','cash_fee','discount')) — so, unlike the source,
 * we do NOT auto-create/ALTER them here; they're assumed migrated.
 *
 * Renamed: tenant_id -> workshop_id, order_id -> work_order_id,
 * client_id -> customer_id, 'delivery' item_type -> 'service',
 * 'cod' item_type -> 'cash_fee'.
 *
 * IMPORTANT: createInvoiceFromOrder is renamed to createInvoiceFromWorkOrder —
 * this export name is relied on by other route files (e.g. work-orders.js).
 */

// ── Helper: fetch remote image as buffer ─────────────────────
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Generate secure public token for invoice QR
function generatePublicToken(workshopId, invoiceId) {
  const secret = process.env.JWT_SECRET || 'traseallo_workshop_secret_2026';
  const hmac = crypto.createHmac('sha256', secret).update(`${workshopId}-${invoiceId}`).digest('hex').slice(0, 16);
  return `${workshopId}-${invoiceId}-${hmac}`;
}

// ═══════════════════════════════════════════════════════════════
// Shared Invoma-style PDF generator (used by auth + public routes)
// Exported so customer-portal.js can stream a customer's own invoice
// without redirecting through the staff-authenticated route below.
// ═══════════════════════════════════════════════════════════════
export async function generateInvoicePDF(res, { invoice, workshop, customer, items, order, vatNumber, workshopId }) {
  const doc = new PDFDocument({ margin: 0, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  doc.pipe(res);

  const W = doc.page.width;   // 595.28
  const H = doc.page.height;  // 841.89
  const M = 50; // margin
  const RIGHT = W - M;

  // ── Color Palette (Invoma-inspired) ───────────────────────
  const PRIMARY    = '#111827';
  const ACCENT     = '#f97316';
  const GRAY_TEXT  = '#6b7280';
  const GRAY_BG    = '#f3f4f6';
  const GRAY_LINE  = '#e5e7eb';
  const WHITE      = '#ffffff';

  const fmtN = v => parseFloat(v || 0).toFixed(2);
  const createdDate = invoice.created_at
    ? new Date(invoice.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';
  const dueDate = invoice.due_date
    ? new Date(invoice.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—';

  // ═══════════════════════════════════════════════════════════
  // HEADER — Logo left, "INVOICE" title right
  // ═══════════════════════════════════════════════════════════
  let logoLoaded = false;
  if (workshop?.logo_url) {
    try {
      let logoBuffer;
      if (workshop.logo_url.startsWith('http')) {
        logoBuffer = await fetchImageBuffer(workshop.logo_url);
      } else {
        const fsM = await import('fs');
        const pathM = await import('path');
        const localPath = pathM.default.resolve(workshop.logo_url.replace(/^\//, ''));
        if (fsM.default.existsSync(localPath)) {
          logoBuffer = fsM.default.readFileSync(localPath);
        }
      }
      if (logoBuffer && logoBuffer.length > 100) {
        doc.image(logoBuffer, M, 35, { width: 120, height: 50 });
        logoLoaded = true;
      }
    } catch (e) { console.error('Logo load failed:', e.message); }
  }

  if (!logoLoaded) {
    doc.fillColor(PRIMARY).fontSize(26).font('Helvetica-Bold')
       .text(workshop?.name || 'Traseallo', M, 40);
  }

  doc.fillColor(ACCENT).fontSize(38).font('Helvetica-Bold')
     .text('INVOICE', M, 35, { align: 'right', width: RIGHT - M });

  // ═══════════════════════════════════════════════════════════
  // SEPARATOR BAR + Invoice info
  // ═══════════════════════════════════════════════════════════
  const sepY = 95;
  doc.rect(M, sepY, RIGHT - M, 3).fill(GRAY_BG);

  const infoY = sepY + 12;
  doc.fillColor(PRIMARY).fontSize(10).font('Helvetica')
     .text('Invoice No: ', M, infoY, { continued: true })
     .font('Helvetica-Bold').fillColor(ACCENT)
     .text(invoice.invoice_number);
  doc.fillColor(PRIMARY).fontSize(10).font('Helvetica')
     .text('Date: ', 350, infoY, { continued: true })
     .font('Helvetica-Bold').fillColor(ACCENT)
     .text(createdDate);

  // ═══════════════════════════════════════════════════════════
  // BILLING — "Invoice To" left, "Pay To" right
  // ═══════════════════════════════════════════════════════════
  const billY = infoY + 30;

  doc.fillColor(ACCENT).fontSize(10).font('Helvetica-Bold')
     .text('Invoice To:', M, billY);
  const customerName = customer?.full_name || order?.customer_name || 'Walk-in Customer';
  const customerAddr = [
    customer?.address_line1 || order?.dropoff_address || '',
    [customer?.area, customer?.city, customer?.emirate].filter(Boolean).join(', '),
    customer?.email || ''
  ].filter(Boolean).join('\n');
  doc.fillColor(PRIMARY).fontSize(10).font('Helvetica')
     .text(customerName, M, billY + 16)
     .text(customerAddr, M, billY + 30, { width: 220, lineGap: 2 });

  doc.fillColor(ACCENT).fontSize(10).font('Helvetica-Bold')
     .text('Pay To:', 350, billY, { width: RIGHT - 350, align: 'right' });
  const companyAddr = [
    workshop?.address || '',
    [workshop?.city, workshop?.country].filter(Boolean).join(', '),
    workshop?.email || '',
    workshop?.phone || ''
  ].filter(Boolean).join('\n');
  doc.fillColor(PRIMARY).fontSize(10).font('Helvetica')
     .text(workshop?.name || 'Traseallo', 350, billY + 16, { width: RIGHT - 350, align: 'right' })
     .text(companyAddr, 350, billY + 30, { width: RIGHT - 350, align: 'right', lineGap: 2 });

  if (vatNumber) {
    doc.fillColor(GRAY_TEXT).fontSize(8).font('Helvetica')
       .text(`TRN: ${vatNumber}`, 350, billY + 78, { width: RIGHT - 350, align: 'right' });
  }

  // ═══════════════════════════════════════════════════════════
  // TABLE — Items (bordered, Invoma style)
  // ═══════════════════════════════════════════════════════════
  const tableTop = billY + 120;
  const colItem  = M + 10;
  const colDesc  = M + 160;
  const colPrice = W - 230;
  const colQty   = W - 150;
  const colTotal = W - 95;
  const rowH     = 28;
  const tableW   = RIGHT - M;

  // Header row
  doc.roundedRect(M, tableTop, tableW, rowH, 4).fill(GRAY_BG);
  doc.fillColor(ACCENT).fontSize(9).font('Helvetica-Bold');
  doc.text('Item',        colItem,  tableTop + 8);
  doc.text('Description', colDesc,  tableTop + 8);
  doc.text('Price',       colPrice, tableTop + 8, { width: 60, align: 'right' });
  doc.text('Qty',         colQty,   tableTop + 8, { width: 40, align: 'right' });
  doc.text('Total',       colTotal, tableTop + 8, { width: 50, align: 'right' });

  // Data rows
  let rY = tableTop + rowH;
  const lineItems = items.length > 0 ? items : [
    { description: `Service for work order ${order?.work_order_number || invoice.work_order_id || ''}`, quantity: 1, unit_price: invoice.subtotal, total: invoice.subtotal }
  ];

  lineItems.forEach((item, idx) => {
    if (idx % 2 === 1) doc.rect(M, rY, tableW, rowH).fill('#fafafa');
    doc.fillColor(PRIMARY).fontSize(9).font('Helvetica');
    doc.text(`${idx + 1}.`, colItem, rY + 8);
    doc.text(item.description || 'Service', colDesc, rY + 8, { width: colPrice - colDesc - 10 });
    doc.text(fmtN(item.unit_price), colPrice, rY + 8, { width: 60, align: 'right' });
    doc.text(String(item.quantity || 1), colQty, rY + 8, { width: 40, align: 'right' });
    doc.text(fmtN(item.total), colTotal, rY + 8, { width: 50, align: 'right' });
    rY += rowH;
  });

  doc.moveTo(M, rY).lineTo(RIGHT, rY).strokeColor(GRAY_LINE).lineWidth(1).stroke();

  // ═══════════════════════════════════════════════════════════
  // FOOTER — Payment info left, Totals right
  // ═══════════════════════════════════════════════════════════
  const footY = rY + 15;

  doc.fillColor(ACCENT).fontSize(10).font('Helvetica-Bold')
     .text('Payment info:', M, footY);
  const payMethod = invoice.payment_method || order?.payment_method || 'CASH';
  doc.fillColor(GRAY_TEXT).fontSize(9).font('Helvetica')
     .text(`Method: ${payMethod.toUpperCase()}`, M, footY + 16)
     .text(`Status: ${invoice.status?.toUpperCase() || 'SENT'}`, M, footY + 30);
  if (invoice.status === 'paid' && invoice.paid_at) {
    doc.text(`Paid: ${new Date(invoice.paid_at).toLocaleDateString('en-GB')}`, M, footY + 44);
  }

  const totX = 350;
  const totVX = colTotal;
  let totY = footY;

  doc.fillColor(ACCENT).fontSize(10).font('Helvetica-Bold')
     .text('Subtotal', totX, totY, { width: 100, align: 'right' });
  doc.fillColor(PRIMARY).font('Helvetica-Bold')
     .text(`${invoice.currency} ${fmtN(invoice.subtotal)}`, totVX, totY, { width: 50, align: 'right' });

  if (parseFloat(invoice.discount_amount) > 0) {
    totY += 18;
    doc.fillColor(ACCENT).fontSize(9).font('Helvetica')
       .text('Discount', totX, totY, { width: 100, align: 'right' });
    doc.fillColor(PRIMARY).font('Helvetica')
       .text(`-${invoice.currency} ${fmtN(invoice.discount_amount)}`, totVX, totY, { width: 50, align: 'right' });
  }

  if (parseFloat(invoice.tax_rate) > 0) {
    totY += 18;
    doc.fillColor(ACCENT).fontSize(9).font('Helvetica')
       .text(`Tax (${invoice.tax_rate}%)`, totX, totY, { width: 100, align: 'right' });
    doc.fillColor(PRIMARY).font('Helvetica')
       .text(`+${invoice.currency} ${fmtN(invoice.tax_amount)}`, totVX, totY, { width: 50, align: 'right' });
  }

  totY += 22;
  doc.moveTo(totX, totY).lineTo(RIGHT, totY).strokeColor(GRAY_LINE).lineWidth(1).stroke();
  totY += 8;
  doc.moveTo(totX, totY + 20).lineTo(RIGHT, totY + 20).strokeColor(GRAY_LINE).lineWidth(1).stroke();

  doc.fillColor(PRIMARY).fontSize(13).font('Helvetica-Bold')
     .text('Grand Total', totX, totY, { width: 100, align: 'right' });
  doc.fillColor(ACCENT).fontSize(13).font('Helvetica-Bold')
     .text(`${invoice.currency} ${fmtN(invoice.total_amount)}`, totVX - 10, totY, { width: 60, align: 'right' });

  // ═══════════════════════════════════════════════════════════
  // QR CODE — bottom-left, scans to public PDF download
  // ═══════════════════════════════════════════════════════════
  const qrY = Math.max(totY + 50, footY + 80);
  try {
    const publicToken = generatePublicToken(workshopId, invoice.id);
    const baseUrl = process.env.BACKEND_URL || process.env.BASE_URL
      || (process.env.NODE_ENV === 'production' ? 'https://api.traseallo.com' : `http://localhost:${process.env.PORT || 4001}`);
    const publicUrl = `${baseUrl}/api/invoices/public/${publicToken}/pdf`;

    const qrDataUrl = await QRCode.toDataURL(publicUrl, {
      width: 120, margin: 1,
      color: { dark: PRIMARY, light: WHITE },
    });
    const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    doc.image(qrBuffer, M, qrY, { width: 90, height: 90 });
    doc.fillColor(GRAY_TEXT).fontSize(7).font('Helvetica')
       .text('Scan to download invoice', M, qrY + 92, { width: 90, align: 'center' });
  } catch (qrErr) {
    console.error('QR generation failed:', qrErr.message);
  }

  // ═══════════════════════════════════════════════════════════
  // TERMS & CONDITIONS
  // ═══════════════════════════════════════════════════════════
  const termsY = qrY + 115;
  if (termsY < H - 100) {
    doc.roundedRect(M, termsY, tableW, 55, 4).strokeColor(GRAY_LINE).lineWidth(1).stroke();
    doc.fillColor(ACCENT).fontSize(9).font('Helvetica-Bold')
       .text('Terms & Conditions:', M + 10, termsY + 8);
    doc.fillColor(GRAY_TEXT).fontSize(7.5).font('Helvetica')
       .text('• Payment is due upon receipt unless otherwise agreed. Late payments may incur additional charges.', M + 10, termsY + 22, { width: tableW - 20 })
       .text('• Estimated completion dates are approximate. The workshop is not liable for delays beyond reasonable control.', M + 10, termsY + 35, { width: tableW - 20 });
  }

  // ═══════════════════════════════════════════════════════════
  // BOTTOM FOOTER
  // ═══════════════════════════════════════════════════════════
  doc.moveTo(M, H - 50).lineTo(RIGHT, H - 50).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
  doc.fillColor(GRAY_TEXT).fontSize(8).font('Helvetica')
     .text(
       `Thank you for your business  •  ${workshop?.email || 'info@traseallo.com'}  •  ${workshop?.phone || ''}`,
       M, H - 40, { align: 'center', width: RIGHT - M }
     );

  doc.end();
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTER — Separate Express router (no auth middleware)
// ═══════════════════════════════════════════════════════════════
const publicRouter = express.Router();

publicRouter.get('/:token/pdf', async (req, res) => {
  try {
    const parts = req.params.token.split('-');
    if (parts.length < 3) return res.status(400).json({ success: false, message: 'Invalid token' });

    const workshopId = parseInt(parts[0]);
    const invoiceId = parseInt(parts[1]);
    const hash = parts.slice(2).join('-');

    const expected = generatePublicToken(workshopId, invoiceId).split('-').slice(2).join('-');
    if (hash !== expected) return res.status(403).json({ success: false, message: 'Invalid or expired link' });

    const [invoice] = await query('SELECT * FROM invoices WHERE id = ? AND workshop_id = ?', [invoiceId, workshopId]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [workshop] = await query('SELECT name, email, phone, address, city, country, logo_url FROM workshops WHERE id = ?', [workshopId]);
    const [customer] = await query('SELECT full_name, email, phone, address_line1, address_line2, city, emirate FROM customers WHERE id = ?', [invoice.customer_id]);
    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    const [order] = invoice.work_order_id
      ? await query('SELECT work_order_number, customer_name, customer_phone, dropoff_address, payment_method FROM work_orders WHERE id = ?', [invoice.work_order_id])
      : [null];

    let vatNumber = '';
    try { const finCfg = await getFinancialConfig(workshopId); vatNumber = finCfg.vatNumber || ''; } catch {}

    await generateInvoicePDF(res, { invoice, workshop, customer, items, order, vatNumber, workshopId });
  } catch (err) {
    console.error('Public invoice PDF error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATED ROUTES — Below this line requires auth
// ═══════════════════════════════════════════════════════════════
router.use(authMiddleware);

// ── GET /api/invoices/:id/pdf — Authenticated PDF download
router.get('/:id/pdf', async (req, res) => {
  try {
    const workshopId = req.workshopId;
    const invoiceId = parseInt(req.params.id);

    const [invoice] = await query('SELECT * FROM invoices WHERE id = ? AND workshop_id = ?', [invoiceId, workshopId]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const [workshop] = await query('SELECT name, email, phone, address, city, country, logo_url FROM workshops WHERE id = ?', [workshopId]);
    const [customer] = await query('SELECT full_name, email, phone, address_line1, address_line2, city, emirate FROM customers WHERE id = ?', [invoice.customer_id]);
    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    const [order] = invoice.work_order_id
      ? await query('SELECT work_order_number, customer_name, customer_phone, dropoff_address, payment_method FROM work_orders WHERE id = ?', [invoice.work_order_id])
      : [null];

    let vatNumber = '';
    try { const finCfg = await getFinancialConfig(workshopId); vatNumber = finCfg.vatNumber || ''; } catch {}

    await generateInvoicePDF(res, { invoice, workshop, customer, items, order, vatNumber, workshopId });
  } catch (err) {
    console.error('Invoice PDF error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Failed to generate PDF' });
  }
});

// ── Generate next invoice number for workshop
async function getNextInvoiceNumber(workshopId) {
  const [last] = await query(
    "SELECT invoice_number FROM invoices WHERE workshop_id = ? ORDER BY id DESC LIMIT 1",
    [workshopId]
  );
  if (!last || !last.invoice_number) return 'INV-0001';
  const num = parseInt(last.invoice_number.replace('INV-', '')) || 0;
  return `INV-${String(num + 1).padStart(4, '0')}`;
}

// ── Auto-create invoice from a completed work order (exported for work-orders.js to use)
// RENAMED from createInvoiceFromOrder -> createInvoiceFromWorkOrder. This export
// name matters: other route files import it by this exact name.
async function createInvoiceFromWorkOrder(workOrderId, workshopId, createdBy) {
  try {
    const [order] = await query(
      `SELECT o.*, c.full_name as customer_full_name, c.email as customer_email
       FROM work_orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.id = ? AND o.workshop_id = ?`,
      [workOrderId, workshopId]
    );

    if (!order) return null;

    // Check if invoice already exists
    const [existing] = await query(
      'SELECT id FROM invoices WHERE work_order_id = ? AND workshop_id = ?',
      [workOrderId, workshopId]
    );
    if (existing) return existing;

    const invoiceNumber = await getNextInvoiceNumber(workshopId);

    // Get workshop info
    const [workshop] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
    const currency = workshop?.currency || 'AED';

    // Build invoice from work order details — use real VAT from workshop config
    const subtotal = order.service_fee || 0;
    const discountAmount = order.discount || 0;

    // Read financial config for VAT
    let finConfig;
    try { finConfig = await getFinancialConfig(workshopId); } catch { finConfig = { vatEnabled: false, vatRate: 0 }; }

    // Tax-exempt customer handling
    let customerTaxExempt = false;
    try {
      const [customerInfo] = await query('SELECT tax_exempt FROM customers WHERE id = ? AND workshop_id = ?', [order.customer_id, workshopId]);
      customerTaxExempt = customerInfo?.tax_exempt === 1;
    } catch {}

    const taxRate = (finConfig.vatEnabled && !customerTaxExempt) ? (finConfig.vatRate || 0) : 0;
    const taxableBase = Math.max(0, subtotal - discountAmount);
    const taxAmount = taxRate > 0 ? Math.round(taxableBase * (taxRate / 100) * 100) / 100 : 0;
    const totalAmount = taxableBase + taxAmount;

    const result = await execute(
      `INSERT INTO invoices (workshop_id, work_order_id, invoice_number, customer_id,
        subtotal, discount_amount, tax_rate, tax_amount, total_amount,
        currency, status, payment_method, created_by)
       VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?)`,
      [workshopId, workOrderId, invoiceNumber, order.customer_id,
       subtotal, discountAmount, taxRate, taxAmount, totalAmount,
       currency, 'sent', order.payment_method || 'cash', createdBy || null]
    );

    const invoiceId = result.insertId;

    // Add service fee as line item
    await execute(
      `INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, total)
       VALUES (?,?,?,?,?,?)`,
      [invoiceId, 'service', `Service for work order ${order.work_order_number}`, 1, subtotal, subtotal]
    );

    // Add discount if present
    if (discountAmount > 0) {
      await execute(
        `INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, total, discount)
         VALUES (?,?,?,?,?,?,?)`,
        [invoiceId, 'discount', `Discount`, 1, 0, -discountAmount, discountAmount]
      );
    }

    return { id: invoiceId, invoice_number: invoiceNumber };
  } catch (error) {
    console.error('Error creating invoice from work order:', error);
    return null;
  }
}

// ── Expose for work-order routes to call
export { createInvoiceFromWorkOrder };

// ── POST /api/invoices/generate-missing — retroactively create invoices for completed work orders without one
router.post('/generate-missing', async (req, res) => {
  try {
    const orders = await query(
      `SELECT o.id FROM work_orders o
       LEFT JOIN invoices i ON i.work_order_id = o.id AND i.workshop_id = o.workshop_id
       WHERE o.workshop_id = ? AND o.status IN ('confirmed','assigned','accepted','in_progress','ready_for_pickup','completed')
         AND i.id IS NULL
       ORDER BY o.id`,
      [req.workshopId]
    );

    let created = 0, failed = 0;
    for (const o of orders) {
      try {
        const inv = await createInvoiceFromWorkOrder(o.id, req.workshopId, req.user?.id);
        if (inv) created++;
        else failed++;
      } catch { failed++; }
    }

    return res.json({
      success: true,
      message: `Generated ${created} invoice(s)${failed ? `, ${failed} failed` : ''}`,
      data: { created, failed, total_missing: orders.length },
    });
  } catch (err) {
    console.error('[Invoices] Generate missing error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate missing invoices' });
  }
});

// ── GET /api/invoices/stats
router.get('/stats', async (req, res) => {
  try {
    const t = req.workshopId;
    const [stats] = await query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END) as total_paid,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status IN ('draft','sent') THEN total_amount ELSE 0 END) as total_pending,
        SUM(CASE WHEN status IN ('draft','sent') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'overdue' THEN total_amount ELSE 0 END) as total_overdue,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_count,
        SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) as void_count
      FROM invoices WHERE workshop_id = ?
    `, [t]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Invoice stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/invoices — list invoices with pagination & filters
router.get('/', async (req, res) => {
  try {
    const t = req.workshopId;
    const {
      status, customer_id, from_date, to_date, search, page = 1, limit = 20
    } = req.query;

    let where = 'WHERE i.workshop_id = ?';
    const params = [t];

    if (status) { where += ' AND i.status = ?'; params.push(status); }
    if (customer_id) { where += ' AND i.customer_id = ?'; params.push(customer_id); }
    if (from_date) { where += ' AND DATE(i.created_at) >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND DATE(i.created_at) <= ?'; params.push(to_date); }
    if (search) {
      where += ' AND (i.invoice_number LIKE ? OR c.full_name LIKE ? OR o.work_order_number LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM invoices i
       LEFT JOIN customers c ON i.customer_id = c.id
       LEFT JOIN work_orders o ON i.work_order_id = o.id
       ${where}`, params
    );

    const pg = parseInt(page);
    const lm = parseInt(limit);
    const offset = (pg - 1) * lm;

    const invoices = await query(`
      SELECT i.*,
        c.full_name as customer_name, c.email as customer_email,
        o.work_order_number, o.customer_name as work_order_customer_name, o.status as work_order_status
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN work_orders o ON i.work_order_id = o.id
      ${where}
      ORDER BY i.created_at DESC
      LIMIT ${lm} OFFSET ${offset}
    `, params);

    res.json({
      success: true,
      data: invoices,
      pagination: {
        page: pg,
        limit: lm,
        total,
        totalPages: Math.ceil(total / lm)
      }
    });
  } catch (error) {
    console.error('List invoices error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/invoices/:id — get single invoice with items
router.get('/:id', async (req, res) => {
  try {
    const [invoice] = await query(`
      SELECT i.*,
        c.full_name as customer_name, c.email as customer_email, c.phone as customer_phone,
        o.work_order_number, o.customer_name as work_order_customer_name,
        o.customer_phone as work_order_customer_phone, o.dropoff_address
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN work_orders o ON i.work_order_id = o.id
      WHERE i.id = ? AND i.workshop_id = ?
    `, [req.params.id, req.workshopId]);

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    invoice.items = items;

    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/invoices — manually create invoice
router.post('/', async (req, res) => {
  try {
    const {
      customer_id, work_order_id, items = [], notes, payment_method,
      discount_amount = 0, discount_type = 'fixed',
      tax_rate = 0, due_date, currency,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one line item required' });
    }

    const invoiceNumber = await getNextInvoiceNumber(req.workshopId);

    let curr = currency;
    if (!curr) {
      const [workshop] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
      curr = workshop?.currency || 'AED';
    }

    // Calculate totals from items
    const subtotal = items.reduce(
      (sum, item) => sum + (parseFloat(item.unit_price) || 0) * (parseInt(item.quantity) || 1), 0
    );
    const discAmt = Math.max(0, parseFloat(discount_amount) || 0);
    const rate    = Math.max(0, parseFloat(tax_rate) || 0);
    const taxAmt  = rate > 0 ? (subtotal - discAmt) * (rate / 100) : 0;
    const total   = Math.max(0, subtotal - discAmt + taxAmt);

    const result = await execute(
      `INSERT INTO invoices
         (workshop_id, work_order_id, invoice_number, customer_id,
          subtotal, discount_amount, discount_type, tax_rate, tax_amount, total_amount,
          currency, status, payment_method, notes, due_date, created_by)
       VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)`,
      [req.workshopId, work_order_id || null, invoiceNumber, customer_id || null,
       subtotal, discAmt, discount_type, rate, taxAmt, total,
       curr, 'draft', payment_method || null, notes || null, due_date || null, req.user.id]
    );

    const invoiceId = result.insertId;

    for (const item of items) {
      const qty       = Math.max(1, parseInt(item.quantity) || 1);
      const unitPrice = parseFloat(item.unit_price) || 0;
      await execute(
        `INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, total)
         VALUES (?,?,?,?,?,?)`,
        [invoiceId, item.item_type || 'service', item.description || 'Service', qty, unitPrice, qty * unitPrice]
      );
    }

    const [invoice] = await query('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    invoice.items   = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

    return res.status(201).json({ success: true, data: invoice, message: `Invoice ${invoiceNumber} created` });
  } catch (err) {
    console.error('Create invoice error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create invoice' });
  }
});

// ── PATCH /api/invoices/:id/status — update invoice status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['draft', 'sent', 'paid', 'partially_paid', 'overdue', 'void', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const [invoice] = await query(
      'SELECT id FROM invoices WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    const updates = { status };
    if (status === 'paid') {
      updates.paid_at = new Date();
    }

    await execute(
      'UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?',
      [status, updates.paid_at || null, req.params.id]
    );

    res.json({
      success: true,
      message: `Invoice marked as ${status}`,
      data: { id: req.params.id, status }
    });
  } catch (error) {
    console.error('Update invoice status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  try {
    const [invoice] = await query(
      'SELECT id FROM invoices WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );

    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }

    await execute('DELETE FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    await execute('DELETE FROM invoices WHERE id = ?', [req.params.id]);

    res.json({ success: true, message: 'Invoice deleted' });
  } catch (error) {
    console.error('Delete invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REFUND & CANCELLATION FINANCIAL ADJUSTMENT
// ═══════════════════════════════════════════════════════════════

router.post('/refund', async (req, res) => {
  try {
    const { work_order_id, invoice_id, amount, reason, refund_method } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    let invoice = null;
    if (invoice_id) {
      [invoice] = await query('SELECT * FROM invoices WHERE id = ? AND workshop_id = ?', [invoice_id, req.workshopId]);
    } else if (work_order_id) {
      [invoice] = await query('SELECT * FROM invoices WHERE work_order_id = ? AND workshop_id = ?', [work_order_id, req.workshopId]);
    }

    const refundAmount = invoice ? Math.min(parseFloat(amount), parseFloat(invoice.total_amount)) : parseFloat(amount);

    const result = await execute(
      `INSERT INTO refunds (workshop_id, work_order_id, invoice_id, amount, reason, refund_method, status, requested_by, created_at)
       VALUES (?,?,?,?,?,?,?,?, NOW())`,
      [req.workshopId, work_order_id || invoice?.work_order_id || null, invoice?.id || null,
       refundAmount, reason || '', refund_method || 'original', 'pending', req.user?.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'refund.created', entityType: 'refund', entityId: result.insertId,
      newValue: { amount: refundAmount, work_order_id, reason } });

    return res.status(201).json({ success: true, data: { id: result.insertId, amount: refundAmount, status: 'pending' } });
  } catch (err) {
    console.error('Refund error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create refund' });
  }
});

// ═══════════════════════════════════════════════════════════════
// REFUND APPROVAL WORKFLOW
// ═══════════════════════════════════════════════════════════════

router.get('/refunds/list', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'r.workshop_id = ?';
    const params = [req.workshopId];
    if (status) { where += ' AND r.status = ?'; params.push(status); }

    const refunds = await query(
      `SELECT r.*, i.invoice_number, o.work_order_number, c.full_name as customer_name
       FROM refunds r
       LEFT JOIN invoices i ON r.invoice_id = i.id
       LEFT JOIN work_orders o ON r.work_order_id = o.id
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM refunds r WHERE ${where}`, params);

    return res.json({ success: true, data: refunds, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch refunds' });
  }
});

router.patch('/refunds/:id', async (req, res) => {
  try {
    const { action, notes } = req.body; // action: approve | reject
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ success: false, message: 'action must be approve or reject' });

    const [refund] = await query('SELECT * FROM refunds WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!refund) return res.status(404).json({ success: false, message: 'Refund not found' });
    if (refund.status !== 'pending') return res.status(400).json({ success: false, message: `Refund already ${refund.status}` });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await execute(
      'UPDATE refunds SET status = ?, approved_by = ?, approved_at = NOW(), notes = ? WHERE id = ?',
      [newStatus, req.user?.id, notes || null, refund.id]
    );

    // If approved and linked to invoice, create a credit note or adjust invoice
    if (action === 'approve' && refund.invoice_id) {
      const [inv] = await query('SELECT * FROM invoices WHERE id = ?', [refund.invoice_id]);
      if (inv) {
        const cnNumber = `CN-${inv.invoice_number}`;
        await execute(
          `INSERT INTO invoices (workshop_id, work_order_id, invoice_number, customer_id,
            subtotal, discount_amount, tax_rate, tax_amount, total_amount,
            currency, status, notes, created_by, invoice_type, original_invoice_id)
           VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?)`,
          [req.workshopId, inv.work_order_id, cnNumber, inv.customer_id,
           -refund.amount, 0, inv.tax_rate, -(refund.amount * (inv.tax_rate / 100) / (1 + inv.tax_rate / 100)),
           -refund.amount, inv.currency, 'paid', `Refund #${refund.id}: ${notes || refund.reason}`,
           req.user?.id, 'credit_note', inv.id]
        );
      }
    }

    // If approved, credit workshop wallet
    if (action === 'approve' && refund.work_order_id) {
      try {
        const [order] = await query('SELECT customer_id FROM work_orders WHERE id = ?', [refund.work_order_id]);
        if (order?.customer_id) {
          await execute('UPDATE wallets SET balance = balance - ? WHERE workshop_id = ?',
            [refund.amount, req.workshopId]);
        }
      } catch {}
    }

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: `refund.${action}d`, entityType: 'refund', entityId: refund.id,
      oldValue: { status: 'pending' }, newValue: { status: newStatus, amount: refund.amount } });

    return res.json({ success: true, message: `Refund ${newStatus}`, data: { id: refund.id, status: newStatus } });
  } catch (err) {
    console.error('Refund approval error:', err);
    return res.status(500).json({ success: false, message: 'Failed to process refund' });
  }
});

// ═══════════════════════════════════════════════════════════════
// CREDIT NOTES GENERATION
// ═══════════════════════════════════════════════════════════════

router.post('/:id/credit-note', async (req, res) => {
  try {
    const [original] = await query(
      'SELECT * FROM invoices WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!original) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (original.invoice_type === 'credit_note') {
      return res.status(400).json({ success: false, message: 'Cannot create credit note from another credit note' });
    }

    const { amount, reason } = req.body;
    const creditAmount = amount ? Math.min(parseFloat(amount), parseFloat(original.total_amount)) : parseFloat(original.total_amount);

    const invoiceNumber = `CN-${original.invoice_number}`;

    const result = await execute(
      `INSERT INTO invoices (workshop_id, work_order_id, invoice_number, customer_id,
        subtotal, discount_amount, tax_rate, tax_amount, total_amount,
        currency, status, payment_method, notes, created_by, invoice_type, original_invoice_id)
       VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?)`,
      [req.workshopId, original.work_order_id, invoiceNumber, original.customer_id,
       -creditAmount, 0, original.tax_rate, -(creditAmount * (original.tax_rate / 100) / (1 + original.tax_rate / 100)),
       -creditAmount, original.currency, 'paid', original.payment_method,
       reason || `Credit note for ${original.invoice_number}`, req.user?.id, 'credit_note', original.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'invoice.credit_note', entityType: 'invoice', entityId: result.insertId, oldValue: { original_invoice: original.invoice_number }, newValue: { credit_note: invoiceNumber, amount: -creditAmount } });

    const [creditNote] = await query('SELECT * FROM invoices WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: creditNote, message: `Credit note ${invoiceNumber} created` });
  } catch (err) {
    console.error('Credit note error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create credit note' });
  }
});

// ═══════════════════════════════════════════════════════════════
// INVOICE EMAIL DELIVERY
// ═══════════════════════════════════════════════════════════════

router.post('/:id/send-email', async (req, res) => {
  try {
    const [invoice] = await query(
      `SELECT i.*, c.email as customer_email, c.full_name as customer_name
       FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
       WHERE i.id = ? AND i.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const email = req.body.email || invoice.customer_email;
    if (!email) return res.status(400).json({ success: false, message: 'No email address available' });

    // Try to use the email service
    try {
      const { sendEmail: send, getWorkshopBranding } = await import('../lib/email.js');
      const branding = await getWorkshopBranding(req.workshopId);
      await send({
        to: email,
        subject: `Invoice ${invoice.invoice_number} — ${branding?.name || 'Car Workshop'}`,
        html: `<h2>Invoice ${invoice.invoice_number}</h2>
               <p>Dear ${invoice.customer_name || 'Customer'},</p>
               <p>Please find your invoice details:</p>
               <table><tr><td>Subtotal:</td><td>${invoice.currency} ${invoice.subtotal}</td></tr>
               ${invoice.tax_amount > 0 ? `<tr><td>VAT (${invoice.tax_rate}%):</td><td>${invoice.currency} ${invoice.tax_amount}</td></tr>` : ''}
               <tr><td><strong>Total:</strong></td><td><strong>${invoice.currency} ${invoice.total_amount}</strong></td></tr></table>
               <p>Status: ${invoice.status}</p>
               <p>Thank you for your business.</p>`,
      }, req.workshopId);
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
      return res.status(500).json({ success: false, message: 'Email delivery failed — check SMTP settings' });
    }

    // Update invoice status to 'sent' if it was draft
    if (invoice.status === 'draft') {
      await execute('UPDATE invoices SET status = ? WHERE id = ?', ['sent', invoice.id]);
    }

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'invoice.email_sent', entityType: 'invoice', entityId: invoice.id, newValue: { email } });

    return res.json({ success: true, message: `Invoice emailed to ${email}` });
  } catch (err) {
    console.error('Invoice email error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send invoice email' });
  }
});

// ═══════════════════════════════════════════════════════════════
// INVOICE AGING REPORT
// ═══════════════════════════════════════════════════════════════

router.get('/aging/report', async (req, res) => {
  try {
    // Auto-flag overdue invoices
    await execute(
      `UPDATE invoices SET status = 'overdue'
       WHERE workshop_id = ? AND status IN ('draft','sent')
       AND due_date IS NOT NULL AND due_date < CURDATE()`,
      [req.workshopId]
    );

    const aging = await query(
      `SELECT
         SUM(CASE WHEN due_date IS NULL OR due_date >= CURDATE() THEN total_amount ELSE 0 END) as current_amount,
         SUM(CASE WHEN due_date < CURDATE() AND due_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN total_amount ELSE 0 END) as days_30,
         SUM(CASE WHEN due_date < DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND due_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY) THEN total_amount ELSE 0 END) as days_60,
         SUM(CASE WHEN due_date < DATE_SUB(CURDATE(), INTERVAL 60 DAY) AND due_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) THEN total_amount ELSE 0 END) as days_90,
         SUM(CASE WHEN due_date < DATE_SUB(CURDATE(), INTERVAL 90 DAY) THEN total_amount ELSE 0 END) as over_90,
         COUNT(CASE WHEN status = 'overdue' THEN 1 END) as overdue_count,
         COALESCE(SUM(CASE WHEN status = 'overdue' THEN total_amount ELSE 0 END), 0) as overdue_total
       FROM invoices WHERE workshop_id = ? AND status NOT IN ('paid','void','cancelled')`,
      [req.workshopId]
    );

    const overdueInvoices = await query(
      `SELECT i.*, c.full_name as customer_name, DATEDIFF(CURDATE(), i.due_date) as days_overdue
       FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
       WHERE i.workshop_id = ? AND i.status = 'overdue'
       ORDER BY i.due_date ASC LIMIT 50`,
      [req.workshopId]
    );

    return res.json({ success: true, data: { buckets: aging[0] || {}, overdue_invoices: overdueInvoices } });
  } catch (err) {
    console.error('Invoice aging error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate aging report' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT INVOICE (auto-generate from settlement)
// ═══════════════════════════════════════════════════════════════

router.post('/from-settlement', async (req, res) => {
  try {
    const { settlement_id, period_start, period_end, order_count, gross_amount, commission, net_paid, reference } = req.body;
    if (!gross_amount) return res.status(400).json({ success: false, message: 'gross_amount required' });

    const invoiceNumber = await getNextInvoiceNumber(req.workshopId);
    const [workshop] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);

    const result = await execute(
      `INSERT INTO invoices (workshop_id, invoice_number, subtotal, discount_amount, tax_rate, tax_amount, total_amount,
        currency, status, notes, created_by, invoice_type)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?,?)`,
      [req.workshopId, invoiceNumber, gross_amount, commission || 0, 0, 0, net_paid || gross_amount,
       workshop?.currency || 'AED', 'paid', `Settlement invoice. Period: ${period_start || '?'} — ${period_end || '?'}. Work orders: ${order_count || 0}. Ref: ${reference || ''}`,
       req.user?.id, 'invoice']
    );

    // Add line items
    await execute(
      'INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, total) VALUES (?,?,?,?,?,?)',
      [result.insertId, 'service', `Workshop services (${order_count || 0} work orders)`, order_count || 1, gross_amount, gross_amount]
    );
    if (commission > 0) {
      await execute(
        'INSERT INTO invoice_items (invoice_id, item_type, description, quantity, unit_price, total, discount) VALUES (?,?,?,?,?,?,?)',
        [result.insertId, 'discount', 'Platform commission', 1, 0, -commission, commission]
      );
    }

    return res.status(201).json({ success: true, data: { id: result.insertId, invoice_number: invoiceNumber }, message: `Settlement invoice ${invoiceNumber} created` });
  } catch (err) {
    console.error('Settlement invoice error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create settlement invoice' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT-TO-INVOICE RECONCILIATION
// ═══════════════════════════════════════════════════════════════

router.post('/:id/record-payment', async (req, res) => {
  try {
    const { amount, payment_method, reference, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    const [invoice] = await query('SELECT * FROM invoices WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const newPaid = parseFloat(invoice.amount_paid || 0) + parseFloat(amount);
    const totalDue = parseFloat(invoice.total_amount);
    const newStatus = newPaid >= totalDue ? 'paid' : 'partially_paid';

    await execute(
      'UPDATE invoices SET amount_paid = ?, status = ?, payment_method = ?, paid_at = ? WHERE id = ?',
      [newPaid, newStatus, payment_method || invoice.payment_method, newStatus === 'paid' ? new Date() : null, invoice.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'invoice.payment_recorded', entityType: 'invoice', entityId: invoice.id,
      newValue: { amount, payment_method, reference, new_total_paid: newPaid, status: newStatus } });

    return res.json({ success: true, message: `Payment of ${amount} recorded. Invoice ${newStatus}.`, data: { amount_paid: newPaid, status: newStatus } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to record payment' });
  }
});

export default router;
export { publicRouter as invoicePublicRouter };
