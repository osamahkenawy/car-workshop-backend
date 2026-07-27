/**
 * ═══════════════════════════════════════════════════════════════
 *  Material Requisitions, Issues & Returns — SOW Section B6
 *  Covers: req 84 (two parts-pricing paths),
 *          req 85 (material requisition → issue → return → reservation),
 *          req 86 (bulk consumable issue note),
 *          req 87 (paint/body bulk material issue),
 *          req 88 (average-cost valuation, multi-location stock,
 *                  inter-location transfer, stock reservation)
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
// INVENTORY LOCATIONS (req 88 multi-location)
// ══════════════════════════════════════════════════════════════

// GET /api/inventory/locations
router.get('/locations', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM inventory_locations WHERE workshop_id = ? ORDER BY name',
      [req.workshopId]
    );
    res.json({ success: true, locations: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch locations' });
  }
});

// POST /api/inventory/locations
router.post('/locations', async (req, res) => {
  try {
    const { name, location_type = 'main_store' } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name required' });
    const result = await execute(
      'INSERT INTO inventory_locations (workshop_id, name, location_type) VALUES (?,?,?)',
      [req.workshopId, name, location_type]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create location' });
  }
});

// ══════════════════════════════════════════════════════════════
// INVENTORY STOCK — view stock across locations (req 88)
// ══════════════════════════════════════════════════════════════

// GET /api/inventory/stock?location_id=&part_number=&search=
router.get('/stock', async (req, res) => {
  try {
    const { location_id, part_number, search } = req.query;
    let sql = `
      SELECT s.*, l.name AS location_name, l.location_type
      FROM inventory_stock s
      JOIN inventory_locations l ON s.location_id = l.id
      WHERE s.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (location_id) { sql += ' AND s.location_id = ?'; params.push(location_id); }
    if (part_number) { sql += ' AND s.part_number = ?'; params.push(part_number); }
    if (search) {
      sql += ' AND (s.part_number LIKE ? OR s.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY l.name, s.part_number';
    const rows = await query(sql, params);
    res.json({ success: true, stock: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stock' });
  }
});

// POST /api/inventory/stock/receive — receive stock (updates AVCO, req 88)
// Body: { location_id, items: [{part_number, description, quantity, purchase_cost}] }
router.post('/stock/receive', async (req, res) => {
  try {
    const { location_id, items = [], reference } = req.body;
    if (!location_id || !items.length) {
      return res.status(400).json({ success: false, message: 'location_id and items required' });
    }

    for (const item of items) {
      const { part_number, description, quantity, purchase_cost } = item;
      if (!part_number || !quantity || !purchase_cost) continue;

      // Compute new AVCO = (existing_qty * avg_cost + new_qty * purchase_cost) / total_qty
      const [existing] = await query(
        'SELECT quantity_on_hand, avg_cost FROM inventory_stock WHERE location_id = ? AND part_number = ?',
        [location_id, part_number]
      );

      if (existing) {
        const newQty  = parseFloat(existing.quantity_on_hand) + parseFloat(quantity);
        const newAvco = ((parseFloat(existing.quantity_on_hand) * parseFloat(existing.avg_cost)) +
                         (parseFloat(quantity) * parseFloat(purchase_cost))) / newQty;
        await execute(
          `UPDATE inventory_stock SET quantity_on_hand = ?, avg_cost = ?, last_purchase_cost = ?
           WHERE location_id = ? AND part_number = ?`,
          [newQty, newAvco.toFixed(4), purchase_cost, location_id, part_number]
        );
      } else {
        await execute(
          `INSERT INTO inventory_stock (workshop_id, location_id, part_number, description, quantity_on_hand, avg_cost, last_purchase_cost)
           VALUES (?,?,?,?,?,?,?)`,
          [req.workshopId, location_id, part_number, description || null, quantity, purchase_cost, purchase_cost]
        );
      }
    }

    await logAudit(req.workshopId, req.userId, 'STOCK_RECEIVE', 'inventory_stock', null, null, { location_id, reference });
    res.json({ success: true, message: 'Stock received and AVCO updated' });
  } catch (err) {
    console.error('POST /inventory/stock/receive error:', err);
    res.status(500).json({ success: false, message: 'Failed to receive stock' });
  }
});

// POST /api/inventory/stock/transfer — inter-location transfer (req 88)
router.post('/stock/transfer', async (req, res) => {
  try {
    const { from_location_id, to_location_id, part_number, quantity, notes } = req.body;
    if (!from_location_id || !to_location_id || !part_number || !quantity) {
      return res.status(400).json({ success: false, message: 'from_location_id, to_location_id, part_number, quantity required' });
    }

    const [fromStock] = await query(
      'SELECT * FROM inventory_stock WHERE location_id = ? AND part_number = ? AND workshop_id = ?',
      [from_location_id, part_number, req.workshopId]
    );
    if (!fromStock || parseFloat(fromStock.quantity_on_hand) < parseFloat(quantity)) {
      return res.status(400).json({ success: false, message: 'Insufficient stock at source location' });
    }

    const avg_cost = parseFloat(fromStock.avg_cost);

    // Deduct from source
    await execute(
      'UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - ? WHERE location_id = ? AND part_number = ?',
      [quantity, from_location_id, part_number]
    );

    // Add to destination (update AVCO)
    const [toStock] = await query(
      'SELECT * FROM inventory_stock WHERE location_id = ? AND part_number = ?',
      [to_location_id, part_number]
    );

    if (toStock) {
      const newQty  = parseFloat(toStock.quantity_on_hand) + parseFloat(quantity);
      const newAvco = ((parseFloat(toStock.quantity_on_hand) * parseFloat(toStock.avg_cost)) +
                       (parseFloat(quantity) * avg_cost)) / newQty;
      await execute(
        'UPDATE inventory_stock SET quantity_on_hand = ?, avg_cost = ? WHERE location_id = ? AND part_number = ?',
        [newQty, newAvco.toFixed(4), to_location_id, part_number]
      );
    } else {
      await execute(
        `INSERT INTO inventory_stock (workshop_id, location_id, part_number, description, quantity_on_hand, avg_cost)
         VALUES (?,?,?,?,?,?)`,
        [req.workshopId, to_location_id, part_number, fromStock.description, quantity, avg_cost]
      );
    }

    await logAudit(req.workshopId, req.userId, 'STOCK_TRANSFER', 'inventory_stock', null, null,
      { from_location_id, to_location_id, part_number, quantity, notes });
    res.json({ success: true, message: 'Stock transferred' });
  } catch (err) {
    console.error('POST /inventory/stock/transfer error:', err);
    res.status(500).json({ success: false, message: 'Failed to transfer stock' });
  }
});

// ══════════════════════════════════════════════════════════════
// MATERIAL REQUISITIONS (req 85)
// ══════════════════════════════════════════════════════════════

// GET /api/inventory/requisitions?job_card_id=&status=
router.get('/requisitions', async (req, res) => {
  try {
    const { job_card_id, status } = req.query;
    let sql = `
      SELECT mr.*, jc.job_card_number, jc.vehicle_plate
      FROM material_requisitions mr
      LEFT JOIN job_cards jc ON mr.job_card_id = jc.id
      WHERE mr.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (job_card_id) { sql += ' AND mr.job_card_id = ?'; params.push(job_card_id); }
    if (status) { sql += ' AND mr.status = ?'; params.push(status); }
    sql += ' ORDER BY mr.created_at DESC';

    const rows = await query(sql, params);
    res.json({ success: true, requisitions: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch requisitions' });
  }
});

// GET /api/inventory/requisitions/:id
router.get('/requisitions/:id', async (req, res) => {
  try {
    const [mr] = await query(
      `SELECT mr.*, jc.job_card_number FROM material_requisitions mr
       LEFT JOIN job_cards jc ON mr.job_card_id = jc.id
       WHERE mr.id = ? AND mr.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!mr) return res.status(404).json({ success: false, message: 'Requisition not found' });

    const items = await query('SELECT * FROM material_requisition_items WHERE requisition_id = ?', [req.params.id]);
    res.json({ success: true, requisition: mr, items });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch requisition' });
  }
});

// POST /api/inventory/requisitions — create parts request (req 85)
router.post('/requisitions', async (req, res) => {
  try {
    const { job_card_id, items = [], notes } = req.body;
    if (!job_card_id || !items.length) {
      return res.status(400).json({ success: false, message: 'job_card_id and items required' });
    }

    const req_number = genNumber('MR');
    const result = await execute(
      'INSERT INTO material_requisitions (workshop_id, req_number, job_card_id, requested_by, notes) VALUES (?,?,?,?,?)',
      [req.workshopId, req_number, job_card_id, req.userId, notes || null]
    );
    const reqId = result.insertId;

    for (const item of items) {
      await execute(
        `INSERT INTO material_requisition_items
           (requisition_id, part_number, description, quantity_requested, unit_cost)
         VALUES (?,?,?,?,?)`,
        [reqId, item.part_number || null, item.description, parseFloat(item.quantity_requested || 1), item.unit_cost || null]
      );
    }

    // Update job card to parts_requested status
    await execute(
      `UPDATE job_cards SET status = 'parts_requested'
       WHERE id = ? AND workshop_id = ? AND status = 'open'`,
      [job_card_id, req.workshopId]
    );

    res.status(201).json({ success: true, requisitionId: reqId, req_number });
  } catch (err) {
    console.error('POST /inventory/requisitions error:', err);
    res.status(500).json({ success: false, message: 'Failed to create requisition' });
  }
});

// ══════════════════════════════════════════════════════════════
// MATERIAL ISSUES (req 85, 86, 87)
// ══════════════════════════════════════════════════════════════

// POST /api/inventory/issues — issue parts from stores
// issue_type: standard | consumable_bulk | paint_bulk
router.post('/issues', async (req, res) => {
  try {
    const { requisition_id, job_card_id, issue_type = 'standard', items = [], notes, location_id } = req.body;
    if (!job_card_id || !items.length) {
      return res.status(400).json({ success: false, message: 'job_card_id and items required' });
    }

    const issue_number = genNumber('MI');
    const issueResult = await execute(
      `INSERT INTO material_issues (workshop_id, issue_number, requisition_id, job_card_id, issued_by, issue_type, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [req.workshopId, issue_number, requisition_id || null, job_card_id, req.userId, issue_type, notes || null]
    );
    const issueId = issueResult.insertId;

    for (const item of items) {
      const qty = parseFloat(item.quantity);
      let unit_cost = parseFloat(item.unit_cost || 0);

      // Deduct from stock using AVCO (req 88)
      if (location_id) {
        const [stock] = await query(
          'SELECT avg_cost, quantity_on_hand FROM inventory_stock WHERE location_id = ? AND part_number = ? AND workshop_id = ?',
          [location_id, item.part_number, req.workshopId]
        );
        if (stock) {
          unit_cost = parseFloat(stock.avg_cost);
          if (parseFloat(stock.quantity_on_hand) >= qty) {
            await execute(
              'UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand - ? WHERE location_id = ? AND part_number = ?',
              [qty, location_id, item.part_number]
            );
          }
        }
      }

      await execute(
        'INSERT INTO material_issue_items (issue_id, part_number, description, quantity, unit_cost) VALUES (?,?,?,?,?)',
        [issueId, item.part_number || null, item.description, qty, unit_cost]
      );

      // Update requisition item issued quantity
      if (requisition_id && item.part_number) {
        await execute(
          `UPDATE material_requisition_items SET quantity_issued = quantity_issued + ?,
           status = CASE WHEN quantity_issued + ? >= quantity_requested THEN 'issued' ELSE 'partially_issued' END
           WHERE requisition_id = ? AND part_number = ?`,
          [qty, qty, requisition_id, item.part_number]
        );
      }

      // Add WIP cost posting (req 100)
      const lineCost = parseFloat((qty * unit_cost).toFixed(2));
      if (lineCost > 0) {
        await execute(
          `INSERT INTO wip_ledger (workshop_id, job_card_id, entry_type, amount, description, posted_by)
           VALUES (?, ?, 'parts_charge', ?, ?, ?)`,
          [req.workshopId, job_card_id, lineCost, `Parts: ${item.description}`, req.userId]
        );
      }
    }

    // Update requisition status
    if (requisition_id) {
      const reqItems = await query(
        'SELECT status FROM material_requisition_items WHERE requisition_id = ?',
        [requisition_id]
      );
      const allIssued = reqItems.every(i => i.status === 'issued');
      const anyIssued = reqItems.some(i => ['issued','partially_issued'].includes(i.status));
      await execute(
        'UPDATE material_requisitions SET status = ? WHERE id = ?',
        [allIssued ? 'issued' : (anyIssued ? 'partially_issued' : 'pending'), requisition_id]
      );
    }

    // Update job card to parts_issued
    await execute(
      `UPDATE job_cards SET status = 'parts_issued'
       WHERE id = ? AND workshop_id = ? AND status IN ('open','parts_requested')`,
      [job_card_id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'ISSUE', 'material_issues', issueId, null, { issue_number, issue_type });
    res.status(201).json({ success: true, issueId, issue_number });
  } catch (err) {
    console.error('POST /inventory/issues error:', err);
    res.status(500).json({ success: false, message: 'Failed to create issue' });
  }
});

// GET /api/inventory/issues?job_card_id=
router.get('/issues', async (req, res) => {
  try {
    const { job_card_id } = req.query;
    let sql = `SELECT mi.*, jc.job_card_number FROM material_issues mi
               LEFT JOIN job_cards jc ON mi.job_card_id = jc.id
               WHERE mi.workshop_id = ?`;
    const params = [req.workshopId];
    if (job_card_id) { sql += ' AND mi.job_card_id = ?'; params.push(job_card_id); }
    sql += ' ORDER BY mi.created_at DESC';
    const rows = await query(sql, params);

    // Load items
    for (const row of rows) {
      row.items = await query('SELECT * FROM material_issue_items WHERE issue_id = ?', [row.id]);
    }
    res.json({ success: true, issues: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch issues' });
  }
});

// ══════════════════════════════════════════════════════════════
// MATERIAL RETURNS (req 85)
// ══════════════════════════════════════════════════════════════

// POST /api/inventory/returns — return unused parts
router.post('/returns', async (req, res) => {
  try {
    const { issue_id, job_card_id, items = [], reason, location_id } = req.body;
    if (!job_card_id || !items.length) {
      return res.status(400).json({ success: false, message: 'job_card_id and items required' });
    }

    const return_number = genNumber('MRN');
    const result = await execute(
      `INSERT INTO material_returns (workshop_id, return_number, issue_id, job_card_id, returned_by, reason)
       VALUES (?,?,?,?,?,?)`,
      [req.workshopId, return_number, issue_id || null, job_card_id, req.userId, reason || null]
    );
    const returnId = result.insertId;

    for (const item of items) {
      await execute(
        'INSERT INTO material_return_items (return_id, part_number, description, quantity, unit_cost) VALUES (?,?,?,?,?)',
        [returnId, item.part_number || null, item.description, parseFloat(item.quantity), parseFloat(item.unit_cost || 0)]
      );

      // Return to stock (update AVCO, req 88)
      if (location_id && item.part_number) {
        const [stock] = await query(
          'SELECT quantity_on_hand, avg_cost FROM inventory_stock WHERE location_id = ? AND part_number = ?',
          [location_id, item.part_number]
        );
        if (stock) {
          await execute(
            'UPDATE inventory_stock SET quantity_on_hand = quantity_on_hand + ? WHERE location_id = ? AND part_number = ?',
            [item.quantity, location_id, item.part_number]
          );
        } else {
          await execute(
            'INSERT INTO inventory_stock (workshop_id, location_id, part_number, description, quantity_on_hand, avg_cost) VALUES (?,?,?,?,?,?)',
            [req.workshopId, location_id, item.part_number, item.description, item.quantity, item.unit_cost || 0]
          );
        }
      }
    }

    res.status(201).json({ success: true, returnId, return_number });
  } catch (err) {
    console.error('POST /inventory/returns error:', err);
    res.status(500).json({ success: false, message: 'Failed to create return' });
  }
});

// PATCH /api/inventory/returns/:id/accept
router.patch('/returns/:id/accept', async (req, res) => {
  try {
    await execute(
      `UPDATE material_returns SET status = 'accepted', accepted_by = ? WHERE id = ? AND workshop_id = ?`,
      [req.userId, req.params.id, req.workshopId]
    );
    res.json({ success: true, message: 'Return accepted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to accept return' });
  }
});

// ══════════════════════════════════════════════════════════════
// STOCK RESERVATIONS (req 85 — ring-fence parts to a job)
// ══════════════════════════════════════════════════════════════

// POST /api/inventory/reservations — reserve stock for a job
router.post('/reservations', async (req, res) => {
  try {
    const { job_card_id, part_number, description, quantity_reserved } = req.body;
    if (!job_card_id || !part_number || !quantity_reserved) {
      return res.status(400).json({ success: false, message: 'job_card_id, part_number, quantity_reserved required' });
    }

    const result = await execute(
      `INSERT INTO stock_reservations
         (workshop_id, job_card_id, part_number, description, quantity_reserved)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE quantity_reserved = quantity_reserved + VALUES(quantity_reserved)`,
      [req.workshopId, job_card_id, part_number, description || null, parseFloat(quantity_reserved)]
    );

    // Reduce available qty in inventory
    await execute(
      `UPDATE inventory_stock SET quantity_reserved = quantity_reserved + ?
       WHERE workshop_id = ? AND part_number = ? LIMIT 1`,
      [quantity_reserved, req.workshopId, part_number]
    );

    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('POST /inventory/reservations error:', err);
    res.status(500).json({ success: false, message: 'Failed to reserve stock' });
  }
});

// DELETE /api/inventory/reservations/:id — release reservation
router.delete('/reservations/:id', async (req, res) => {
  try {
    const [res_row] = await query('SELECT * FROM stock_reservations WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!res_row) return res.status(404).json({ success: false, message: 'Reservation not found' });

    await execute('UPDATE stock_reservations SET status = "cancelled", released_at = NOW() WHERE id = ?', [req.params.id]);

    await execute(
      `UPDATE inventory_stock SET quantity_reserved = GREATEST(0, quantity_reserved - ?)
       WHERE workshop_id = ? AND part_number = ? LIMIT 1`,
      [res_row.quantity_reserved - (res_row.quantity_released || 0), req.workshopId, res_row.part_number]
    );

    res.json({ success: true, message: 'Reservation released' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to release reservation' });
  }
});

// ══════════════════════════════════════════════════════════════
// SUPPLIER WARRANTY TERMS (req 89)
// ══════════════════════════════════════════════════════════════

// GET /api/inventory/warranty-terms?part_number=
router.get('/warranty-terms', async (req, res) => {
  try {
    const { part_number } = req.query;
    let sql = 'SELECT * FROM supplier_warranty_terms WHERE workshop_id = ? AND is_active = 1';
    const params = [req.workshopId];
    if (part_number) { sql += ' AND part_number = ?'; params.push(part_number); }
    const rows = await query(sql, params);
    res.json({ success: true, terms: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch warranty terms' });
  }
});

// POST /api/inventory/warranty-terms
router.post('/warranty-terms', async (req, res) => {
  try {
    const { part_number, part_name, supplier_name, warranty_months, warranty_km, warranty_conditions } = req.body;
    if (!part_number) return res.status(400).json({ success: false, message: 'part_number required' });

    const result = await execute(
      `INSERT INTO supplier_warranty_terms
         (workshop_id, part_number, part_name, supplier_name, warranty_months, warranty_km, warranty_conditions)
       VALUES (?,?,?,?,?,?,?)`,
      [req.workshopId, part_number, part_name || null, supplier_name || null,
       warranty_months || null, warranty_km || null, warranty_conditions || null]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create warranty term' });
  }
});

// POST /api/inventory/warranty-terms/check — eligibility check on return visit
router.post('/warranty-terms/check', async (req, res) => {
  try {
    const { part_number, original_work_order_id, current_odometer } = req.body;

    const [term] = await query(
      'SELECT * FROM supplier_warranty_terms WHERE workshop_id = ? AND part_number = ? AND is_active = 1',
      [req.workshopId, part_number]
    );
    if (!term) {
      return res.json({ success: true, eligible: false, reason: 'No warranty terms on file for this part' });
    }

    // Find original installation
    const [original] = await query(
      `SELECT p.created_at, wo.odometer_at_service FROM parts p
       LEFT JOIN work_orders wo ON p.work_order_id = wo.id
       WHERE p.work_order_id = ? AND p.part_number = ?
       LIMIT 1`,
      [original_work_order_id, part_number]
    );

    if (!original) {
      return res.json({ success: true, eligible: false, reason: 'No original installation record found' });
    }

    const installDate = new Date(original.created_at);
    const monthsDiff = (Date.now() - installDate.getTime()) / (1000 * 60 * 60 * 24 * 30);

    let eligible = true;
    let reason = 'Within warranty';

    if (term.warranty_months && monthsDiff > term.warranty_months) {
      eligible = false;
      reason = `Warranty expired (${Math.round(monthsDiff)} months vs ${term.warranty_months} months)`;
    }

    if (eligible && term.warranty_km && current_odometer && original.odometer_at_service) {
      const kmDiff = current_odometer - original.odometer_at_service;
      if (kmDiff > term.warranty_km) {
        eligible = false;
        reason = `Warranty expired (${kmDiff.toLocaleString()} km vs ${term.warranty_km.toLocaleString()} km)`;
      }
    }

    res.json({ success: true, eligible, reason, term });
  } catch (err) {
    console.error('POST /inventory/warranty-terms/check error:', err);
    res.status(500).json({ success: false, message: 'Failed to check warranty eligibility' });
  }
});

export default router;
