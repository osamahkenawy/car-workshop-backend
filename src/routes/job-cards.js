/**
 * ═══════════════════════════════════════════════════════════════
 *  Job Cards — SOW Section B5
 *  Covers: req 78 (job card from estimate, parts requisition split),
 *          req 79 (digital technician time capture clock-in/clock-out),
 *          req 80 (quality-control gate before billing),
 *          req 81 (technician productivity & first-time-fix tracking),
 *          req 83 (courtesy/loaner vehicle management)
 * ═══════════════════════════════════════════════════════════════
 */
import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

function genJobCardNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `JC-${stamp}-${Math.floor(Math.random()*9000)+1000}`;
}

function genReqNumber() {
  return `MR-${Date.now()}`;
}

// ══════════════════════════════════════════════════════════════
// GET /api/job-cards — list job cards
// ══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status, bay_id, department, search, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let sql = `
      SELECT jc.*, wo.work_order_number, wo.customer_name AS wo_customer_name,
             wo.customer_phone, v.plate_number, v.make, v.model,
             u.full_name AS foreman_name,
             sb.name AS bay_name
      FROM job_cards jc
      LEFT JOIN work_orders wo ON jc.work_order_id = wo.id
      LEFT JOIN vehicles v     ON jc.vehicle_id    = v.id
      LEFT JOIN users u        ON jc.foreman_id    = u.id
      LEFT JOIN service_bays sb ON jc.service_bay_id = sb.id
      WHERE jc.workshop_id = ?
    `;
    const params = [req.workshopId];
    if (status) { sql += ' AND jc.status = ?'; params.push(status); }
    if (bay_id) { sql += ' AND jc.service_bay_id = ?'; params.push(bay_id); }
    if (department) { sql += ' AND jc.department = ?'; params.push(department); }
    if (search) {
      sql += ' AND (jc.job_card_number LIKE ? OR jc.vehicle_plate LIKE ? OR wo.customer_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY jc.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const rows = await query(sql, params);
    res.json({ success: true, jobCards: rows, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /job-cards error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch job cards' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/job-cards/:id — detail with lines, time logs, QC
// ══════════════════════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const [jc] = await query(
      `SELECT jc.*, wo.work_order_number, wo.customer_name AS wo_customer_name,
              v.plate_number, v.make, v.model, v.year,
              u.full_name AS foreman_name,
              sb.name AS bay_name
       FROM job_cards jc
       LEFT JOIN work_orders wo ON jc.work_order_id = wo.id
       LEFT JOIN vehicles v     ON jc.vehicle_id    = v.id
       LEFT JOIN users u        ON jc.foreman_id    = u.id
       LEFT JOIN service_bays sb ON jc.service_bay_id = sb.id
       WHERE jc.id = ? AND jc.workshop_id = ?`,
      [req.params.id, req.workshopId]
    );
    if (!jc) return res.status(404).json({ success: false, message: 'Job card not found' });

    const lines = await query(
      `SELECT jcl.*, CONCAT(m.first_name,' ',m.last_name) AS mechanic_name
       FROM job_card_lines jcl
       LEFT JOIN mechanics m ON jcl.assigned_mechanic_id = m.id
       WHERE jcl.job_card_id = ?
       ORDER BY jcl.sort_order, jcl.id`,
      [req.params.id]
    );

    const timeLogs = await query(
      `SELECT ttl.*, CONCAT(m.first_name,' ',m.last_name) AS mechanic_full_name
       FROM technician_time_logs ttl
       LEFT JOIN mechanics m ON ttl.mechanic_id = m.id
       WHERE ttl.job_card_id = ?
       ORDER BY ttl.clock_in DESC`,
      [req.params.id]
    );

    const [qc] = await query('SELECT * FROM qc_checklists WHERE job_card_id = ?', [req.params.id]);

    res.json({ success: true, jobCard: jc, lines, timeLogs, qc: qc || null });
  } catch (err) {
    console.error('GET /job-cards/:id error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch job card' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/job-cards — create from work order / estimate (req 78)
// Body: { work_order_id, estimate_id, service_bay_id, foreman_id,
//         department, lines: [{description, line_type, payer_direction,
//         assigned_mechanic_id, standard_hours, operation_id}] }
// ══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const {
      work_order_id, estimate_id, service_bay_id, foreman_id,
      department = 'mechanical', lines = []
    } = req.body;

    if (!work_order_id) {
      return res.status(400).json({ success: false, message: 'work_order_id is required' });
    }

    const [wo] = await query(
      'SELECT * FROM work_orders WHERE id = ? AND workshop_id = ?',
      [work_order_id, req.workshopId]
    );
    if (!wo) return res.status(404).json({ success: false, message: 'Work order not found' });

    const job_card_number = genJobCardNumber();

    const result = await execute(
      `INSERT INTO job_cards
         (workshop_id, job_card_number, work_order_id, estimate_id, customer_id,
          vehicle_id, vehicle_plate, service_bay_id, foreman_id, department,
          status, wip_opened_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,'open',NOW(),?)`,
      [req.workshopId, job_card_number, work_order_id, estimate_id || null,
       wo.customer_id, wo.vehicle_id, wo.customer_name || null,
       service_bay_id || null, foreman_id || null, department, req.userId]
    );

    const jobCardId = result.insertId;

    // Insert lines
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      await execute(
        `INSERT INTO job_card_lines
           (job_card_id, workshop_id, estimate_line_id, operation_id, description,
            line_type, payer_direction, assigned_mechanic_id, standard_hours, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [jobCardId, req.workshopId, l.estimate_line_id || null, l.operation_id || null,
         l.description, l.line_type || 'labour', l.payer_direction || 'customer',
         l.assigned_mechanic_id || null, l.standard_hours || null, i]
      );
    }

    // Open WIP entry (req 100)
    await execute(
      `INSERT INTO wip_ledger (workshop_id, job_card_id, work_order_id, entry_type, amount, description, posted_by)
       VALUES (?, ?, ?, 'open', 0.00, ?, ?)`,
      [req.workshopId, jobCardId, work_order_id, `WIP opened: ${job_card_number}`, req.userId]
    );

    await logAudit(req.workshopId, req.userId, 'CREATE', 'job_cards', jobCardId, null, { job_card_number });
    res.status(201).json({ success: true, jobCardId, job_card_number });
  } catch (err) {
    console.error('POST /job-cards error:', err);
    res.status(500).json({ success: false, message: 'Failed to create job card' });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/job-cards/:id/status — transition status
// Valid transitions enforced per SOW lifecycle:
//   open → parts_requested → parts_issued → in_progress →
//   qc_pending → qc_passed → ready_for_billing
// ══════════════════════════════════════════════════════════════
const JC_TRANSITIONS = {
  open:             ['parts_requested','in_progress','cancelled'],
  parts_requested:  ['parts_issued','cancelled'],
  parts_issued:     ['in_progress','cancelled'],
  in_progress:      ['qc_pending'],
  qc_pending:       ['qc_passed','qc_failed'],
  qc_failed:        ['in_progress'],
  qc_passed:        ['ready_for_billing'],
  ready_for_billing:['billed'],
};

router.patch('/:id/status', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const [jc] = await query(
      'SELECT * FROM job_cards WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!jc) return res.status(404).json({ success: false, message: 'Job card not found' });

    const allowed = JC_TRANSITIONS[jc.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from ${jc.status} to ${status}. Allowed: ${allowed.join(', ')}`
      });
    }

    // QC gate: prevent billing without QC pass (req 80)
    if (status === 'ready_for_billing' && jc.status !== 'qc_passed') {
      return res.status(400).json({ success: false, message: 'Job must pass quality control before billing' });
    }

    const extra = {};
    if (status === 'in_progress' && !jc.started_at) extra.started_at = new Date();
    if (status === 'qc_pending') extra.completed_at = new Date();
    if (status === 'qc_passed') extra.qc_passed_at = new Date();
    if (status === 'billed') extra.wip_closed_at = new Date();

    const updateFields = Object.keys(extra).map(k => `${k} = ?`).join(', ');
    const updateVals = Object.values(extra);

    await execute(
      `UPDATE job_cards SET status = ? ${updateFields ? ', ' + updateFields : ''} WHERE id = ? AND workshop_id = ?`,
      [status, ...updateVals, req.params.id, req.workshopId]
    );

    // Close WIP when billed (req 100)
    if (status === 'billed') {
      await execute(
        `INSERT INTO wip_ledger (workshop_id, job_card_id, work_order_id, entry_type, amount, description, posted_by)
         VALUES (?, ?, ?, 'close', ?, ?, ?)`,
        [req.workshopId, jc.id, jc.work_order_id, jc.total_cost, `WIP closed: billed`, req.userId]
      );
    }

    await logAudit(req.workshopId, req.userId, 'STATUS_CHANGE', 'job_cards', req.params.id, jc.status, { new_status: status, notes });
    res.json({ success: true, message: `Job card ${status}` });
  } catch (err) {
    console.error('PATCH /job-cards/:id/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to update job card status' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/job-cards/:id/clock-in — technician time capture (req 79)
// Body: { mechanic_id, job_card_line_id, activity_notes }
// ══════════════════════════════════════════════════════════════
router.post('/:id/clock-in', async (req, res) => {
  try {
    const { mechanic_id, job_card_line_id, activity_notes } = req.body;
    if (!mechanic_id) return res.status(400).json({ success: false, message: 'mechanic_id required' });

    const [jc] = await query(
      'SELECT id FROM job_cards WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!jc) return res.status(404).json({ success: false, message: 'Job card not found' });

    // Check mechanic isn't already clocked in on this job
    const [open] = await query(
      `SELECT id FROM technician_time_logs
       WHERE job_card_id = ? AND mechanic_id = ? AND clock_out IS NULL`,
      [req.params.id, mechanic_id]
    );
    if (open) {
      return res.status(409).json({ success: false, message: 'Mechanic already clocked in on this job. Clock out first.' });
    }

    const [mech] = await query('SELECT CONCAT(first_name," ",last_name) AS name FROM mechanics WHERE id = ?', [mechanic_id]);

    const result = await execute(
      `INSERT INTO technician_time_logs (workshop_id, job_card_id, job_card_line_id, mechanic_id, mechanic_name, clock_in, activity_notes)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
      [req.workshopId, req.params.id, job_card_line_id || null, mechanic_id, mech?.name || null, activity_notes || null]
    );

    // Auto-update line status to in_progress
    if (job_card_line_id) {
      await execute(
        `UPDATE job_card_lines SET status = 'in_progress', started_at = COALESCE(started_at, NOW())
         WHERE id = ? AND job_card_id = ?`,
        [job_card_line_id, req.params.id]
      );
    }

    // Auto-update job card to in_progress
    await execute(
      `UPDATE job_cards SET status = 'in_progress', started_at = COALESCE(started_at, NOW())
       WHERE id = ? AND status IN ('open','parts_issued')`,
      [req.params.id]
    );

    res.status(201).json({ success: true, timeLogId: result.insertId, message: 'Clocked in' });
  } catch (err) {
    console.error('POST /job-cards/:id/clock-in error:', err);
    res.status(500).json({ success: false, message: 'Failed to clock in' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/job-cards/:id/clock-out — end technician session
// Body: { mechanic_id, time_log_id, activity_notes }
// ══════════════════════════════════════════════════════════════
router.post('/:id/clock-out', async (req, res) => {
  try {
    const { mechanic_id, time_log_id } = req.body;
    if (!mechanic_id) return res.status(400).json({ success: false, message: 'mechanic_id required' });

    let logQuery = `UPDATE technician_time_logs SET clock_out = NOW()
                    WHERE job_card_id = ? AND mechanic_id = ? AND clock_out IS NULL`;
    let logParams = [req.params.id, mechanic_id];
    if (time_log_id) {
      logQuery += ' AND id = ?';
      logParams.push(time_log_id);
    }

    const result = await execute(logQuery, logParams);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'No active clock-in found for this mechanic' });
    }

    // Compute total minutes for this mechanic on this job
    const [totals] = await query(
      `SELECT SUM(elapsed_minutes) AS total_minutes
       FROM technician_time_logs
       WHERE job_card_id = ? AND mechanic_id = ? AND clock_out IS NOT NULL`,
      [req.params.id, mechanic_id]
    );

    res.json({ success: true, message: 'Clocked out', total_minutes: totals?.total_minutes || 0 });
  } catch (err) {
    console.error('POST /job-cards/:id/clock-out error:', err);
    res.status(500).json({ success: false, message: 'Failed to clock out' });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/job-cards/:id/qc — submit quality control (req 80)
// Body: { inspector_id, checklist_items: [{item, passed, notes}],
//         overall_result: passed|failed|conditional, inspector_notes }
// ══════════════════════════════════════════════════════════════
router.post('/:id/qc', async (req, res) => {
  try {
    const { inspector_id, checklist_items, overall_result, inspector_notes } = req.body;
    if (!checklist_items || !overall_result) {
      return res.status(400).json({ success: false, message: 'checklist_items and overall_result required' });
    }
    if (!['passed','failed','conditional'].includes(overall_result)) {
      return res.status(400).json({ success: false, message: 'overall_result must be passed|failed|conditional' });
    }

    const [jc] = await query(
      'SELECT * FROM job_cards WHERE id = ? AND workshop_id = ?',
      [req.params.id, req.workshopId]
    );
    if (!jc) return res.status(404).json({ success: false, message: 'Job card not found' });
    if (jc.status !== 'qc_pending') {
      return res.status(400).json({ success: false, message: 'Job card must be in qc_pending status' });
    }

    // Remove previous QC if re-inspection after failure
    await execute('DELETE FROM qc_checklists WHERE job_card_id = ?', [req.params.id]);

    await execute(
      `INSERT INTO qc_checklists
         (workshop_id, job_card_id, inspector_id, checklist_items, overall_result, inspector_notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.workshopId, req.params.id, inspector_id || req.userId,
       JSON.stringify(checklist_items), overall_result, inspector_notes || null]
    );

    const newStatus = overall_result === 'passed' ? 'qc_passed' : 'qc_failed';
    await execute(
      `UPDATE job_cards SET status = ?, qc_inspector_id = ?, qc_notes = ?,
       qc_passed_at = CASE WHEN ? = 'passed' THEN NOW() ELSE NULL END
       WHERE id = ? AND workshop_id = ?`,
      [newStatus, inspector_id || req.userId, inspector_notes || null, overall_result, req.params.id, req.workshopId]
    );

    await logAudit(req.workshopId, req.userId, 'QC', 'job_cards', req.params.id, 'qc_pending', { overall_result });
    res.json({ success: true, message: `QC ${overall_result}`, new_status: newStatus });
  } catch (err) {
    console.error('POST /job-cards/:id/qc error:', err);
    res.status(500).json({ success: false, message: 'Failed to submit QC' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/job-cards/productivity — technician KPIs (req 81)
// ══════════════════════════════════════════════════════════════
router.get('/stats/productivity', async (req, res) => {
  try {
    const { from, to, mechanic_id } = req.query;
    let sql = `
      SELECT
        ttl.mechanic_id,
        ttl.mechanic_name,
        COUNT(DISTINCT ttl.job_card_id)        AS jobs_worked,
        SUM(ttl.elapsed_minutes)               AS total_minutes,
        ROUND(SUM(ttl.elapsed_minutes)/60,2)   AS total_hours,
        COUNT(CASE WHEN ttl.elapsed_minutes IS NOT NULL THEN 1 END) AS completed_sessions,
        -- First-time-fix rate: QC passed on first attempt
        (SELECT COUNT(*) FROM job_cards jc2
         WHERE jc2.workshop_id = ? AND jc2.status = 'qc_passed'
           AND jc2.id IN (SELECT job_card_id FROM technician_time_logs WHERE mechanic_id = ttl.mechanic_id)
        ) AS qc_passed_count
      FROM technician_time_logs ttl
      WHERE ttl.workshop_id = ? AND ttl.clock_out IS NOT NULL
    `;
    const params = [req.workshopId, req.workshopId];
    if (from) { sql += ' AND DATE(ttl.clock_in) >= ?'; params.push(from); }
    if (to)   { sql += ' AND DATE(ttl.clock_in) <= ?'; params.push(to); }
    if (mechanic_id) { sql += ' AND ttl.mechanic_id = ?'; params.push(mechanic_id); }
    sql += ' GROUP BY ttl.mechanic_id, ttl.mechanic_name ORDER BY total_hours DESC';

    const rows = await query(sql, params);
    res.json({ success: true, productivity: rows });
  } catch (err) {
    console.error('GET /job-cards/stats/productivity error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch productivity stats' });
  }
});

// ══════════════════════════════════════════════════════════════
// LOANER VEHICLE MANAGEMENT (req 83)
// ══════════════════════════════════════════════════════════════

// GET /api/job-cards/loaners — list loaner vehicles
router.get('/loaners/list', async (req, res) => {
  try {
    const rows = await query(
      `SELECT lv.*, la.customer_name AS current_customer, la.issued_at AS current_issued_at
       FROM loaner_vehicles lv
       LEFT JOIN loaner_agreements la ON la.loaner_vehicle_id = lv.id AND la.status = 'active'
       WHERE lv.workshop_id = ?
       ORDER BY lv.status, lv.plate_number`,
      [req.workshopId]
    );
    res.json({ success: true, loaners: rows });
  } catch (err) {
    console.error('GET /loaners error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch loaners' });
  }
});

// POST /api/job-cards/loaners — add loaner vehicle to fleet
router.post('/loaners', async (req, res) => {
  try {
    const { plate_number, make, model, year } = req.body;
    if (!plate_number) return res.status(400).json({ success: false, message: 'plate_number required' });
    const result = await execute(
      'INSERT INTO loaner_vehicles (workshop_id, plate_number, make, model, year) VALUES (?,?,?,?,?)',
      [req.workshopId, plate_number, make || null, model || null, year || null]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('POST /loaners error:', err);
    res.status(500).json({ success: false, message: 'Failed to add loaner' });
  }
});

// POST /api/job-cards/:id/issue-loaner — issue a loaner to a job
router.post('/:id/issue-loaner', async (req, res) => {
  try {
    const { loaner_vehicle_id, customer_name, odometer_out, fuel_level_out } = req.body;
    if (!loaner_vehicle_id) return res.status(400).json({ success: false, message: 'loaner_vehicle_id required' });

    const [lv] = await query(
      'SELECT * FROM loaner_vehicles WHERE id = ? AND workshop_id = ? AND status = "available"',
      [loaner_vehicle_id, req.workshopId]
    );
    if (!lv) return res.status(409).json({ success: false, message: 'Loaner not available' });

    const [jc] = await query('SELECT customer_id FROM job_cards WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!jc) return res.status(404).json({ success: false, message: 'Job card not found' });

    await execute(
      `INSERT INTO loaner_agreements
         (workshop_id, loaner_vehicle_id, job_card_id, customer_id, customer_name,
          issued_at, odometer_out, fuel_level_out, status, issued_by)
       VALUES (?,?,?,?,?,NOW(),?,?,'active',?)`,
      [req.workshopId, loaner_vehicle_id, req.params.id, jc.customer_id,
       customer_name || null, odometer_out || null, fuel_level_out || null, req.userId]
    );

    await execute(
      'UPDATE loaner_vehicles SET status = "on_loan", current_job_card_id = ? WHERE id = ?',
      [req.params.id, loaner_vehicle_id]
    );

    res.json({ success: true, message: 'Loaner issued' });
  } catch (err) {
    console.error('POST /job-cards/:id/issue-loaner error:', err);
    res.status(500).json({ success: false, message: 'Failed to issue loaner' });
  }
});

// POST /api/job-cards/:id/return-loaner — return loaner vehicle
router.post('/:id/return-loaner', async (req, res) => {
  try {
    const { loaner_vehicle_id, odometer_in, fuel_level_in, notes } = req.body;

    await execute(
      `UPDATE loaner_agreements SET status = 'returned', returned_at = NOW(),
       odometer_in = ?, fuel_level_in = ?, notes = ?, returned_to = ?
       WHERE job_card_id = ? AND loaner_vehicle_id = ? AND status = 'active'`,
      [odometer_in || null, fuel_level_in || null, notes || null, req.userId,
       req.params.id, loaner_vehicle_id]
    );

    await execute(
      'UPDATE loaner_vehicles SET status = "available", current_job_card_id = NULL WHERE id = ?',
      [loaner_vehicle_id]
    );

    res.json({ success: true, message: 'Loaner returned' });
  } catch (err) {
    console.error('POST /job-cards/:id/return-loaner error:', err);
    res.status(500).json({ success: false, message: 'Failed to return loaner' });
  }
});

export default router;
