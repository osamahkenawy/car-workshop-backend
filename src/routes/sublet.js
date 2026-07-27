/**
 * ═══════════════════════════════════════════════════════════════
 *  Sublet Management — SOW Section B8, req 93
 *  External supplier work on a job card:
 *  - Separate own-work vs sublet lines on estimate & work order
 *  - Links supplier AP invoice to the job
 *
 *  Also covers:
 *  Proforma Invoices (B9 req 94): proforma → payment → invoice → gate pass
 *  Gate Passes (B9 req 94): vehicle release after payment & QC
 *  UAE VAT (B9 req 95): 5% VAT, vat_transactions recording
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

const genNumber = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random()*999)}`;

// ══════════════════════════════════════════════════════════════
// SUBLET ORDERS
// ══════════════════════════════════════════════════════════════

// GET /api/sublet
router.get('/', async (req, res) => {
  try {
    const { status, job_card_id, search } = req.query;
    let sql = `
      SELECT s.*, jc.job_card_number, wo.work_order_number
      FROM sublet_orders s
      LEFT JOIN job_cards jc ON s.job_card_id = jc.id
      LEFT JOIN work_orders wo ON s.work_order_id = wo.id
      WHERE s.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status)      { sql += ' AND s.status = ?'; params.push(status); }
    if (job_card_id) { sql += ' AND s.job_card_id = ?'; params.push(job_card_id); }
    if (search) {
      sql += ' AND (s.supplier_name LIKE ? OR s.sublet_number LIKE ? OR jc.job_card_number LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY s.created_at DESC';
    const rows = await query(sql, params);
    res.json({ success: true, subletOrders: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch sublet orders' });
  }
});

// GET /api/sublet/:id
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT s.*, jc.job_card_number, wo.work_order_number
       FROM sublet_orders s
       LEFT JOIN job_cards jc ON s.job_card_id = jc.id
       LEFT JOIN work_orders wo ON s.work_order_id = wo.id
       WHERE s.id = ? AND s.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Sublet order not found' });
    res.json({ success: true, subletOrder: row });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch sublet order' });
  }
});

// POST /api/sublet — create sublet order
router.post('/', async (req, res) => {
  try {
    const {
      job_card_id, work_order_id, supplier_name, supplier_contact,
      description, estimated_cost, payer_direction = 'customer', notes
    } = req.body;

    if (!job_card_id || !supplier_name || !description) {
      return res.status(400).json({ success: false, message: 'job_card_id, supplier_name, description required' });
    }

    const sublet_number = genNumber('SUB');
    const result = await execute(
      `INSERT INTO sublet_orders
         (workshop_id, sublet_number, job_card_id, work_order_id, supplier_name, supplier_contact,
          description, estimated_cost, payer_direction, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, sublet_number, job_card_id, work_order_id || null,
       supplier_name, supplier_contact || null, description,
       parseFloat(estimated_cost || 0), payer_direction, notes || null, req.userId]
    );

    // Post estimated sublet cost to WIP
    if (estimated_cost) {
      await execute(
        `INSERT INTO wip_ledger (workshop_id, job_card_id, work_order_id, entry_type, amount, description, posted_by)
         VALUES (?, ?, ?, 'sublet_charge', ?, ?, ?)`,
        [req.workshopId, job_card_id, work_order_id || null,
         parseFloat(estimated_cost), `Sublet: ${supplier_name} - ${description}`, req.userId]
      );
    }

    await logAudit(req.workshopId, req.userId, 'CREATE', 'sublet_orders', result.insertId, null, { sublet_number, supplier_name });
    res.status(201).json({ success: true, id: result.insertId, sublet_number });
  } catch (err) {
    console.error('POST /sublet error:', err);
    res.status(500).json({ success: false, message: 'Failed to create sublet order' });
  }
});

// PATCH /api/sublet/:id/status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, actual_cost, supplier_invoice_no, supplier_invoice_date } = req.body;
    const VALID = ['pending','sent_to_supplier','in_progress','received','invoiced','paid','cancelled'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const [sub] = await query('SELECT * FROM sublet_orders WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!sub) return res.status(404).json({ success: false, message: 'Not found' });

    const extra = { sent_at: null, received_at: null };
    if (status === 'sent_to_supplier') extra.sent_at = new Date();
    if (status === 'received') extra.received_at = new Date();

    await execute(
      `UPDATE sublet_orders SET
         status = ?, actual_cost = COALESCE(?, actual_cost),
         supplier_invoice_no = COALESCE(?, supplier_invoice_no),
         supplier_invoice_date = COALESCE(?, supplier_invoice_date),
         sent_at = CASE WHEN ? = 'sent_to_supplier' THEN NOW() ELSE sent_at END,
         received_at = CASE WHEN ? = 'received' THEN NOW() ELSE received_at END
       WHERE id = ? AND workshop_id = ?`,
      [status, actual_cost || null, supplier_invoice_no || null, supplier_invoice_date || null,
       status, status, req.params.id, req.workshopId]
    );

    // Adjust WIP if actual cost differs from estimated
    if (actual_cost && status === 'invoiced') {
      const diff = parseFloat(actual_cost) - parseFloat(sub.estimated_cost || 0);
      if (Math.abs(diff) > 0.01) {
        await execute(
          `INSERT INTO wip_ledger (workshop_id, job_card_id, work_order_id, entry_type, amount, description, posted_by)
           VALUES (?, ?, ?, 'sublet_charge', ?, ?, ?)`,
          [req.workshopId, sub.job_card_id, sub.work_order_id, diff,
           `Sublet cost adjustment: ${sub.supplier_name}`, req.userId]
        );
      }
    }

    await logAudit(req.workshopId, req.userId, 'STATUS_CHANGE', 'sublet_orders', req.params.id, sub.status, { new_status: status });
    res.json({ success: true, message: `Sublet ${status}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update sublet status' });
  }
});

// ══════════════════════════════════════════════════════════════
// PROFORMA INVOICES (B9 req 94)
// ══════════════════════════════════════════════════════════════

const proformaRouter = express.Router();
proformaRouter.use(authMiddleware);

// GET /api/proforma
proformaRouter.get('/', async (req, res) => {
  try {
    const { status, job_card_id, search } = req.query;
    let sql = `
      SELECT p.*, jc.job_card_number, wo.work_order_number,
             c.name AS customer_full_name
      FROM proforma_invoices p
      LEFT JOIN job_cards jc ON p.job_card_id = jc.id
      LEFT JOIN work_orders wo ON p.work_order_id = wo.id
      LEFT JOIN customers c ON p.customer_id = c.id
      WHERE p.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status)      { sql += ' AND p.status = ?'; params.push(status); }
    if (job_card_id) { sql += ' AND p.job_card_id = ?'; params.push(job_card_id); }
    if (search) {
      sql += ' AND (p.proforma_number LIKE ? OR p.customer_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY p.created_at DESC';
    const rows = await query(sql, params);
    res.json({ success: true, proformas: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch proformas' });
  }
});

// POST /api/proforma — create proforma
proformaRouter.post('/', async (req, res) => {
  try {
    const {
      job_card_id, work_order_id, customer_id, customer_name, customer_type,
      subtotal, discount_amount = 0, vat_rate = 5,
      // multi-payer (req 95)
      customer_share, insurance_share, warranty_share, goodwill_share,
      insurance_company, insurance_claim_ref, insurance_approved_amount, excess_amount,
      valid_until, notes
    } = req.body;

    const vatRate   = parseFloat(vat_rate);
    const sub       = parseFloat(subtotal || 0);
    const disc      = parseFloat(discount_amount || 0);
    const taxable   = sub - disc;
    const vat_amt   = parseFloat((taxable * vatRate / 100).toFixed(2));
    const total     = parseFloat((taxable + vat_amt).toFixed(2));

    const proforma_number = genNumber('PF');
    const result = await execute(
      `INSERT INTO proforma_invoices
         (workshop_id, proforma_number, job_card_id, work_order_id, customer_id,
          customer_name, customer_type, subtotal, discount_amount, vat_rate, vat_amount, total_amount,
          customer_share, insurance_share, warranty_share, goodwill_share,
          insurance_company, insurance_claim_ref, insurance_approved_amount, excess_amount,
          valid_until, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, proforma_number, job_card_id || null, work_order_id || null,
       customer_id || null, customer_name || null, customer_type || 'retail_cash',
       sub, disc, vatRate, vat_amt, total,
       parseFloat(customer_share || total), parseFloat(insurance_share || 0),
       parseFloat(warranty_share || 0), parseFloat(goodwill_share || 0),
       insurance_company || null, insurance_claim_ref || null,
       parseFloat(insurance_approved_amount || 0), parseFloat(excess_amount || 0),
       valid_until || null, notes || null, req.userId]
    );

    // Record VAT transaction (UAE FTA, req 95)
    await execute(
      `INSERT INTO vat_transactions
         (workshop_id, reference_type, reference_id, reference_number,
          customer_name, supply_date, taxable_amount, vat_rate, vat_amount, total_amount)
       VALUES (?, 'proforma', ?, ?, ?, CURDATE(), ?, ?, ?, ?)`,
      [req.workshopId, result.insertId, proforma_number,
       customer_name || null, taxable, vatRate, vat_amt, total]
    );

    await logAudit(req.workshopId, req.userId, 'CREATE', 'proforma_invoices', result.insertId, null, { proforma_number, total });
    res.status(201).json({ success: true, id: result.insertId, proforma_number, total_amount: total });
  } catch (err) {
    console.error('POST /proforma error:', err);
    res.status(500).json({ success: false, message: 'Failed to create proforma' });
  }
});

// PATCH /api/proforma/:id/payment — record payment against proforma
proformaRouter.patch('/:id/payment', async (req, res) => {
  try {
    const { amount_paid, payment_method, payment_reference } = req.body;
    const [pf] = await query(
      'SELECT * FROM proforma_invoices WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!pf) return res.status(404).json({ success: false, message: 'Proforma not found' });

    const newPaid = parseFloat(pf.amount_paid || 0) + parseFloat(amount_paid || 0);
    const newStatus = newPaid >= parseFloat(pf.total_amount) ? 'paid' : 'partial';

    await execute(
      `UPDATE proforma_invoices SET
         amount_paid = ?, payment_method = ?, payment_reference = ?, payment_status = ?
       WHERE id = ? AND workshop_id = ?`,
      [newPaid, payment_method || null, payment_reference || null, newStatus, req.params.id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'PAYMENT', 'proforma_invoices', req.params.id, null, { amount_paid, newPaid });
    res.json({ success: true, message: 'Payment recorded', payment_status: newStatus, total_paid: newPaid });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to record payment' });
  }
});

// POST /api/proforma/:id/generate-payment-link — payment link (req 99)
proformaRouter.post('/:id/generate-payment-link', async (req, res) => {
  try {
    const [pf] = await query(
      'SELECT * FROM proforma_invoices WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!pf) return res.status(404).json({ success: false, message: 'Proforma not found' });

    // In production, integrate with payment gateway (Stripe, Telr, Network Int'l, etc.)
    // Here we generate a secure token-based link stub
    const token = Buffer.from(`pf-${pf.id}-${req.workshopId}-${Date.now()}`).toString('base64url');
    const paymentLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pay/${token}`;

    await execute(
      'UPDATE proforma_invoices SET payment_link_url = ? WHERE id = ?',
      [paymentLink, req.params.id]
    );

    res.json({ success: true, payment_link: paymentLink, expires_at: pf.valid_until });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate payment link' });
  }
});

// ══════════════════════════════════════════════════════════════
// GATE PASSES (B9 req 94 — vehicle release after payment + QC)
// ══════════════════════════════════════════════════════════════

const gatePassRouter = express.Router();
gatePassRouter.use(authMiddleware);

// GET /api/gate-pass
gatePassRouter.get('/', async (req, res) => {
  try {
    const { status, job_card_id } = req.query;
    let sql = `
      SELECT gp.*, jc.job_card_number, v.plate_number, v.make, v.model,
             c.name AS customer_full_name
      FROM gate_passes gp
      LEFT JOIN job_cards jc ON gp.job_card_id = jc.id
      LEFT JOIN vehicles v   ON gp.vehicle_id  = v.id
      LEFT JOIN customers c  ON gp.customer_id  = c.id
      WHERE gp.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status)      { sql += ' AND gp.status = ?'; params.push(status); }
    if (job_card_id) { sql += ' AND gp.job_card_id = ?'; params.push(job_card_id); }
    sql += ' ORDER BY gp.created_at DESC';
    const rows = await query(sql, params);
    res.json({ success: true, gatePasses: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch gate passes' });
  }
});

// POST /api/gate-pass — create gate pass (req 94)
gatePassRouter.post('/', async (req, res) => {
  try {
    const { job_card_id, work_order_id, invoice_id, proforma_id, customer_id,
            customer_name, vehicle_id, vehicle_plate, odometer_out, notes } = req.body;

    if (!job_card_id) return res.status(400).json({ success: false, message: 'job_card_id required' });

    // Verify payment confirmed
    let payment_confirmed = 0;
    if (proforma_id) {
      const [pf] = await query('SELECT payment_status FROM proforma_invoices WHERE id = ?', [proforma_id]);
      payment_confirmed = pf?.payment_status === 'paid' ? 1 : 0;
    } else if (invoice_id) {
      const [inv] = await query('SELECT payment_status FROM invoices WHERE id = ?', [invoice_id]);
      payment_confirmed = ['paid','partial'].includes(inv?.payment_status) ? 1 : 0;
    }

    // Verify QC passed
    const [jc] = await query('SELECT status FROM job_cards WHERE id = ? AND workshop_id = ?', [job_card_id, req.workshopId]);
    const qc_confirmed = ['qc_passed','ready_for_billing','billed'].includes(jc?.status) ? 1 : 0;

    const gate_pass_number = genNumber('GP');
    const result = await execute(
      `INSERT INTO gate_passes
         (workshop_id, gate_pass_number, job_card_id, work_order_id, invoice_id, proforma_id,
          customer_id, customer_name, vehicle_id, vehicle_plate, odometer_out,
          payment_confirmed, qc_confirmed, released_by, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,
               CASE WHEN ? = 1 AND ? = 1 THEN 'released' ELSE 'pending' END, ?)`,
      [req.workshopId, gate_pass_number, job_card_id, work_order_id || null,
       invoice_id || null, proforma_id || null, customer_id || null, customer_name || null,
       vehicle_id || null, vehicle_plate || null, odometer_out || null,
       payment_confirmed, qc_confirmed, req.userId,
       payment_confirmed, qc_confirmed, notes || null]
    );

    let status = (payment_confirmed && qc_confirmed) ? 'released' : 'pending';
    let released_at = null;
    if (status === 'released') {
      released_at = new Date();
      await execute(
        'UPDATE gate_passes SET released_at = NOW() WHERE id = ?',
        [result.insertId]
      );
    }

    await logAudit(req.workshopId, req.userId, 'CREATE', 'gate_passes', result.insertId, null,
      { gate_pass_number, payment_confirmed, qc_confirmed, status });

    res.status(201).json({
      success: true,
      id: result.insertId,
      gate_pass_number,
      status,
      payment_confirmed: !!payment_confirmed,
      qc_confirmed: !!qc_confirmed,
      message: status === 'pending'
        ? `Gate pass created but not released: ${!payment_confirmed ? 'payment not confirmed' : 'QC not passed'}`
        : 'Vehicle released'
    });
  } catch (err) {
    console.error('POST /gate-pass error:', err);
    res.status(500).json({ success: false, message: 'Failed to create gate pass' });
  }
});

// PATCH /api/gate-pass/:id/release — manually release vehicle
gatePassRouter.patch('/:id/release', async (req, res) => {
  try {
    const { customer_signature } = req.body;
    const [gp] = await query(
      'SELECT * FROM gate_passes WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!gp) return res.status(404).json({ success: false, message: 'Gate pass not found' });
    if (gp.status === 'released') {
      return res.status(400).json({ success: false, message: 'Vehicle already released' });
    }

    // Final check: payment AND QC must both be confirmed
    if (!gp.payment_confirmed) {
      return res.status(400).json({ success: false, message: 'Cannot release: payment not confirmed' });
    }
    if (!gp.qc_confirmed) {
      return res.status(400).json({ success: false, message: 'Cannot release: quality control not passed' });
    }

    await execute(
      `UPDATE gate_passes SET status = 'released', released_at = NOW(), released_by = ?,
       customer_signature = COALESCE(?, customer_signature)
       WHERE id = ?`,
      [req.userId, customer_signature || null, req.params.id]
    );

    await logAudit(req.workshopId, req.userId, 'RELEASE', 'gate_passes', req.params.id, 'pending', { status: 'released' });
    res.json({ success: true, message: 'Vehicle released via gate pass' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to release gate pass' });
  }
});

export { proformaRouter, gatePassRouter };
export default router;
