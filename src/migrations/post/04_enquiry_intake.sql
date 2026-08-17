-- ═══════════════════════════════════════════════════════════════════════════
--  Enquiry intake from external sources (website landing pages, campaigns)
--
--  Adds the fields an inbound web lead carries that the internal enquiry form
--  does not: the sender's own reference (used for idempotency so a retrying
--  landing page cannot create duplicates), the requested appointment date,
--  the branch and service as the website labelled them, and the raw payload
--  kept verbatim for audit.
--
--  Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- Sender's own reference, e.g. "PIO-20260817-0001".
-- Unique per workshop: a repeated push of the same reference returns the
-- existing enquiry instead of creating another one.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'external_reference');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN external_reference VARCHAR(100) NULL AFTER enquiry_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND index_name = 'uq_enquiry_external_ref');
SET @sql := IF(@idx = 0, 'ALTER TABLE enquiries ADD UNIQUE KEY uq_enquiry_external_ref (workshop_id, external_reference)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Requested appointment date from the website form
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'preferred_date');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN preferred_date DATE NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Branch and service exactly as the website labelled them. The API key already
-- determines which workshop the enquiry belongs to, so branch is descriptive
-- only — it is not used for routing.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'branch');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN branch VARCHAR(120) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'service_requested');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN service_requested VARCHAR(200) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Vehicle detail as supplied (a vehicle record may not exist yet)
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'vehicle_plate');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN vehicle_plate VARCHAR(30) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Where the enquiry came from: 'internal' for staff-entered, 'api' for pushed in
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'intake_origin');
SET @sql := IF(@col = 0, "ALTER TABLE enquiries ADD COLUMN intake_origin ENUM('internal','api') DEFAULT 'internal'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Verbatim payload for audit / replay when a mapping question comes up later
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND column_name = 'raw_payload');
SET @sql := IF(@col = 0, 'ALTER TABLE enquiries ADD COLUMN raw_payload JSON NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'enquiries' AND index_name = 'idx_enquiry_intake_origin');
SET @sql := IF(@idx = 0, 'ALTER TABLE enquiries ADD INDEX idx_enquiry_intake_origin (intake_origin)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
