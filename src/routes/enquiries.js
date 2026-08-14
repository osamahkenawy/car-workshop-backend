/**
 * ═══════════════════════════════════════════════════════════════════
 *  Enquiries — journey stages 01-02 (awareness, enquiry & quotation)
 * ═══════════════════════════════════════════════════════════════════
 *
 * The CX journey map flags the enquiry log as a system gap handled
 * manually today. Every enquiry is captured with the channel it arrived
 * through, so conversion can be measured by source; enquiries that don't
 * convert record a reason and a re-offer date, which is the "nurture and
 * re-offer" loop drawn back to stage 01 on the map.
 *
 * Mounted at: /api/enquiries
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

function genEnquiryNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `ENQ-${stamp}-${Math.floor(Math.random() * 9000) + 1000}`;
}

// GET /api/enquiries — list with filters
router.get('/', async (req, res) => {
  try {
    const { status, source_channel, payer_type, service_tier, search, due, page = 1, limit = 50 } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = Math.min(parseInt(limit, 10) || 50, 200);
    const offset = (pg - 1) * lim;

    let where = 'WHERE e.workshop_id = ?';
    const params = [req.workshopId];
    if (status) { where += ' AND e.status = ?'; params.push(status); }
    if (source_channel) { where += ' AND e.source_channel = ?'; params.push(source_channel); }
    if (payer_type) { where += ' AND e.payer_type = ?'; params.push(payer_type); }
    if (service_tier) { where += ' AND e.service_tier = ?'; params.push(service_tier); }
    if (due === 'true') { where += ' AND e.follow_up_at IS NOT NULL AND e.follow_up_at <= NOW() AND e.status IN ("new","quoted","nurture")'; }
    if (search) {
      where += ' AND (e.enquiry_number LIKE ? OR e.contact_name LIKE ? OR e.contact_phone LIKE ? OR e.description LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM enquiries e ${where}`, params);
    const rows = await query(
      `SELECT e.*, c.full_name AS customer_full_name, wo.work_order_number
       FROM enquiries e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN work_orders wo ON e.converted_work_order_id = wo.id
       ${where}
       ORDER BY e.created_at DESC
       LIMIT ${lim} OFFSET ${offset}`,
      params
    );
    return res.json({ success: true, data: rows, pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    console.error('[Enquiries] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch enquiries' });
  }
});

// GET /api/enquiries/stats — conversion by channel (the point of capturing source)
router.get('/stats', async (req, res) => {
  try {
    const [totals] = await query(
      `SELECT COUNT(*) AS total,
              SUM(status = 'new') AS new_count,
              SUM(status = 'quoted') AS quoted,
              SUM(status = 'converted') AS converted,
              SUM(status = 'lost') AS lost,
              SUM(status = 'nurture') AS nurture,
              SUM(follow_up_at IS NOT NULL AND follow_up_at <= NOW()
                  AND status IN ('new','quoted','nurture')) AS follow_ups_due
       FROM enquiries WHERE workshop_id = ?`,
      [req.workshopId]
    );

    const byChannel = await query(
      `SELECT source_channel,
              COUNT(*) AS total,
              SUM(status = 'converted') AS converted,
              ROUND(100 * SUM(status = 'converted') / NULLIF(COUNT(*), 0), 1) AS conversion_rate
       FROM enquiries WHERE workshop_id = ?
       GROUP BY source_channel ORDER BY total DESC`,
      [req.workshopId]
    );

    // Counts both 'lost' and 'nurture' — an enquiry with a re-offer scheduled
    // still recorded a reason it didn't convert, and that reason is the point.
    const lostReasons = await query(
      `SELECT lost_reason,
              COUNT(*) AS count,
              SUM(status = 'nurture') AS in_nurture
       FROM enquiries
       WHERE workshop_id = ? AND status IN ('lost','nurture') AND lost_reason IS NOT NULL
       GROUP BY lost_reason ORDER BY count DESC`,
      [req.workshopId]
    );

    return res.json({
      success: true,
      data: {
        totals: totals || {},
        by_channel: byChannel,
        lost_reasons: lostReasons,
      },
    });
  } catch (err) {
    console.error('[Enquiries] stats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch enquiry stats' });
  }
});

// GET /api/enquiries/:id
router.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT e.*, c.full_name AS customer_full_name, wo.work_order_number
       FROM enquiries e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN work_orders wo ON e.converted_work_order_id = wo.id
       WHERE e.id = ? AND e.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.json({ success: true, data: row });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch enquiry' });
  }
});

// POST /api/enquiries
router.post('/', async (req, res) => {
  try {
    const {
      customer_id, vehicle_id, contact_name, contact_phone, contact_email, vehicle_description,
      enquiry_type, service_tier, description, quoted_amount,
      source_channel, source_detail, referred_by, contact_method,
      payer_type, status, follow_up_at, assigned_to,
    } = req.body;

    if (!contact_name || !contact_phone) {
      return res.status(400).json({ success: false, message: 'Contact name and phone are required' });
    }
    if (!source_channel) {
      return res.status(400).json({ success: false, message: 'Source channel is required — it is what makes conversion measurable' });
    }

    const enquiry_number = genEnquiryNumber();
    const result = await execute(
      `INSERT INTO enquiries
         (workshop_id, enquiry_number, customer_id, vehicle_id, contact_name, contact_phone, contact_email,
          vehicle_description, enquiry_type, service_tier, description, quoted_amount, quoted_at,
          source_channel, source_detail, referred_by, contact_method, payer_type, status,
          follow_up_at, assigned_to, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, enquiry_number, customer_id || null, vehicle_id || null,
       contact_name.trim(), contact_phone.trim(), contact_email || null, vehicle_description || null,
       enquiry_type || 'service', service_tier || null, description || null,
       quoted_amount != null && quoted_amount !== '' ? quoted_amount : null,
       quoted_amount != null && quoted_amount !== '' ? new Date() : null,
       source_channel, source_detail || null, referred_by || null,
       contact_method || 'phone', payer_type || 'self_pay', status || 'new',
       follow_up_at || null, assigned_to || null, req.user.id]
    );

    const [row] = await query('SELECT * FROM enquiries WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('[Enquiries] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create enquiry' });
  }
});

// PUT /api/enquiries/:id
router.put('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT * FROM enquiries WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Enquiry not found' });

    const f = { ...existing, ...req.body };
    const quotedChanged = req.body.quoted_amount != null && String(req.body.quoted_amount) !== String(existing.quoted_amount);

    await execute(
      `UPDATE enquiries SET
         customer_id=?, vehicle_id=?, contact_name=?, contact_phone=?, contact_email=?, vehicle_description=?,
         enquiry_type=?, service_tier=?, description=?, quoted_amount=?, quoted_at=?,
         source_channel=?, source_detail=?, referred_by=?, contact_method=?, payer_type=?,
         status=?, lost_reason=?, lost_notes=?, follow_up_at=?, assigned_to=?
       WHERE id = ? AND workshop_id = ?`,
      [f.customer_id || null, f.vehicle_id || null, f.contact_name, f.contact_phone, f.contact_email || null,
       f.vehicle_description || null, f.enquiry_type, f.service_tier || null, f.description || null,
       f.quoted_amount != null && f.quoted_amount !== '' ? f.quoted_amount : null,
       quotedChanged ? new Date() : (existing.quoted_at || null),
       f.source_channel, f.source_detail || null, f.referred_by || null, f.contact_method, f.payer_type,
       f.status, f.lost_reason || null, f.lost_notes || null, f.follow_up_at || null, f.assigned_to || null,
       req.params.id, req.workshopId]
    );

    const [row] = await query('SELECT * FROM enquiries WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[Enquiries] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update enquiry' });
  }
});

// POST /api/enquiries/:id/lost — record why it didn't convert + schedule a re-offer
router.post('/:id/lost', async (req, res) => {
  try {
    const { lost_reason, lost_notes, follow_up_at } = req.body;
    if (!lost_reason) return res.status(400).json({ success: false, message: 'lost_reason is required' });

    const [existing] = await query('SELECT id FROM enquiries WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Enquiry not found' });

    // A scheduled re-offer keeps it in the nurture loop rather than closing it out.
    const status = follow_up_at ? 'nurture' : 'lost';
    await execute(
      'UPDATE enquiries SET status = ?, lost_reason = ?, lost_notes = ?, follow_up_at = ? WHERE id = ? AND workshop_id = ?',
      [status, lost_reason, lost_notes || null, follow_up_at || null, req.params.id, req.workshopId]
    );
    const [row] = await query('SELECT * FROM enquiries WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: row });
  } catch (err) {
    console.error('[Enquiries] lost error:', err);
    return res.status(500).json({ success: false, message: 'Failed to record outcome' });
  }
});

// POST /api/enquiries/:id/convert — turn an enquiry into a work order
// Carries the source channel onto the work order so attribution survives conversion.
router.post('/:id/convert', async (req, res) => {
  try {
    const [enq] = await query('SELECT * FROM enquiries WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!enq) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (enq.converted_work_order_id) {
      return res.status(409).json({ success: false, message: 'This enquiry has already been converted' });
    }

    const { customer_id, vehicle_id, service_bay_id, scheduled_at, create_customer } = req.body;
    let finalCustomerId = customer_id || enq.customer_id || null;

    // Optionally create the customer record from the enquiry contact details
    if (!finalCustomerId && create_customer) {
      const custRes = await execute(
        'INSERT INTO customers (workshop_id, full_name, phone, email) VALUES (?,?,?,?)',
        [req.workshopId, enq.contact_name, enq.contact_phone, enq.contact_email || null]
      );
      finalCustomerId = custRes.insertId;
    }

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const work_order_number = `WO-${stamp}-${Math.floor(Math.random() * 9000) + 1000}`;

    const woRes = await execute(
      `INSERT INTO work_orders
         (workshop_id, work_order_number, customer_id, vehicle_id, service_bay_id,
          customer_name, customer_phone, customer_email, description,
          service_tier, payer_type, enquiry_id, scheduled_at, service_fee, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending')`,
      [req.workshopId, work_order_number, finalCustomerId, vehicle_id || enq.vehicle_id || null,
       service_bay_id || null, enq.contact_name, enq.contact_phone, enq.contact_email || null,
       enq.description || null, enq.service_tier || null, enq.payer_type || 'self_pay',
       enq.id, scheduled_at || null, enq.quoted_amount || 0]
    );

    await execute(
      "UPDATE enquiries SET status = 'converted', converted_work_order_id = ?, converted_at = NOW(), customer_id = ? WHERE id = ?",
      [woRes.insertId, finalCustomerId, enq.id]
    );

    const [wo] = await query('SELECT * FROM work_orders WHERE id = ?', [woRes.insertId]);
    return res.status(201).json({ success: true, data: { work_order: wo, enquiry_id: enq.id } });
  } catch (err) {
    console.error('[Enquiries] convert error:', err);
    return res.status(500).json({ success: false, message: 'Failed to convert enquiry' });
  }
});

// DELETE /api/enquiries/:id
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query('SELECT converted_work_order_id FROM enquiries WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!existing) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (existing.converted_work_order_id) {
      return res.status(409).json({ success: false, message: 'Cannot delete a converted enquiry — it is linked to a work order' });
    }
    await execute('DELETE FROM enquiries WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Enquiry deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete enquiry' });
  }
});

export default router;
