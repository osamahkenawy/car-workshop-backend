/**
 * Service Bays
 * -------------------------------------------------------------------------
 * PIVOT NOTE: this file replaces the original zones.js, which modeled UAE
 * geographic delivery zones (GeoJSON polygon, radius, center_lat/lng,
 * base_delivery_fee, extra_km_fee, max_weight_kg, estimated_minutes).
 *
 * In a car-workshop context there is no equivalent of a delivery catchment
 * area — instead a workshop has physical service bays/lanes where vehicles
 * are worked on (e.g. "Bay 1", "Bay 2", "Quick Service Lane", "Diagnostic
 * Bay"). All geo/polygon-specific fields (polygon, radius, center_lat,
 * center_lng, extra_km_fee, max_weight_kg) have been DROPPED since they
 * don't apply to a physical bay. The field set has been redesigned to:
 *   - name            (e.g. "Bay 1")
 *   - bay_number       (e.g. "1", "QS1")
 *   - bay_type         (enum: 'general' | 'quick_service' | 'diagnostic' |
 *                        'bodywork' | 'tire')
 *   - capacity         (how many vehicles the bay can hold at once)
 *   - is_active
 *   - notes
 * The CRUD route structure (list/create/update/delete/get-by-id) and
 * workshop-scoping (workshop_id) are preserved as-is from the original.
 * -------------------------------------------------------------------------
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

const VALID_BAY_TYPES = ['general', 'quick_service', 'diagnostic', 'bodywork', 'tire'];

// GET /api/service-bays
router.get('/', async (req, res) => {
  try {
    const bays = await query(
      `SELECT b.*,
              COUNT(DISTINCT m.id) as mechanic_count,
              COUNT(DISTINCT o.id) as work_order_count
       FROM service_bays b
       LEFT JOIN mechanics m ON m.service_bay_id = b.id
       LEFT JOIN work_orders o ON o.service_bay_id = b.id
       WHERE b.workshop_id = ?
       GROUP BY b.id ORDER BY b.bay_number, b.name`,
      [req.workshopId]
    );
    return res.json({ success: true, data: bays });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch service bays' });
  }
});

// GET /api/service-bays/:id
router.get('/:id', async (req, res) => {
  try {
    const [bay] = await query('SELECT * FROM service_bays WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!bay) return res.status(404).json({ success: false, message: 'Service bay not found' });
    return res.json({ success: true, data: bay });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch service bay' });
  }
});

// POST /api/service-bays
router.post('/', async (req, res) => {
  try {
    const { name, bay_number, bay_type, capacity, notes, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    const safeBayType = VALID_BAY_TYPES.includes(bay_type) ? bay_type : 'general';
    const safeCapacity = capacity !== undefined && capacity !== null && capacity !== '' ? parseInt(capacity, 10) : 1;
    if (isNaN(safeCapacity) || safeCapacity < 1) {
      return res.status(400).json({ success: false, message: 'Capacity must be a positive number' });
    }
    const result = await execute(
      `INSERT INTO service_bays (workshop_id, name, bay_number, bay_type, capacity, notes, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, name, bay_number || null, safeBayType, safeCapacity, notes || null, is_active !== false]
    );
    const [bay] = await query('SELECT * FROM service_bays WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: bay });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to create service bay' });
  }
});

// PUT /api/service-bays/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, bay_number, bay_type, capacity, notes, is_active } = req.body;
    const safeBayType = VALID_BAY_TYPES.includes(bay_type) ? bay_type : 'general';
    const safeCapacity = capacity !== undefined && capacity !== null && capacity !== '' ? parseInt(capacity, 10) : 1;
    await execute(
      `UPDATE service_bays SET name=?, bay_number=?, bay_type=?, capacity=?,
        notes=?, is_active=? WHERE id = ? AND workshop_id = ?`,
      [name, bay_number || null, safeBayType, safeCapacity, notes || null,
       is_active !== undefined ? is_active : true, req.params.id, req.workshopId]
    );
    const [bay] = await query('SELECT * FROM service_bays WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: bay });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Failed to update service bay' });
  }
});

// DELETE /api/service-bays/:id
router.delete('/:id', async (req, res) => {
  try {
    // Check for references before deleting
    const [workOrderRef] = await query(
      'SELECT COUNT(*) as cnt FROM work_orders WHERE service_bay_id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (workOrderRef && workOrderRef.cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete service bay — it is referenced by ${workOrderRef.cnt} work order(s). Remove the bay from those work orders first.`
      });
    }

    const [mechanicRef] = await query(
      'SELECT COUNT(*) as cnt FROM mechanics WHERE service_bay_id = ?',
      [req.params.id]
    );
    if (mechanicRef && mechanicRef.cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete service bay — ${mechanicRef.cnt} mechanic(s) are assigned to it. Reassign them first.`
      });
    }

    // Safe to delete — also clean up service_pricing_rules referencing this bay
    await execute('DELETE FROM service_pricing_rules WHERE service_bay_id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    await execute('DELETE FROM service_bays WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Service bay deleted' });
  } catch (err) {
    console.error('Service bay delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete service bay' });
  }
});

export default router;
