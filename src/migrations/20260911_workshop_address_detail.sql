-- ═══════════════════════════════════════════════════════════════════════
-- workshops: building_name / floor / office_number / area
--
-- These four are read by GET /api/settings (routes/settings.js selects them
-- by name) and written by PUT /api/settings (they're in
-- allowedWorkshopFields), and Settings.jsx has an input bound to each. But
-- no migration ever created them, so the SELECT failed with
--   Unknown column 'building_name' in 'field list'
-- and the whole endpoint returned "Failed to fetch settings" — which made
-- the entire Settings page load blank, not just the address fields, because
-- the page has nothing to render without that response.
--
-- Adding the columns rather than trimming the query: the frontend collects
-- all four deliberately (building, floor, office, area alongside the
-- existing free-text `address`), so the intent is clearly that they persist.
-- ═══════════════════════════════════════════════════════════════════════
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'building_name');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN building_name VARCHAR(255) NULL AFTER address', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'floor');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN floor VARCHAR(50) NULL AFTER building_name', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'office_number');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN office_number VARCHAR(50) NULL AFTER floor', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'workshops' AND column_name = 'area');
SET @sql := IF(@col = 0, 'ALTER TABLE workshops ADD COLUMN area VARCHAR(150) NULL AFTER office_number', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
