-- ═══════════════════════════════════════════════════════════════════════
-- Team Leader: the missing link between a job card and the person who
-- actually puts a technician on it.
--
-- The flow this supports (2026-09-14 meeting): a work order is created,
-- goes out for estimate approval, comes back approved, and then sits
-- waiting for someone to put a technician on it. That someone is the team
-- leader — not the service advisor, not an auto-assigner. When they assign,
-- they also book the window the technician is expected to work: start
-- date/time through end date/time.
--
-- Three things were missing for that:
--
--   1. A team_leader role. The roles table had eight; none of them was the
--      person who owns a group of technicians. Workshop Foreman was close
--      on access but is a different job, and is already assigned to real
--      people, so it is left alone rather than renamed underneath them.
--
--   2. A way to say which technicians are whose. `mechanics` had
--      service_bay_id and specialty but nothing pointing at a leader, so
--      "his technicians" could not be answered at all.
--
--   3. Somewhere to put the booked window. work_order_assignments already
--      records who assigned whom and when they accepted (945 rows live),
--      but only `assigned_at` — the moment the assignment was made. That is
--      not the same as the shift the technician is booked for, which is
--      what the team leader is actually deciding.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. mechanics.team_leader_id ────────────────────────────────────────
-- Points at users.id, not mechanics.id: a team leader signs in to see
-- their board, so they are a user account. A leader who also turns
-- spanners simply has a mechanics row of their own as well.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'mechanics' AND column_name = 'team_leader_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE mechanics ADD COLUMN team_leader_id INT NULL COMMENT ''users.id of the team leader who owns this technician'' AFTER service_bay_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'mechanics' AND index_name = 'idx_mechanics_team_leader');
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_mechanics_team_leader ON mechanics (workshop_id, team_leader_id)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. work_order_assignments: the booked window ───────────────────────
-- Nullable on purpose. The 945 existing rows were assigned before booking
-- existed and have no window to backfill; inventing one would be worse
-- than leaving it blank, and every read below treats NULL as "not booked".
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_order_assignments' AND column_name = 'scheduled_start_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE work_order_assignments ADD COLUMN scheduled_start_at DATETIME NULL COMMENT ''booked start of the technician window'' AFTER assigned_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_order_assignments' AND column_name = 'scheduled_end_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE work_order_assignments ADD COLUMN scheduled_end_at DATETIME NULL COMMENT ''booked end of the technician window'' AFTER scheduled_start_at',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Availability answers "is this technician booked against right now", which
-- is a range scan over the booked window for one technician.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'work_order_assignments' AND index_name = 'idx_woa_booking');
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_woa_booking ON work_order_assignments (mechanic_id, is_current, scheduled_start_at)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. The team_leader role ────────────────────────────────────────────
-- Modules mirror what the job needs and nothing else: their own board, the
-- job cards they assign from, the technicians they own, and the live
-- service status. Deliberately no invoices, no pricing, no reports —
-- a team leader runs a bay, not the P&L.
INSERT INTO roles (workshop_id, name, name_ar, slug, description, modules, is_system, is_active)
SELECT w.id, 'Team Leader', 'قائد الفريق', 'team_leader',
       'Owns a group of technicians. Assigns job cards to them and books their working window.',
       JSON_ARRAY('dashboard','notifications','team-leader','work-orders','job-assignment','mechanics','service-status'),
       0, 1
  FROM workshops w
 WHERE NOT EXISTS (
   SELECT 1 FROM roles r WHERE r.workshop_id = w.id AND r.slug = 'team_leader'
 );
