/**
 * ═══════════════════════════════════════════════════════════════════
 *  Parts Routes — inventory parts used on a work order
 * ═══════════════════════════════════════════════════════════════════
 *
 * SIMPLIFICATION NOTE: this file replaces the original delivery-service
 * `packages.js`, which modeled physical shipping parcels (Order -> Package
 * -> Stop -> Barcode, enterprise-logistics style) with their own
 * barcode/tracking_number, recipient snapshot, address/area/emirate/lat/lng,
 * weight/dimensions, COD amount, and a long parcel status lifecycle
 * (created -> warehouse_in -> assigned -> picked_up -> in_transit ->
 * out_for_delivery -> delivered/failed/returned/cancelled) plus scan-log
 * and auto-generated-stops machinery.
 *
 * NONE of that shipping-parcel machinery applies to shop inventory. A
 * "part" here is simply an inventory line item consumed by a work order
 * (e.g. "Brake pads x2 @ 150 AED"), so this file is a much simpler CRUD:
 *   - part_number, name, description, quantity, unit_cost, total_cost,
 *     warranty_period_days
 *   - status: ordered -> in_stock -> installed -> returned
 *   - scoped by workshop_id + work_order_id (per car_workshop.sql `parts`
 *     table)
 * Dropped entirely: recipient fields, address/area/emirate/lat/lng,
 * weight/dimensions, cod_amount, barcode/tracking_number as a parcel
 * identifier, warehouse/transit status lifecycle, scan logs, auto-stops,
 * shipping-label PDF generation (a part doesn't get its own shipping
 * label — the work order/job sheet PDF is handled by
 * ../lib/service-job-sheet.js instead).
 *
 * Mounted at: /api/parts
 *
 * Endpoints:
 *   GET    /api/parts                         — List parts (filter by work_order_id)
 *   POST   /api/parts                          — Create part(s) for a work order
 *   GET    /api/parts/:id                      — Get single part detail
 *   PUT    /api/parts/:id                      — Update a part
 *   PATCH  /api/parts/:id/status               — Update part status
 *   DELETE /api/parts/:id                      — Remove a part
 * ═══════════════════════════════════════════════════════════════════
 */

import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyPartStatus } from '../lib/notify.js';

const router = express.Router();
router.use(authMiddleware);

const VALID_STATUSES = ['ordered', 'in_stock', 'installed', 'returned'];

/* Status transitions for parts inventory lifecycle */
const PART_TRANSITIONS = {
  ordered:   ['in_stock', 'returned'],
  in_stock:  ['installed', 'returned'],
  installed: ['returned'],
  returned:  ['ordered'], // allow re-order
};

/* ═══════════════════════════════════════════════════════════════
   Helper: recompute total_cost = quantity * unit_cost
   ═══════════════════════════════════════════════════════════════ */
function computeTotalCost(quantity, unitCost) {
  const qty = parseInt(quantity, 10) || 1;
  const cost = parseFloat(unitCost) || 0;
  return Math.round(qty * cost * 100) / 100;
}

/* ═══════════════════════════════════════════════════════════════
   1. GET /api/parts — list parts, optionally filtered by work_order_id/status
   ═══════════════════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const { work_order_id, status, page = 1, limit = 100 } = req.query;
    const pg = Math.max(1, parseInt(page) || 1);
    const lim = Math.min(500, Math.max(1, parseInt(limit) || 100));
    const offset = (pg - 1) * lim;

    let where = 'WHERE p.workshop_id = ?';
    const params = [req.workshopId];

    if (work_order_id) { where += ' AND p.work_order_id = ?'; params.push(work_order_id); }
    if (status) { where += ' AND p.status = ?'; params.push(status); }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM parts p ${where}`, params);
    const parts = await query(
      `SELECT p.*, wo.work_order_number
       FROM parts p
       LEFT JOIN work_orders wo ON p.work_order_id = wo.id
       ${where} ORDER BY p.created_at DESC LIMIT ${lim} OFFSET ${offset}`,
      params
    );

    return res.json({ success: true, data: parts, pagination: { total, page: pg, limit: lim } });
  } catch (err) {
    console.error('[Parts] List error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch parts' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   2. POST /api/parts — create one or more parts for a work order
      Body: { work_order_id, parts: [{ part_number?, name, description?,
              quantity?, unit_cost?, warranty_period_days?, notes? }] }
      Also accepts a single-part shorthand body (part_number, name, ...)
      with work_order_id directly on the body.
   ═══════════════════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  try {
    const { work_order_id, parts: partList } = req.body;
    if (!work_order_id) {
      return res.status(400).json({ success: false, message: 'work_order_id is required' });
    }

    // Verify work order exists and belongs to this workshop
    const [workOrder] = await query(
      'SELECT id, workshop_id FROM work_orders WHERE id = ? AND workshop_id = ?',
      [work_order_id, req.workshopId]
    );
    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    // Support both a `parts` array and a single-part shorthand body
    const list = Array.isArray(partList) && partList.length ? partList : [req.body];

    const created = [];
    for (const part of list) {
      if (!part.name) continue; // skip incomplete entries
      const quantity = parseInt(part.quantity, 10) || 1;
      const unitCost = parseFloat(part.unit_cost) || 0;
      const totalCost = computeTotalCost(quantity, unitCost);

      const result = await execute(
        `INSERT INTO parts (
          workshop_id, work_order_id, part_number, name, description,
          quantity, unit_cost, total_cost, warranty_period_days, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.workshopId, work_order_id,
          part.part_number || null, part.name, part.description || null,
          quantity, unitCost, totalCost,
          parseInt(part.warranty_period_days, 10) || 0,
          VALID_STATUSES.includes(part.status) ? part.status : 'ordered',
          part.notes || null,
        ]
      );

      const [insertedPart] = await query('SELECT * FROM parts WHERE id = ?', [result.insertId]);
      created.push(insertedPart);
    }

    if (!created.length) {
      return res.status(400).json({ success: false, message: 'No valid parts provided (name is required)' });
    }

    return res.status(201).json({
      success: true,
      message: `Created ${created.length} part(s)`,
      data: created.length === 1 ? created[0] : created,
    });
  } catch (err) {
    console.error('[Parts] Create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create part(s)' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   3. GET /api/parts/:id — get single part detail
   ═══════════════════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const [part] = await query(
      `SELECT p.*, wo.work_order_number
       FROM parts p
       LEFT JOIN work_orders wo ON p.work_order_id = wo.id
       WHERE p.id = ? AND p.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!part) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }
    return res.json({ success: true, data: part });
  } catch (err) {
    console.error('[Parts] Get error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch part' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   4. PUT /api/parts/:id — update part details
   ═══════════════════════════════════════════════════════════════ */
router.put('/:id', async (req, res) => {
  try {
    const [part] = await query(
      'SELECT * FROM parts WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!part) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }

    const {
      part_number, name, description, quantity, unit_cost,
      warranty_period_days, notes,
    } = req.body;

    const newQuantity = quantity != null ? (parseInt(quantity, 10) || part.quantity) : part.quantity;
    const newUnitCost = unit_cost != null ? (parseFloat(unit_cost) || 0) : part.unit_cost;
    const newTotalCost = computeTotalCost(newQuantity, newUnitCost);

    await execute(
      `UPDATE parts SET
        part_number = COALESCE(?, part_number),
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        quantity = ?,
        unit_cost = ?,
        total_cost = ?,
        warranty_period_days = COALESCE(?, warranty_period_days),
        notes = COALESCE(?, notes)
       WHERE id = ?`,
      [
        part_number ?? null, name ?? null, description ?? null,
        newQuantity, newUnitCost, newTotalCost,
        warranty_period_days != null ? parseInt(warranty_period_days, 10) : null,
        notes ?? null,
        req.params.id,
      ]
    );

    const [updated] = await query('SELECT * FROM parts WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[Parts] Update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update part' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   5. PATCH /api/parts/:id/status — update part status
      Body: { status, notes? }
   ═══════════════════════════════════════════════════════════════ */
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const [part] = await query(
      'SELECT p.*, wo.work_order_number FROM parts p LEFT JOIN work_orders wo ON p.work_order_id = wo.id WHERE p.id = ? AND p.workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!part) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }

    const allowed = PART_TRANSITIONS[part.status] || [];
    if (part.status !== status && !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot change part from "${part.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}`,
      });
    }

    const sets = ['status = ?'];
    const vals = [status];
    if (status === 'installed') { sets.push('installed_at = NOW()'); }
    if (status === 'returned') { sets.push('returned_at = NOW()'); }
    if (notes) { sets.push('notes = ?'); vals.push(notes); }

    vals.push(req.params.id);
    await execute(`UPDATE parts SET ${sets.join(', ')} WHERE id = ?`, vals);

    // Notify (non-blocking) — mirrors the original per-package status notification,
    // now scoped to a part on a work order rather than a shipped parcel.
    const [parentOrder] = await query(
      'SELECT id, work_order_number, customer_name, customer_phone, mechanic_id FROM work_orders WHERE id = ?',
      [part.work_order_id]
    ).catch(() => [null]);
    if (parentOrder) {
      notifyPartStatus({
        order: parentOrder, pkg: { ...part, status },
        newStatus: status, tenantId: req.workshopId,
        changedBy: req.user?.id,
        delivered: status === 'installed' ? 1 : 0, total: 1,
      }).catch(() => {});
    }

    const [updated] = await query('SELECT * FROM parts WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[Parts] Status error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update part status' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   6. DELETE /api/parts/:id — remove a part
      (only allowed before it has been installed, to avoid losing
      history on a part actually fitted to the vehicle)
   ═══════════════════════════════════════════════════════════════ */
router.delete('/:id', async (req, res) => {
  try {
    const [part] = await query(
      'SELECT * FROM parts WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!part) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }
    if (part.status === 'installed') {
      return res.status(400).json({ success: false, message: 'Cannot delete a part that has already been installed' });
    }

    await execute('DELETE FROM parts WHERE id = ?', [req.params.id]);
    return res.json({ success: true, message: 'Part removed' });
  } catch (err) {
    console.error('[Parts] Delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete part' });
  }
});

export default router;
