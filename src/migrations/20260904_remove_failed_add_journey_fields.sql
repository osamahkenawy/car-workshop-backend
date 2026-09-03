-- Two changes, applied together:
--
-- 1. Removes 'failed' as a distinct work_orders.status outcome. A workshop
--    job that doesn't complete is now just 'cancelled' — failure_reason
--    still records why. Any existing 'failed' rows are moved to 'cancelled'
--    (with the reason preserved) BEFORE the ENUM is narrowed, since MySQL
--    would otherwise coerce a row holding a value no longer in the ENUM to
--    an empty string.
--
-- 2. Adds six nullable checkpoint timestamps to work_orders for the wider
--    12-step service-delivery journey (intake inspection, job card signed,
--    diagnosed, estimate approved, joint inspection, invoiced) — see the
--    comment above the status ENUM in car_workshop.sql. These sit alongside
--    the existing status pipeline rather than replacing it, so nothing that
--    reads/writes `status` needs to change for this part.
--
-- Idempotent — safe to re-run.

-- ── Part 1: move any 'failed' rows to 'cancelled', then narrow the ENUMs ──

SET @has_failed_wo := (
  SELECT COUNT(*) FROM work_orders WHERE status = 'failed'
);
SET @sql := IF(@has_failed_wo > 0,
  "UPDATE work_orders SET status = 'cancelled', failure_reason = CONCAT('Previously failed. ', COALESCE(failure_reason, '')) WHERE status = 'failed'",
  'SELECT "no work_orders rows with status=failed" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_failed_logs := (
  SELECT COUNT(*) FROM work_order_status_logs WHERE status = 'failed'
);
SET @sql := IF(@has_failed_logs > 0,
  "UPDATE work_order_status_logs SET status = 'cancelled' WHERE status = 'failed'",
  'SELECT "no work_order_status_logs rows with status=failed" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @wo_has_failed_enum := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'work_orders'
     AND column_name  = 'status'
     AND COLUMN_TYPE LIKE '%failed%'
);
SET @sql := IF(@wo_has_failed_enum > 0,
  "ALTER TABLE work_orders MODIFY status ENUM(
     'pending','confirmed','assigned','accepted','in_progress',
     'inspection','ready_for_pickup','completed','cancelled'
   ) DEFAULT 'pending'",
  'SELECT "work_orders.status already excludes failed" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @logs_has_failed_enum := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'work_order_status_logs'
     AND column_name  = 'status'
     AND COLUMN_TYPE LIKE '%failed%'
);
SET @sql := IF(@logs_has_failed_enum > 0,
  "ALTER TABLE work_order_status_logs MODIFY status ENUM(
     'pending','confirmed','assigned','accepted','in_progress',
     'inspection','ready_for_pickup','completed','cancelled'
   ) NOT NULL",
  'SELECT "work_order_status_logs.status already excludes failed" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Part 2: add the journey checkpoint columns (each guarded individually) ──

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'intake_inspection_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN intake_inspection_at DATETIME DEFAULT NULL COMMENT 'Journey step 3: intake inspection done'", 'SELECT "intake_inspection_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'job_card_signed_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN job_card_signed_at DATETIME DEFAULT NULL COMMENT 'Journey step 4: customer signed the job card (hard gate)'", 'SELECT "job_card_signed_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'diagnosed_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN diagnosed_at DATETIME DEFAULT NULL COMMENT 'Journey step 5: test drive & diagnosis done'", 'SELECT "diagnosed_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'estimate_approved_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN estimate_approved_at DATETIME DEFAULT NULL COMMENT 'Journey step 6: customer approved the cost estimate (hard gate)'", 'SELECT "estimate_approved_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'joint_inspection_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN joint_inspection_at DATETIME DEFAULT NULL COMMENT 'Journey step 9: joint inspection with customer done'", 'SELECT "joint_inspection_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'invoiced_at');
SET @sql := IF(@has_col = 0, "ALTER TABLE work_orders ADD COLUMN invoiced_at DATETIME DEFAULT NULL COMMENT 'Journey step 10: invoice issued'", 'SELECT "invoiced_at exists" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
