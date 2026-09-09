-- ═══════════════════════════════════════════════════════════════════════
-- Complaints — severity classification and closure-workflow columns
--
-- Brings `disputes` in line with the workshop's actual complaint-management
-- policy (severity S1/S2/S3, working-day SLAs by severity, root cause
-- mandatory before closing S1, closure gated on the CUSTOMER confirming the
-- outcome rather than staff finishing the paperwork, and a lightweight
-- repeat-complaint flag that forces S1 per policy).
--
-- Every ALTER is guarded by an information_schema check, so this file is
-- safe to re-run — same convention as post/03_customer_journey.sql.
-- ═══════════════════════════════════════════════════════════════════════

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'severity');
SET @sql := IF(@col = 0,
  "ALTER TABLE disputes ADD COLUMN severity ENUM('S1','S2','S3') NOT NULL DEFAULT 'S2' COMMENT 'S1 safety/repeat, S2 workmanship/billing, S3 conduct/information'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'is_repeat');
SET @sql := IF(@col = 0,
  "ALTER TABLE disputes ADD COLUMN is_repeat TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Second complaint on this customer within 90 days \u2014 forces S1 per policy'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'root_cause');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN root_cause TEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'root_cause_category');
SET @sql := IF(@col = 0,
  "ALTER TABLE disputes ADD COLUMN root_cause_category ENUM('method','machine','material','manpower','measurement','environment') NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'corrective_action');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN corrective_action TEXT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'corrective_action_owner');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN corrective_action_owner INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'corrective_action_due_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN corrective_action_due_at DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'corrective_action_closed_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN corrective_action_closed_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'customer_confirmed_at');
SET @sql := IF(@col = 0,
  "ALTER TABLE disputes ADD COLUMN customer_confirmed_at DATETIME NULL COMMENT 'The actual close gate \u2014 a case is closed only once the customer confirms, not when work finishes'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'escalated_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN escalated_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND index_name = 'idx_disputes_severity');
SET @sql := IF(@idx = 0, 'ALTER TABLE disputes ADD INDEX idx_disputes_severity (severity, status)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
