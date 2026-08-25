-- In-app notifications were completely non-functional: the table was never
-- created, because the only CREATE TABLE for it lives inside
-- lib/push.js ensurePushTable(), which is exported and never called. Every
-- route in routes/user-notifications.js returned 500, the notification bell
-- polled a failing endpoint forever, and lib/notify.js, lib/push.js,
-- lib/job-delay-checker.js and routes/mechanic-app.js all wrote to a table that
-- did not exist.
--
-- Column naming was also split down the middle. The schema and the writer used
-- tenant_id / order_id; the reader and the delay checker used workshop_id /
-- work_order_id. This settles on workshop_id and work_order_id, matching every
-- other table in the platform after the delivery->workshop rename.
--
-- Idempotent, and safe on a deployment where the old spelling already exists.

-- 1. Create with the correct column names when absent.
CREATE TABLE IF NOT EXISTS user_notifications (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id    INT NOT NULL,
  user_id        INT NOT NULL,
  title          VARCHAR(255) NOT NULL,
  body           TEXT NOT NULL,
  type           VARCHAR(50)  DEFAULT 'info',
  icon           VARCHAR(32)  DEFAULT '🔔',
  link           VARCHAR(500) DEFAULT NULL,
  work_order_id  INT          DEFAULT NULL,
  is_read        BOOLEAN      DEFAULT FALSE,
  created_at     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  read_at        TIMESTAMP    NULL,
  KEY idx_un_user    (user_id, is_read),
  KEY idx_un_ws      (workshop_id),
  KEY idx_un_dedup   (user_id, work_order_id, type, created_at),
  KEY idx_un_history (work_order_id, type, created_at),
  KEY idx_un_cleanup (is_read, created_at),
  CONSTRAINT fk_un_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  CONSTRAINT fk_un_user     FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 2. An older table may already exist with tenant_id / order_id. Rename rather
--    than recreate, so existing notifications are not lost.
SET @has_tenant := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'user_notifications' AND column_name = 'tenant_id');
SET @sql := IF(@has_tenant > 0,
  'ALTER TABLE user_notifications CHANGE tenant_id workshop_id INT NOT NULL',
  'SELECT "workshop_id already named correctly" AS note');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @has_order := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'user_notifications' AND column_name = 'order_id');
SET @sql := IF(@has_order > 0,
  'ALTER TABLE user_notifications CHANGE order_id work_order_id INT DEFAULT NULL',
  'SELECT "work_order_id already named correctly" AS note');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
