-- ═══════════════════════════════════════════════════════════════════════
-- service_estimates: approval_token / approval_token_expires_at / sent_to_customer_at
--
-- The estimate lifecycle already exists end to end — draft, per-line
-- customer_status, status rollup, convert-to-work-order — but every mutating
-- route sits behind authMiddleware (routes/estimates.js: `router.use
-- (authMiddleware)`). A customer clicking a link in an email is not logged
-- in and never will be, so there is no column anywhere to identify which
-- estimate an anonymous request is even about, safely.
--
-- Mirrors survey_invites.token exactly (post/05_customer_survey.sql): a
-- random opaque token, checked instead of an auto-increment id so the link
-- cannot be walked by guessing adjacent numbers, plus an expiry so an old,
-- unactioned email cannot approve months of parts and labour at a price
-- that has since changed.
--
-- sent_to_customer_at is separate from status='sent_to_customer' (which
-- already exists) because status changes again the moment a decision comes
-- back — approved/partially_approved/rejected — while "when was this sent"
-- needs to survive that transition for the audit trail and for expiry math
-- that has to run from when it was sent, not from whatever status happens
-- to be sitting there now.
-- ═══════════════════════════════════════════════════════════════════════
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'service_estimates' AND column_name = 'approval_token');
SET @sql := IF(@col = 0, 'ALTER TABLE service_estimates ADD COLUMN approval_token VARCHAR(64) NULL AFTER status', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'service_estimates' AND column_name = 'approval_token_expires_at');
SET @sql := IF(@col = 0, 'ALTER TABLE service_estimates ADD COLUMN approval_token_expires_at DATETIME NULL AFTER approval_token', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'service_estimates' AND column_name = 'sent_to_customer_at');
SET @sql := IF(@col = 0, 'ALTER TABLE service_estimates ADD COLUMN sent_to_customer_at DATETIME NULL AFTER approval_token_expires_at', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Looked up by the public link on every page view and every line decision,
-- so this is a hot lookup, not an occasional one.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'service_estimates' AND index_name = 'idx_estimate_approval_token');
SET @sql := IF(@idx = 0, 'CREATE UNIQUE INDEX idx_estimate_approval_token ON service_estimates (approval_token)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
