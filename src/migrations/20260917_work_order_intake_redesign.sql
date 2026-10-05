-- ═══════════════════════════════════════════════════════════════════════
-- Work order intake, redesigned to the approved process
-- (pioneer-workshop-wo-process, 15 Sep 2026)
--
-- Step 1 of the job card wizard splits the customer two ways before
-- anything else is asked:
--
--   Internal  →  Fleet | Insurance | Asset   → pick from the account list
--   External  →  Existing | Walk-in          → pick, or key in on the spot
--
-- `customers` could not express that. It has `type`
-- (individual/business/corporate/insurance/fleet/other) which conflates
-- the legal form of the customer with their commercial relationship to
-- us, and `client_category`, which reads 'other' on 3,452 of 3,472 rows
-- and so carries no information at all. Neither says internal vs
-- external, and neither can: an insurance company is external, Pioneer's
-- own asset pool is internal, and both would sit under the same `type`.
--
-- So this adds the two axes the process actually turns on, leaving `type`
-- and `client_category` untouched for whatever still reads them.
--
-- Nothing here is destructive and nothing is NOT NULL. That is deliberate
-- and worth stating plainly, because the new form makes VIN, mileage and
-- the complaint mandatory:
--
--   * 5,694 of 5,944 vehicles (96%) have no VIN on file.
--   * 18,506 of 18,730 work orders (99%) have no description.
--
-- A NOT NULL column would either refuse to apply or demand 5,694 rows of
-- invented chassis numbers. Mandatory is therefore enforced where the
-- data is actually being entered — the wizard and the create endpoint —
-- and the columns stay nullable so the twenty thousand rows of history
-- remain readable. An old vehicle with no VIN is not corrected by
-- fabricating one; it is corrected the next time that car comes in, which
-- is exactly when the new form asks for it.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. customers.customer_class — internal vs external ─────────────────
-- Defaults to 'external', which is true of 3,424 of the 3,472 rows: the
-- fleet and insurance accounts are the exception, not the rule. Section 5
-- below promotes the known internal accounts by name.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'customer_class');
SET @sql := IF(@col = 0,
  'ALTER TABLE customers ADD COLUMN customer_class ENUM(''internal'',''external'') NOT NULL DEFAULT ''external'' COMMENT ''Step 1 main category: company fleet/assets/inter-functional vs walk-in and third parties'' AFTER type',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2. customers.customer_subcategory ──────────────────────────────────
-- Internal splits three ways (fleet / insurance / asset). External splits
-- the same way minus asset, plus walk-in — per the whiteboard, where the
-- external column reads "Fleet / Insurance / walkin". Kept as one column
-- rather than two because a customer has exactly one of these, and which
-- values are offered is a function of the class, which the UI enforces.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'customer_subcategory');
SET @sql := IF(@col = 0,
  'ALTER TABLE customers ADD COLUMN customer_subcategory ENUM(''fleet'',''insurance'',''asset'',''walkin'') NULL COMMENT ''Step 1 subcategory; asset is internal-only, walkin external-only'' AFTER customer_class',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 3. customers.code — the account code shown in the wizard ───────────
-- AST-001, INS-001 and so on. The mockup displays this on the Selected
-- Customer panel, and it is how the fleet desk refers to accounts on the
-- phone. Not unique at the database level: two workshops could legitimately
-- use the same code, and enforcing uniqueness across all 3,472 rows where
-- the column is still empty would be a constraint on nothing.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'customers' AND column_name = 'code');
SET @sql := IF(@col = 0,
  'ALTER TABLE customers ADD COLUMN code VARCHAR(50) NULL COMMENT ''Account code, e.g. AST-001 / INS-001; shown in the job card wizard'' AFTER customer_subcategory',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'customers' AND index_name = 'idx_customers_code');
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_customers_code ON customers (workshop_id, code)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The wizard's customer list is always "this class, this subcategory,
-- this workshop, active only" — worth an index, since the fleet desk
-- opens it on every single job card.
SET @idx := (SELECT COUNT(*) FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = 'customers' AND index_name = 'idx_customers_class_sub');
SET @sql := IF(@idx = 0,
  'CREATE INDEX idx_customers_class_sub ON customers (workshop_id, customer_class, customer_subcategory, is_active)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 4. Vehicle identity fields the form now asks for ───────────────────
-- Plate Code and Emirate are separate fields in the mockup, and they have
-- to be: "87345 / A / Abu Dhabi" is one plate, and jamming it into
-- plate_number as a single string is what makes plate search unreliable.
-- Engine number and the fleet's own taxi/unit code come off the Aman Taxi
-- work order sheet (p7 of the process deck), which is the paper this
-- screen replaces.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'vehicles' AND column_name = 'plate_code');
SET @sql := IF(@col = 0,
  'ALTER TABLE vehicles ADD COLUMN plate_code VARCHAR(10) NULL COMMENT ''UAE plate code letter/number, e.g. A'' AFTER plate_number',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'vehicles' AND column_name = 'plate_emirate');
SET @sql := IF(@col = 0,
  'ALTER TABLE vehicles ADD COLUMN plate_emirate VARCHAR(50) NULL COMMENT ''Emirate the plate is registered in'' AFTER plate_code',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'vehicles' AND column_name = 'engine_no');
SET @sql := IF(@col = 0,
  'ALTER TABLE vehicles ADD COLUMN engine_no VARCHAR(50) NULL COMMENT ''Engine number, from the fleet work order sheet'' AFTER vin',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'vehicles' AND column_name = 'fleet_code');
SET @sql := IF(@col = 0,
  'ALTER TABLE vehicles ADD COLUMN fleet_code VARCHAR(50) NULL COMMENT ''The fleet operator own unit code, e.g. Aman taxi code 5946'' AFTER engine_no',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 5. work_orders.odometer_in — mileage at THIS visit ─────────────────
-- vehicles.mileage is a single number that gets overwritten, so it can
-- only ever mean "last known reading". The paper sheet records KM at
-- time-in for each visit, and service intervals, warranty claims and
-- fleet billing all need the reading for the visit in question, not the
-- latest one. Hence a per-work-order column; the vehicle's own mileage is
-- still updated alongside it so the vehicle record stays current.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'odometer_in');
SET @sql := IF(@col = 0,
  'ALTER TABLE work_orders ADD COLUMN odometer_in INT NULL COMMENT ''Odometer reading in km taken at intake for this visit'' AFTER vehicle_id',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Where the job card came from. The whiteboard lists five intake routes
-- into a work order — service advisor typing it, a fleet coordinator
-- link, the website, WhatsApp and social media — and being unable to tell
-- them apart afterwards means never knowing which channel is worth
-- keeping. 'advisor' is the default because that is what every one of the
-- 18,730 existing rows was.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'intake_channel');
SET @sql := IF(@col = 0,
  'ALTER TABLE work_orders ADD COLUMN intake_channel ENUM(''advisor'',''fleet_link'',''website'',''whatsapp'',''social'',''api'') NOT NULL DEFAULT ''advisor'' COMMENT ''Which route this job card arrived through'' AFTER odometer_in',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The fleet coordinator's submission this job card was raised from, when
-- it came in through the link rather than over the counter.
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'fleet_intake_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE work_orders ADD COLUMN fleet_intake_id INT NULL COMMENT ''fleet_intake_requests.id this job card was converted from'' AFTER intake_channel',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 6. Fleet coordinator intake link ───────────────────────────────────
-- Step 2 on the whiteboard: the vehicle information and the vehicle issue
-- do not have to be typed by a service advisor. A fleet coordinator can
-- send them ahead, and today does so on paper (p7) which is then re-keyed
-- by hand — the re-keying being where the chassis numbers get lost.
--
-- A coordinator is not a system user and should not need an account to do
-- this, so the link is tokenised per account, exactly like the estimate
-- approval page. The token identifies which fleet is submitting, so the
-- customer never has to be chosen on the form.
SET @tbl := (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'fleet_intake_links');
SET @sql := IF(@tbl = 0, '
CREATE TABLE fleet_intake_links (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  customer_id     INT NOT NULL COMMENT ''The fleet/insurance account this link belongs to'',
  token           VARCHAR(64) NOT NULL,
  label           VARCHAR(150) NULL COMMENT ''Who it was issued to, e.g. "Renjit - Aman Fleet Supervisor"'',
  contact_name    VARCHAR(150) NULL,
  contact_phone   VARCHAR(50) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  expires_at      DATETIME NULL COMMENT ''NULL means it does not expire'',
  created_by      INT NULL COMMENT ''users.id who issued it'',
  last_used_at    DATETIME NULL,
  submission_count INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fleet_intake_token (token),
  INDEX idx_fleet_link_customer (workshop_id, customer_id, is_active),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 7. The submissions themselves ──────────────────────────────────────
-- Held separately from work_orders rather than creating a draft work
-- order directly, for two reasons. A coordinator's submission is a
-- request, not a commitment — some get rejected, some are duplicates of a
-- car already in the workshop — and a rejected row sitting in work_orders
-- pollutes every count, every dashboard and every month-end figure.
-- Second, a submission arrives with a plate and a chassis number but no
-- guarantee either matches a vehicle we know, so vehicle_id stays
-- nullable until a human confirms the match.
SET @tbl := (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'fleet_intake_requests');
SET @sql := IF(@tbl = 0, '
CREATE TABLE fleet_intake_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  link_id         INT NULL COMMENT ''fleet_intake_links.id it arrived through; NULL if staff keyed it'',
  customer_id     INT NOT NULL,
  vehicle_id      INT NULL COMMENT ''Matched vehicle, once a human confirms it'',

  -- Vehicle as the coordinator typed it. Kept verbatim even after a match
  -- is made: if they said chassis JTNB19 and our record says JTNB11, the
  -- discrepancy is the useful part and overwriting it destroys the trail.
  plate_number    VARCHAR(50) NULL,
  plate_code      VARCHAR(10) NULL,
  plate_emirate   VARCHAR(50) NULL,
  make            VARCHAR(100) NULL,
  model           VARCHAR(100) NULL,
  year            SMALLINT NULL,
  color           VARCHAR(50) NULL,
  vin             VARCHAR(50) NULL,
  engine_no       VARCHAR(50) NULL,
  fleet_code      VARCHAR(50) NULL COMMENT ''Their unit/taxi code'',
  odometer        INT NULL,

  -- The issue, and who reported it
  complaint       TEXT NOT NULL,
  work_type       VARCHAR(60) NULL COMMENT ''MAINTENANCE / ACCIDENT / etc, as the fleet classifies it'',
  external_ref    VARCHAR(60) NULL COMMENT ''Their own WO number, e.g. WK140854'',
  driver_name     VARCHAR(150) NULL,
  driver_phone    VARCHAR(50) NULL,
  permit_id       VARCHAR(60) NULL,
  submitted_by    VARCHAR(150) NULL COMMENT ''Name the coordinator gave'',
  preferred_date  DATE NULL,

  status          ENUM(''submitted'',''accepted'',''rejected'',''converted'') NOT NULL DEFAULT ''submitted'',
  review_note     TEXT NULL,
  reviewed_by     INT NULL COMMENT ''users.id'',
  reviewed_at     DATETIME NULL,
  work_order_id   INT NULL COMMENT ''Set once converted'',

  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_fleet_req_queue (workshop_id, status, created_at),
  INDEX idx_fleet_req_customer (workshop_id, customer_id),
  INDEX idx_fleet_req_plate (workshop_id, plate_number),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 8. Classify the internal accounts we already know about ────────────
-- Everything defaulted to external in section 1. These are the accounts
-- named on the whiteboard, promoted to internal and given their
-- subcategory. Matched on name rather than id so the statement is safe to
-- run against staging and production alike, and scoped with LIKE because
-- the live names carry suffixes ("AMAN TAXI ABU DHABI" vs "Aman taxi Abu").
--
-- Anything not named here stays external, which is the safe default: an
-- account wrongly marked internal would appear in the fleet desk's list
-- and could be billed to the wrong ledger, whereas one wrongly left
-- external is simply reclassified from the Customers screen in a second.
UPDATE customers
   SET customer_class = 'internal', customer_subcategory = 'fleet'
 WHERE customer_subcategory IS NULL
   AND (   full_name LIKE 'AUTOSTRAD%'
        OR full_name LIKE 'AMAN TAXI%'
        OR full_name LIKE 'AMAN PUBLIC TRANSPORT%');

UPDATE customers
   SET customer_class = 'internal', customer_subcategory = 'insurance'
 WHERE customer_subcategory IS NULL
   AND (   full_name LIKE 'QIC%'
        OR full_name LIKE 'AWRIC%'
        OR full_name LIKE 'DUBAI INSURANCE%');

-- Pioneer's own vehicles — the asset pool. Listed last because "PIONEER"
-- also appears in the fleet list on the whiteboard; asset is the narrower
-- and more specific reading, and the rows above have already claimed
-- anything that is genuinely a taxi operator.
UPDATE customers
   SET customer_class = 'internal', customer_subcategory = 'asset'
 WHERE customer_subcategory IS NULL
   AND full_name LIKE 'PIONEER%';

-- Every remaining account is external. The ones already on file are, by
-- definition, existing customers rather than walk-ins — walk-in is what
-- the wizard writes on a customer it creates on the spot, so backfilling
-- it here would be a lie about how these rows were created.
UPDATE customers
   SET customer_subcategory = NULL
 WHERE customer_class = 'external'
   AND customer_subcategory = 'walkin'
   AND created_at < '2026-09-17';

-- ── 9. Account codes for the classified internal accounts ──────────────
-- The wizard shows a code on the Selected Customer panel (AST-001 in the
-- mockup), so the internal accounts need one or that row reads blank.
-- Assigned by name order so the numbering is stable and re-running this
-- migration cannot reshuffle codes that staff have started quoting.
--
-- Only ever fills a NULL: a code someone has typed by hand is theirs and
-- is never overwritten.
SET @i := 0;
UPDATE customers c
  JOIN (SELECT id, (@i := @i + 1) AS seq FROM customers
         WHERE customer_class = 'internal' AND customer_subcategory = 'fleet' AND code IS NULL
         ORDER BY full_name) t ON t.id = c.id
   SET c.code = CONCAT('FLT-', LPAD(t.seq, 3, '0'));

SET @i := 0;
UPDATE customers c
  JOIN (SELECT id, (@i := @i + 1) AS seq FROM customers
         WHERE customer_class = 'internal' AND customer_subcategory = 'insurance' AND code IS NULL
         ORDER BY full_name) t ON t.id = c.id
   SET c.code = CONCAT('INS-', LPAD(t.seq, 3, '0'));

SET @i := 0;
UPDATE customers c
  JOIN (SELECT id, (@i := @i + 1) AS seq FROM customers
         WHERE customer_class = 'internal' AND customer_subcategory = 'asset' AND code IS NULL
         ORDER BY full_name) t ON t.id = c.id
   SET c.code = CONCAT('AST-', LPAD(t.seq, 3, '0'));
