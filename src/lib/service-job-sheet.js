/**
 * ═══════════════════════════════════════════════════════════════
 * MODULE B — Work Order Job Sheet / Service Ticket PDF Generator  (v4 – Simple)
 * ═══════════════════════════════════════════════════════════════
 *
 * Repurposed from the delivery-service "shipping label" PDF generator.
 * Same pdfkit/qrcode/bwip-js/arabic-reshaper layout engine and Arabic RTL
 * handling, but the printed fields now describe a work order / vehicle /
 * customer instead of a shipment / package / recipient:
 *   - tracking_number / barcode  -> work_order_number / barcode of work order
 *   - recipient (name/phone/address) -> customer (name/phone/address)
 *   - sender (workshop drop-off contact) -> workshop info (kept from tenant/workshop)
 *   - package weight/dimensions -> vehicle make/model/plate
 *   - COD badge -> cash payment badge
 *   - tracking_token / /track/:token -> service_status_token / service status link
 *
 * Clean, minimal A6 job-sheet layout inspired by simple invoice layouts.
 * Flat sections, no heavy fills or oversized text. Thin lines, small type.
 */

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import bwipjs from 'bwip-js';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import arabicReshaper from 'arabic-reshaper';
const { convertArabic } = arabicReshaper;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Arabic font support ───────────────────────────────────────
const AMIRI_REGULAR = path.join(__dirname, '../../assets/fonts/Amiri-Regular.ttf');
const AMIRI_BOLD = path.join(__dirname, '../../assets/fonts/Amiri-Bold.ttf');

/**
 * Pioneer brand mark, used when a workshop has not uploaded its own logo.
 *
 * Without this the sheet printed the workshop name as bare text and carried no
 * branding at all. The file is cropped to the mark itself with a small even
 * margin, so `fit` produces a predictable size — the original had 21% white
 * padding top and bottom, which made any height you asked for come out a
 * third smaller than expected.
 *
 * It is the light variant (dark mark on white): the sheet prints on white
 * paper. The white-on-navy variant would lay a navy block across the header.
 *
 * Resolved from __dirname rather than the process cwd, because loadLogo()
 * resolves relative paths against wherever node happened to be started.
 */
const PIONEER_LOGO = path.join(__dirname, '../../assets/brand/pioneer-logo.png');

/** Aspect ratio of the bundled mark, so the header can reserve the right width. */
const PIONEER_LOGO_ASPECT = 518 / 300;

function hasArabic(str) {
  if (!str) return false;
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(str);
}

// Reshape Arabic text so glyphs connect properly in PDF
function ar(str) {
  if (!str || typeof str !== 'string') return str || '';
  return hasArabic(str) ? convertArabic(str) : str;
}

// ── helpers ────────────────────────────────────────────────────
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

async function loadLogo(logoUrl) {
  if (!logoUrl) return null;
  try {
    if (logoUrl.startsWith('http')) {
      const buf = await fetchImageBuffer(logoUrl);
      return buf && buf.length > 100 ? buf : null;
    }
    const localPath = path.resolve(logoUrl.replace(/^\//, ''));
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);
  } catch (e) { console.error('[JobSheet] Logo load failed:', e.message); }
  return null;
}

async function generateBarcodePNG(text) {
  try {
    return await bwipjs.toBuffer({
      bcid: 'code128', text, scale: 2, height: 8,
      includetext: true, textxalign: 'center', textsize: 7,
      paddingwidth: 0, paddingheight: 1,
    });
  } catch (err) { console.error('[JobSheet] Barcode error:', err.message); return null; }
}

async function generateQRPNG(data, size = 150) {
  try {
    const dataUrl = await QRCode.toDataURL(data, {
      width: size, margin: 0,
      color: { dark: '#1e293b', light: '#ffffff' },
    });
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } catch (err) { console.error('[JobSheet] QR error:', err.message); return null; }
}

// ── Default template ───────────────────────────────────────────
const DEFAULT_TEMPLATE = {
  label_size: 'A6',
  show_logo: true,
  show_barcode: true,
  show_qr: true,
  show_sender: true,
  show_recipient: true,
  show_order_info: true,
  show_cod_badge: true,
  show_instructions: true,
  show_awb: true,
  cod_badge_color: '#dc2626',
  accent_color: '#111827',
  logo_position: 'left',
};

function mergeTemplate(t) { return t ? { ...DEFAULT_TEMPLATE, ...t } : { ...DEFAULT_TEMPLATE }; }

function getLabelSize(k) {
  return ({ 'A6': [297.64, 419.53], 'A5': [419.53, 595.28], '4x6': [288, 432] })[k] || [297.64, 419.53];
}

// ═══════════════════════════════════════════════════════════════
// MAIN — Simple / Invoice-style layout
// ═══════════════════════════════════════════════════════════════
export async function generateServiceJobSheetPDF(res, { orders, tenant, template: templateOverride }) {
  const template = mergeTemplate(templateOverride);
  const [W, H]   = getLabelSize(template.label_size);
  const M         = 14;            // outer margin
  const CW        = W - 2 * M;     // content width
  const RIGHT     = W - M;
  const pageCount = orders.length;

  const doc = new PDFDocument({ margin: 0, size: [W, H] });
  res.setHeader('Content-Type', 'application/pdf');
  const filename = pageCount === 1
    ? `job-sheet-${orders[0].work_order_number || orders[0].id}.pdf`
    : `job-sheets-batch-${pageCount}.pdf`;
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  // Register Arabic-capable fonts (Amiri supports Arabic + Latin)
  if (fs.existsSync(AMIRI_REGULAR)) doc.registerFont('Amiri', AMIRI_REGULAR);
  if (fs.existsSync(AMIRI_BOLD)) doc.registerFont('Amiri-Bold', AMIRI_BOLD);

  // Pre-load the logo: the workshop's own first, then the bundled Pioneer
  // mark, so a sheet is never unbranded.
  let logoBuffer = null;
  let logoAspect = null;
  if (template.show_logo) {
    logoBuffer = await loadLogo(tenant?.logo_url);
    if (!logoBuffer && tenant?.logo_url_white) {
      logoBuffer = await loadLogo(tenant.logo_url_white);
    }
    if (!logoBuffer) {
      try {
        if (fs.existsSync(PIONEER_LOGO)) {
          logoBuffer = fs.readFileSync(PIONEER_LOGO);
          logoAspect = PIONEER_LOGO_ASPECT;
        }
      } catch (e) {
        // A missing brand asset must not stop a job sheet printing.
        console.error('[JobSheet] Pioneer logo load failed:', e.message);
      }
    }
  }

  // ── Palette — monochrome / minimal ────────────────────────
  const INK       = '#111827';
  const GRAY      = '#6b7280';
  const LIGHT     = '#9ca3af';
  const LINE      = '#d1d5db';
  const WHITE     = '#ffffff';
  const CASH_COLOR = template.cod_badge_color || '#dc2626';

  const baseUrl     = process.env.BACKEND_URL || process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? 'https://delivery.pioneercarservice.com' : `http://localhost:${process.env.PORT || 4001}`);
  const frontendUrl = process.env.FRONTEND_URL || baseUrl.replace(':4001', ':5173');

  // ── Helpers ─────────────────────────────────────────────────
  const hline = (y) => { doc.moveTo(M, y).lineTo(RIGHT, y).strokeColor(LINE).lineWidth(0.5).stroke(); };

  for (let idx = 0; idx < orders.length; idx++) {
    const order = orders[idx];
    if (idx > 0) doc.addPage({ margin: 0, size: [W, H] });

    doc.rect(0, 0, W, H).fill(WHITE);

    // Detect Arabic text → use Amiri font instead of Helvetica
    const _txt = [order.sender_name, order.sender_address, order.customer_name,
      order.customer_address, order.customer_area, order.customer_emirate,
      order.service_bay_name, order.special_instructions, tenant?.name].filter(Boolean).join('');
    const FR = hasArabic(_txt) ? 'Amiri' : 'Helvetica';
    const FB = hasArabic(_txt) ? 'Amiri-Bold' : 'Helvetica-Bold';

    let y = M;

    // ─────────────────────────────────────────────────────────
    // 1. HEADER — logo left, work order number right
    // ─────────────────────────────────────────────────────────
    let headerTextX = M;
    if (logoBuffer) {
      // `fit` rather than a bare height: an uploaded workshop logo can be any
      // shape, and a tall narrow one asked for by height alone would run into
      // the work order number on the right.
      const LOGO_H = 16;
      const LOGO_MAX_W = 42;
      try {
        doc.image(logoBuffer, M, y, { fit: [LOGO_MAX_W, LOGO_H], align: 'left', valign: 'top' });
      } catch (_) {}
      const drawnW = logoAspect
        ? Math.min(LOGO_MAX_W, LOGO_H * logoAspect)
        : LOGO_MAX_W;
      headerTextX = M + drawnW + 6;
    }
    doc.fillColor(INK).fontSize(7).font(FB)
       .text(ar(tenant?.name || 'Pioneer'), headerTextX, y + 5, {
         width: RIGHT - 84 - headerTextX,
         lineBreak: false,
         ellipsis: true,
       });

    // Work order number + date on right
    const createdDate = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    doc.fillColor(INK).fontSize(5.5).font(FB)
       .text(order.work_order_number || '', RIGHT - 80, y, { width: 80, align: 'right' });
    if (createdDate) {
      doc.fillColor(GRAY).fontSize(5).font(FR)
         .text(createdDate, RIGHT - 80, y + 8, { width: 80, align: 'right' });
    }

    y += 20;
    hline(y);
    y += 6;

    // ─────────────────────────────────────────────────────────
    // 2. BARCODE — centered, compact (encodes work order number)
    // ─────────────────────────────────────────────────────────
    const barcodeValue = order._package_barcode || order.service_status_token || order.work_order_number;
    if (template.show_barcode && barcodeValue) {
      const barcodePng = await generateBarcodePNG(barcodeValue);
      if (barcodePng) {
        const bW = CW * 0.65;
        const bX = M + (CW - bW) / 2;
        try { doc.image(barcodePng, bX, y, { width: bW, height: 26 }); } catch (_) {}
      }
      y += 30;
      hline(y);
      y += 5;
    }

    // ─────────────────────────────────────────────────────────
    // 3. WORK ORDER META — single row: type badge + ref + part count
    // ─────────────────────────────────────────────────────────
    const metaParts = [];
    if (order.order_type) metaParts.push((order.order_type || '').replace(/_/g, ' ').toUpperCase());
    if (template.show_awb && order.awb_number) metaParts.push(order.awb_number);
    if (order._package_sequence && order._total_packages) {
      metaParts.push(`PART ${order._package_sequence}/${order._total_packages}`);
    }
    if (metaParts.length > 0) {
      doc.fillColor(GRAY).fontSize(5).font(FR)
         .text(metaParts.join('   ·   '), M, y, { width: CW, align: 'left' });
      y += 10;
    }

    // ─────────────────────────────────────────────────────────
    // 4. WORKSHOP INFO — simple two-line (was: FROM / sender)
    // ─────────────────────────────────────────────────────────
    if (template.show_sender) {
      doc.fillColor(GRAY).fontSize(5).font(FB)
         .text('WORKSHOP', M, y);
      y += 8;
      const senderName = order.sender_name || tenant?.name || '—';
      const senderPhone = order.sender_phone ? `  ·  ${order.sender_phone}` : '';
      doc.fillColor(INK).fontSize(6).font(FB)
         .text(ar(senderName) + senderPhone, M, y, { width: CW });
      y += 8;
      if (order.sender_address) {
        doc.fillColor(GRAY).fontSize(5.5).font(FR)
           .text(ar(order.sender_address), M, y, { width: CW });
        y += 8;
      }
      y += 2;
      hline(y);
      y += 5;
    }

    // ─────────────────────────────────────────────────────────
    // 5. CUSTOMER — clean section, no heavy box (was: TO / recipient)
    // ─────────────────────────────────────────────────────────
    if (template.show_recipient) {
      doc.fillColor(GRAY).fontSize(5).font(FB)
         .text('CUSTOMER', M, y);
      y += 8;

      // Customer name
      const customerName = order.customer_name || '—';
      const customerNameShaped = ar(customerName);
      doc.fillColor(INK).fontSize(8.5).font(FB)
         .text(customerNameShaped, M, y, { width: CW });
      y += doc.heightOfString(customerNameShaped, { width: CW, fontSize: 8.5 }) + 2;

      // Phone
      if (order.customer_phone) {
        doc.fillColor(INK).fontSize(7).font(FR)
           .text(order.customer_phone, M, y, { width: CW });
        y += 10;
      }

      // Address
      if (order.customer_address) {
        const addrShaped = ar(order.customer_address);
        doc.fillColor(GRAY).fontSize(6).font(FR)
           .text(addrShaped, M, y, { width: CW, lineGap: 1 });
        y += doc.heightOfString(addrShaped, { width: CW, fontSize: 6 }) + 2;
      }

      // Area / Emirate
      const areaEmirate = [order.customer_area, order.customer_emirate].filter(Boolean).join(', ');
      if (areaEmirate) {
        doc.fillColor(INK).fontSize(6).font(FB)
           .text(ar(areaEmirate), M, y, { width: CW });
        y += 8;
      }

      // Service bay
      if (order.service_bay_name) {
        doc.fillColor(LIGHT).fontSize(5).font(FR)
           .text(`Bay: ${ar(order.service_bay_name)}`, M, y, { width: CW });
        y += 8;
      }

      y += 2;
      hline(y);
      y += 5;
    }

    // ─────────────────────────────────────────────────────────
    // 6. VEHICLE DETAILS — make/model/plate inline text
    //    (was: package weight/dimensions/item count)
    // ─────────────────────────────────────────────────────────
    if (template.show_order_info) {
      const details = [];
      if (order.vehicle_make || order.vehicle_model) {
        details.push([order.vehicle_make, order.vehicle_model].filter(Boolean).join(' '));
      }
      if (order.vehicle_plate) details.push(`Plate: ${order.vehicle_plate}`);
      if (order.vehicle_year) details.push(String(order.vehicle_year));
      if (details.length > 0) {
        doc.fillColor(GRAY).fontSize(5.5).font(FR)
           .text(details.join('   ·   '), M, y, { width: CW });
        y += 10;
      }
    }

    // ─────────────────────────────────────────────────────────
    // 7. CASH PAYMENT — simple line (was: COD / PAYMENT)
    // ─────────────────────────────────────────────────────────
    if (template.show_cod_badge && order.payment_method === 'cash' && parseFloat(order.cash_amount) > 0) {
      const cashAmount = `${order.currency || 'AED'} ${parseFloat(order.cash_amount).toFixed(2)}`;

      doc.fillColor(GRAY).fontSize(5).font(FR)
         .text('PAY AT PICKUP', M, y);
      y += 7;

      doc.fillColor(CASH_COLOR).fontSize(9).font(FB)
         .text(`CASH  ${cashAmount}`, M, y, { width: CW });
      y += 13;
      hline(y);
      y += 6;
    } else if (order.payment_method && order.payment_method !== 'cash') {
      const pmText = (order.payment_method || '').toUpperCase();
      doc.fillColor(INK).fontSize(5.5).font(FB)
         .text(`PREPAID — ${pmText}`, M, y, { width: CW });
      y += 10;
      hline(y);
      y += 6;
    }

    // ─────────────────────────────────────────────────────────
    // 8. SPECIAL INSTRUCTIONS — plain text
    // ─────────────────────────────────────────────────────────
    if (template.show_instructions && order.special_instructions) {
      const instrText = order.special_instructions.length > 140
        ? order.special_instructions.substring(0, 137) + '...'
        : order.special_instructions;
      doc.fillColor(GRAY).fontSize(5).font(FB)
         .text('NOTE:', M, y, { continued: true })
         .font(FR)
         .text(` ${ar(instrText)}`, { width: CW });
      y += 10;
    }

    // ─────────────────────────────────────────────────────────
    // 9. QR CODE — bottom-right, small (links to service status page)
    // ─────────────────────────────────────────────────────────
    if (template.show_qr && order.service_status_token) {
      const qrSize = 30;
      const qrX = RIGHT - qrSize;
      const qrY = H - M - qrSize - 12;

      const trackUrl = `${frontendUrl}/track/${order.service_status_token}`;
      const qrPng = await generateQRPNG(trackUrl, 200);
      if (qrPng) {
        try { doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize }); } catch (_) {}
      }
      doc.fillColor(LIGHT).fontSize(4).font(FR)
         .text('STATUS', qrX, qrY + qrSize + 1, { width: qrSize, align: 'center' });
    }

    // ─────────────────────────────────────────────────────────
    // 10. FOOTER — minimal line
    // ─────────────────────────────────────────────────────────
    const footerY = H - M - 8;
    hline(footerY);
    const ftY = footerY + 3;

    doc.fillColor(GRAY).fontSize(4.5).font(FR)
       .text(order.work_order_number || '', M, ftY);

    const footerDate = order.created_at
      ? new Date(order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';
    doc.fillColor(GRAY).fontSize(4.5).font(FR)
       .text(footerDate, W / 2 - 25, ftY, { width: 50, align: 'center' });

    if (pageCount > 1) {
      doc.fillColor(INK).fontSize(5).font(FB)
         .text(`${idx + 1} / ${pageCount}`, RIGHT - 30, ftY, { width: 30, align: 'right' });
    }

    // ─────────────────────────────────────────────────────────
    // 11. INSPECTION SHEET — extra A4 page with the 5 car-diagram views
    //     and any damage markers recorded during intake / joint inspection.
    //     Only added when the work order actually has an inspection with marks.
    // ─────────────────────────────────────────────────────────
    if (order._inspection && Array.isArray(order._inspection.marks) && order._inspection.marks.length > 0) {
      renderInspectionPage(doc, order, tenant);
    }
  }

  doc.end();
}

// ═══════════════════════════════════════════════════════════════
// INSPECTION SHEET — dedicated A4 page: header + 5 car diagrams with
// damage markers overlaid, plus a legend of the codes used.
// ═══════════════════════════════════════════════════════════════
const INSPECTION_DIR = path.join(__dirname, '../../assets/inspection');
const INSPECTION_VIEWS = [
  { key: 'top',   label: 'TOP / ROOF',        file: 'top-roof.png' },
  { key: 'left',  label: 'DRIVER SIDE',       file: 'driver-side.png' },
  { key: 'right', label: 'PASSENGER SIDE',    file: 'passenger-side.png' },
  { key: 'front', label: 'FRONT',             file: 'front.png' },
  { key: 'rear',  label: 'REAR',              file: 'rear.png' },
];
const DAMAGE_LEGEND = {
  SH: 'Shattered', WS: 'Windshield', OX: 'Oxidized',   CF: 'Cracked/Faded',
  DS: 'Deep Scratch', BD: 'Bent',    RP: 'Repainted',  UD: 'Unpainted Damage',
  PT: 'Paint Transfer', PC: 'Paint Chip', GS: 'Glass Scratch', GC: 'Glass Crack',
  DD: 'Dents/Dings', SS: 'Surface Scratch', CR: 'Crack', WD: 'Water Damage',
  GO: 'Gouge', LM: 'Loose Molding',
};
const DAMAGE_COLORS = {
  SH: '#6757e8', WS: '#4f87f7', OX: '#17b890', CF: '#ff8a4c',
  DS: '#ef476f', BD: '#8f62d6', RP: '#26b9d5', UD: '#f3b63f',
  PT: '#6d92ea', PC: '#9e62dc', GS: '#67bd52', GC: '#7bcf86',
  DD: '#ff825c', SS: '#6678e8', CR: '#f45f7c', WD: '#4d91e8',
  GO: '#b77947', LM: '#94a3b8',
};

function renderInspectionPage(doc, order, tenant) {
  // A4 portrait so a workshop can print it on standard paper.
  const A4W = 595.28, A4H = 841.89;
  const M = 32;
  doc.addPage({ margin: 0, size: [A4W, A4H] });
  doc.rect(0, 0, A4W, A4H).fill('#ffffff');

  const _txt = [order.customer_name, order.vehicle_make, order.vehicle_model, tenant?.name].filter(Boolean).join('');
  const FR = hasArabic(_txt) ? 'Amiri' : 'Helvetica';
  const FB = hasArabic(_txt) ? 'Amiri-Bold' : 'Helvetica-Bold';

  const insp = order._inspection || {};
  const marks = Array.isArray(insp.marks) ? insp.marks : [];
  const inspTypeLabel = insp.inspection_type === 'joint' ? 'Joint Inspection'
                      : insp.inspection_type === 'qc' ? 'QC Inspection'
                      : 'Intake Inspection';

  let y = M;

  doc.fillColor('#111827').fontSize(14).font(FB)
     .text('Vehicle Inspection Sheet', M, y);
  doc.fillColor('#6b7280').fontSize(9).font(FR)
     .text(`${inspTypeLabel}   ·   ${order.work_order_number || ''}`, M, y + 18);
  const headerDate = (insp.completed_at || order.created_at)
    ? new Date(insp.completed_at || order.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '';
  doc.fillColor('#6b7280').fontSize(9).font(FR)
     .text(headerDate, A4W - M - 120, y + 4, { width: 120, align: 'right' });
  y += 40;
  doc.moveTo(M, y).lineTo(A4W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
  y += 12;

  const infoCol = (label, val, x, w) => {
    doc.fillColor('#6b7280').fontSize(7).font(FB).text(label, x, y, { width: w });
    doc.fillColor('#111827').fontSize(9.5).font(FB).text(ar(val || '—'), x, y + 10, { width: w, ellipsis: true, lineBreak: false });
  };
  const infoW = (A4W - 2 * M) / 4;
  infoCol('CUSTOMER',  insp.customer_name || order.customer_name || order.customer_full_name, M, infoW);
  infoCol('VEHICLE',   [insp.vehicle_make || order.vehicle_make, insp.vehicle_model || order.vehicle_model, insp.vehicle_year || order.vehicle_year].filter(Boolean).join(' '), M + infoW, infoW);
  infoCol('PLATE',     insp.plate_number || order.vehicle_plate, M + infoW * 2, infoW);
  infoCol('ODOMETER',  insp.odometer ? `${Number(insp.odometer).toLocaleString()} km` : '', M + infoW * 3, infoW);
  y += 30;

  // 5 views in a 3-column x 2-row grid.
  const cols = 3, gap = 10;
  const cellW = (A4W - 2 * M - (cols - 1) * gap) / cols;
  const cellH = cellW * 0.75;
  for (let i = 0; i < INSPECTION_VIEWS.length; i++) {
    const view = INSPECTION_VIEWS[i];
    const r = Math.floor(i / cols), c = i % cols;
    const x = M + c * (cellW + gap);
    const cy = y + r * (cellH + 32);
    doc.rect(x, cy, cellW, cellH).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
    const imgPath = path.join(INSPECTION_DIR, view.file);
    if (fs.existsSync(imgPath)) {
      try {
        // fit inside cell with a 4pt inner margin
        doc.image(imgPath, x + 4, cy + 4, { fit: [cellW - 8, cellH - 8], align: 'center', valign: 'center' });
      } catch (_) {}
    }
    // Overlay marks for this view
    const viewMarks = marks.filter(m => m.view === view.key);
    for (const m of viewMarks) {
      if (typeof m.x !== 'number' || typeof m.y !== 'number') continue;
      const mx = x + 4 + (cellW - 8) * m.x;
      const my = cy + 4 + (cellH - 8) * m.y;
      const color = DAMAGE_COLORS[m.code] || '#dc2626';
      doc.circle(mx, my, 5).fill(color);
      doc.fillColor('#ffffff').fontSize(6).font(FB)
         .text(m.code || '?', mx - 6, my - 3, { width: 12, align: 'center', lineBreak: false });
    }
    doc.fillColor('#6b7280').fontSize(7).font(FB)
       .text(view.label, x, cy + cellH + 4, { width: cellW, align: 'center' });
    doc.fillColor('#9ca3af').fontSize(6.5).font(FR)
       .text(`${viewMarks.length} mark${viewMarks.length === 1 ? '' : 's'}`, x, cy + cellH + 15, { width: cellW, align: 'center' });
  }
  y += Math.ceil(INSPECTION_VIEWS.length / cols) * (cellH + 32) + 8;

  // Legend of codes actually used, so the printed page is self-contained.
  const usedCodes = [...new Set(marks.map(m => m.code).filter(Boolean))];
  if (usedCodes.length > 0) {
    doc.moveTo(M, y).lineTo(A4W - M, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();
    y += 8;
    doc.fillColor('#6b7280').fontSize(8).font(FB).text('LEGEND', M, y);
    y += 12;
    const chipW = (A4W - 2 * M) / 4;
    usedCodes.forEach((code, i) => {
      const cx = M + (i % 4) * chipW;
      const cy = y + Math.floor(i / 4) * 18;
      doc.circle(cx + 6, cy + 5, 4).fill(DAMAGE_COLORS[code] || '#dc2626');
      doc.fillColor('#111827').fontSize(8.5).font(FB).text(code, cx + 14, cy + 1, { width: 22, lineBreak: false });
      doc.fillColor('#4b5563').fontSize(8).font(FR).text(DAMAGE_LEGEND[code] || code, cx + 36, cy + 1, { width: chipW - 40, lineBreak: false });
    });
    y += Math.ceil(usedCodes.length / 4) * 18 + 4;
  }

  // Notes + signature line at the bottom of the page.
  if (insp.notes) {
    y += 8;
    doc.fillColor('#6b7280').fontSize(8).font(FB).text('NOTES', M, y);
    y += 10;
    doc.fillColor('#111827').fontSize(9).font(FR).text(ar(insp.notes), M, y, { width: A4W - 2 * M });
  }
  const sigY = A4H - 60;
  doc.moveTo(M, sigY).lineTo(M + 200, sigY).strokeColor('#111827').lineWidth(0.6).stroke();
  doc.fillColor('#6b7280').fontSize(7).font(FR).text('Customer signature', M, sigY + 4);
  doc.moveTo(A4W - M - 200, sigY).lineTo(A4W - M, sigY).strokeColor('#111827').lineWidth(0.6).stroke();
  doc.fillColor('#6b7280').fontSize(7).font(FR).text('Inspector signature', A4W - M - 200, sigY + 4);
}
