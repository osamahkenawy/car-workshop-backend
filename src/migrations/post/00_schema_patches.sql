-- Idempotent schema patches applied after base schema import.
-- These add columns/tables that newer backend code expects but that may be
-- missing from older `car_workshop.sql` snapshots.
--
-- Run order: this file is named 00_ so it executes before any seeds in the
-- same directory.

-- ── workshops ────────────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'subdomain');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN subdomain VARCHAR(100) NULL UNIQUE', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'settings');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN settings JSON NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'industry');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN industry VARCHAR(100) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'company_lat');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN company_lat DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'company_lng');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN company_lng DECIMAL(10,7) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Virtual is_active column derived from status enum (used by stale/accept jobs)
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'is_active');
SET @sql := IF(@col = 0,
  'ALTER TABLE workshops ADD COLUMN is_active TINYINT(1) GENERATED ALWAYS AS (CASE WHEN status IN (''active'',''trial'') THEN 1 ELSE 0 END) VIRTUAL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── users ──────────────────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'email_verified');
SET @sql := IF(@col = 0, 'ALTER TABLE users ADD COLUMN email_verified TINYINT(1) DEFAULT 0', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role_id');
SET @sql := IF(@col = 0, 'ALTER TABLE users ADD COLUMN role_id INT DEFAULT NULL AFTER role', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'password_reset_token');
SET @sql := IF(@col = 0, 'ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'password_reset_expires');
SET @sql := IF(@col = 0, 'ALTER TABLE users ADD COLUMN password_reset_expires DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── countries (used by public signup) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS countries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  iso VARCHAR(3) NOT NULL UNIQUE,
  phone_code VARCHAR(10) NOT NULL,
  flag VARCHAR(10) NULL,
  region VARCHAR(50) NULL,
  sort_order INT DEFAULT 999,
  is_active TINYINT(1) DEFAULT 1
) DEFAULT CHARSET=utf8mb4;
