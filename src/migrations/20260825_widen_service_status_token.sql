-- SR-08 — service-status tokens go from 48 bits (12 hex chars) to 128 bits
-- (32 hex chars). work_orders.service_status_token is already varchar(100), but
-- pregenerated_tokens.service_status_token is varchar(20) and would silently
-- truncate a new token — which would collapse the entropy right back down.
--
-- Idempotent: only alters when the column is still too narrow.
SET @needs_widen := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'pregenerated_tokens'
     AND column_name  = 'service_status_token'
     AND CHARACTER_MAXIMUM_LENGTH < 64
);
SET @sql := IF(@needs_widen > 0,
  'ALTER TABLE pregenerated_tokens MODIFY service_status_token VARCHAR(64) NOT NULL',
  'SELECT "pregenerated_tokens.service_status_token already wide enough" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
