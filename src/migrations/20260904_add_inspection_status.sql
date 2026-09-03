-- Adds an 'inspection' step to the work order status lifecycle, between
-- 'in_progress' and 'ready_for_pickup': a mechanic finishes the job, it goes
-- through inspection/QC, then gets marked ready for pickup.
--
-- Safe to run on a populated table: every current value is kept, widening
-- an ENUM does not rewrite or reinterpret existing rows.
--
-- Idempotent: only alters while 'inspection' is absent from the column type.

SET @needs_widening := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'work_orders'
     AND column_name  = 'status'
     AND COLUMN_TYPE NOT LIKE '%inspection%'
);

SET @sql := IF(@needs_widening > 0,
  "ALTER TABLE work_orders MODIFY status ENUM(
     'pending','confirmed','assigned','accepted','in_progress',
     'inspection','ready_for_pickup','completed','failed','cancelled'
   ) DEFAULT 'pending'",
  'SELECT "work_orders.status already includes inspection" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @needs_widening_logs := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'work_order_status_logs'
     AND column_name  = 'status'
     AND COLUMN_TYPE NOT LIKE '%inspection%'
);

SET @sql := IF(@needs_widening_logs > 0,
  "ALTER TABLE work_order_status_logs MODIFY status ENUM(
     'pending','confirmed','assigned','accepted','in_progress',
     'inspection','ready_for_pickup','completed','failed','cancelled'
   ) NOT NULL",
  'SELECT "work_order_status_logs.status already includes inspection" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
