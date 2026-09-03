-- Google Form → Customer Survey ingest.
--
-- An Apps Script trigger can fire more than once for the same submission:
-- Google retries a failing trigger, and someone re-running the backfill by
-- hand is entirely normal. Without a stable key from Google's side, each retry
-- would insert another row and quietly inflate every score on the dashboard.
--
-- external_id holds Google's own response id, unique per workshop, so the
-- ingest can be safely repeated — the second attempt updates instead of
-- inserting.
--
-- Nullable and unique-with-NULLs-allowed on purpose: responses that come from
-- the in-app survey have no external id, and MySQL permits many NULLs in a
-- unique index.
--
-- Idempotent: only adds what is missing.

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'survey_responses'
     AND column_name  = 'external_id'
);
SET @sql := IF(@has_col = 0,
  'ALTER TABLE survey_responses ADD COLUMN external_id VARCHAR(128) NULL AFTER source',
  'SELECT "survey_responses.external_id already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name   = 'survey_responses'
     AND index_name   = 'uniq_survey_workshop_external'
);
SET @sql := IF(@has_idx = 0,
  'ALTER TABLE survey_responses ADD UNIQUE KEY uniq_survey_workshop_external (workshop_id, external_id)',
  'SELECT "survey_responses external id index already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The raw question/answer payload as Google sent it. Mapping question titles
-- to columns is best-effort — a title edited in the Form would stop matching —
-- so the original is kept and nothing is ever lost, even when a question could
-- not be mapped.
SET @has_raw := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'survey_responses'
     AND column_name  = 'raw_payload'
);
SET @sql := IF(@has_raw = 0,
  'ALTER TABLE survey_responses ADD COLUMN raw_payload JSON NULL',
  'SELECT "survey_responses.raw_payload already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
