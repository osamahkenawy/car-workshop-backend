-- ============================================================
-- SOW Schema Extension — Pioneer Aftersales Workshop Platform
-- Mwasalat Holdings / MW.IT.PRC.05
-- Adds all tables required by the SOW that are not in the
-- base car_workshop.sql schema.
-- Run after 00_schema_patches.sql and 01_seed_countries.sql.
-- All statements are idempotent (CREATE TABLE IF NOT EXISTS).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- B1: Appointments (capacity-aware slot booking)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id        INT NOT NULL,
  customer_id        INT NULL,
  vehicle_id         INT NULL,
  customer_name      VARCHAR(200) NULL,
  customer_phone     VARCHAR(30) NULL,
  service_bay_id     INT NULL,
  appointment_date   DATE NOT NULL,
  appointment_time   TIME NOT NULL,
  slot_duration_min  INT NOT NULL DEFAULT 60,
  service_category   VARCHAR(100) NULL,
  notes              TEXT NULL,
  source             ENUM('call_centre','self_service','walk_in','app') DEFAULT 'call_centre',
  status             ENUM('pending','confirmed','arrived','in_progress','completed','cancelled','no_show') DEFAULT 'pending',
  work_order_id      INT NULL,
  booked_by_user_id  INT NULL,
  cancelled_reason   TEXT NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop_date (workshop_id, appointment_date),
  INDEX idx_customer (customer_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B1: Vehicle Receiving Form (digital intake replacing paper)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_receiving_forms (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  form_number          VARCHAR(50) NOT NULL UNIQUE,
  appointment_id       INT NULL,
  customer_id          INT NULL,
  vehicle_id           INT NULL,
  -- Snapshot at reception (auto-created if new customer/vehicle)
  customer_name        VARCHAR(200) NULL,
  customer_phone       VARCHAR(30) NULL,
  customer_email       VARCHAR(200) NULL,
  customer_type        ENUM('retail_cash','credit','insurance','internal_fleet') DEFAULT 'retail_cash',
  vehicle_make         VARCHAR(100) NULL,
  vehicle_model        VARCHAR(100) NULL,
  vehicle_year         YEAR NULL,
  vehicle_plate        VARCHAR(30) NULL,
  vehicle_vin          VARCHAR(50) NULL,
  vehicle_color        VARCHAR(50) NULL,
  odometer_in          INT NULL,
  fuel_level           TINYINT NULL COMMENT 'Percentage 0-100',
  -- Reported complaints
  complaints           TEXT NULL,
  -- Vehicle condition inventory (scratches, dents, etc.)
  condition_notes      TEXT NULL,
  condition_photos     JSON NULL COMMENT 'Array of uploaded photo URLs',
  -- Document captures
  mulkia_photo         VARCHAR(500) NULL COMMENT 'Registration document photo',
  id_photo             VARCHAR(500) NULL COMMENT 'Customer ID photo',
  -- Advisor assignment
  advisor_id           INT NULL,
  advisor_name         VARCHAR(200) NULL,
  -- Status
  status               ENUM('draft','submitted','converted','cancelled') DEFAULT 'draft',
  work_order_id        INT NULL,
  submitted_at         DATETIME NULL,
  created_by           INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_customer (customer_id),
  INDEX idx_vehicle (vehicle_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B3 req 70: Operations Master (pre-defined service operations)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operations_master (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id        INT NOT NULL,
  code               VARCHAR(50) NOT NULL,
  name               VARCHAR(200) NOT NULL,
  description        TEXT NULL,
  vehicle_make       VARCHAR(100) NULL COMMENT 'NULL = all makes',
  vehicle_model      VARCHAR(100) NULL COMMENT 'NULL = all models',
  service_interval   VARCHAR(100) NULL COMMENT 'e.g. 10000km or 6months',
  category           VARCHAR(100) NULL COMMENT 'e.g. mechanical, body-paint, electrical',
  standard_hours     DECIMAL(6,2) NULL COMMENT 'Standard labour hours (flat rate)',
  labour_rate_override DECIMAL(10,2) NULL COMMENT 'Override workshop default rate',
  parts_json         JSON NULL COMMENT 'Default parts list [{part_number,name,qty,unit_cost}]',
  is_active          TINYINT(1) DEFAULT 1,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_code (workshop_id, code),
  INDEX idx_workshop (workshop_id),
  INDEX idx_make_model (vehicle_make, vehicle_model)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B3: Service Estimates (before work order / job card)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_estimates (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  estimate_number     VARCHAR(50) NOT NULL UNIQUE,
  receiving_form_id   INT NULL,
  customer_id         INT NULL,
  vehicle_id          INT NULL,
  -- Snapshot
  customer_name       VARCHAR(200) NULL,
  customer_type       ENUM('retail_cash','credit','insurance','internal_fleet') DEFAULT 'retail_cash',
  vehicle_plate       VARCHAR(30) NULL,
  vehicle_vin         VARCHAR(50) NULL,
  -- Revision tracking
  version             INT NOT NULL DEFAULT 1,
  parent_estimate_id  INT NULL COMMENT 'Previous version',
  -- Financial summary
  subtotal_labour     DECIMAL(12,2) DEFAULT 0.00,
  subtotal_parts      DECIMAL(12,2) DEFAULT 0.00,
  subtotal_sublet     DECIMAL(12,2) DEFAULT 0.00,
  discount_amount     DECIMAL(12,2) DEFAULT 0.00,
  vat_rate            DECIMAL(5,2) DEFAULT 5.00,
  vat_amount          DECIMAL(12,2) DEFAULT 0.00,
  total_amount        DECIMAL(12,2) DEFAULT 0.00,
  -- Approval
  status              ENUM('draft','sent_to_customer','partially_approved','approved','rejected','expired','converted') DEFAULT 'draft',
  customer_approved_at DATETIME NULL,
  customer_notes      TEXT NULL,
  valid_until         DATE NULL,
  -- Relationships
  work_order_id       INT NULL COMMENT 'Set when converted to work order',
  advisor_id          INT NULL,
  created_by          INT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_customer (customer_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B3 req 71: Estimate Lines (line-level payer direction)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estimate_lines (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  estimate_id         INT NOT NULL,
  workshop_id         INT NOT NULL,
  line_type           ENUM('labour','parts','sublet','consumable','discount') NOT NULL,
  operation_id        INT NULL COMMENT 'FK to operations_master',
  description         VARCHAR(500) NOT NULL,
  part_number         VARCHAR(100) NULL,
  quantity            DECIMAL(10,3) DEFAULT 1.000,
  unit_cost           DECIMAL(12,2) DEFAULT 0.00,
  unit_price          DECIMAL(12,2) DEFAULT 0.00,
  discount_pct        DECIMAL(5,2) DEFAULT 0.00,
  line_total          DECIMAL(12,2) GENERATED ALWAYS AS
                        (ROUND(quantity * unit_price * (1 - discount_pct/100), 2)) STORED,
  payer_direction     ENUM('customer','insurance','warranty','goodwill','internal_fleet') DEFAULT 'customer',
  insurance_ref       VARCHAR(200) NULL COMMENT 'Insurance claim ref if payer=insurance',
  warranty_ref        VARCHAR(200) NULL,
  -- Customer approval at line level
  customer_status     ENUM('pending','approved','rejected') DEFAULT 'pending',
  sort_order          INT DEFAULT 0,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_estimate (estimate_id),
  INDEX idx_workshop (workshop_id),
  CONSTRAINT fk_el_estimate FOREIGN KEY (estimate_id) REFERENCES service_estimates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B5: Job Cards (created from approved estimates)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_cards (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  job_card_number      VARCHAR(50) NOT NULL UNIQUE,
  work_order_id        INT NOT NULL,
  estimate_id          INT NULL,
  customer_id          INT NULL,
  vehicle_id           INT NULL,
  vehicle_plate        VARCHAR(30) NULL,
  -- Assignment
  service_bay_id       INT NULL,
  foreman_id           INT NULL COMMENT 'Supervisor/foreman responsible',
  department           ENUM('mechanical','body_paint','electrical','tyres','other') DEFAULT 'mechanical',
  -- Status lifecycle
  status               ENUM('open','parts_requested','parts_issued','in_progress','qc_pending','qc_passed','qc_failed','ready_for_billing','billed','cancelled') DEFAULT 'open',
  -- Dates
  started_at           DATETIME NULL,
  completed_at         DATETIME NULL,
  qc_passed_at         DATETIME NULL,
  -- QC
  qc_inspector_id      INT NULL,
  qc_notes             TEXT NULL,
  -- Financial summary (net of discount, pre-VAT)
  labour_cost          DECIMAL(12,2) DEFAULT 0.00,
  parts_cost           DECIMAL(12,2) DEFAULT 0.00,
  sublet_cost          DECIMAL(12,2) DEFAULT 0.00,
  total_cost           DECIMAL(12,2) DEFAULT 0.00,
  -- WIP tracking
  wip_opened_at        DATETIME NULL,
  wip_closed_at        DATETIME NULL,
  created_by           INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id),
  INDEX idx_status (status),
  INDEX idx_bay (service_bay_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B5: Job Card Lines (operations/labour per job card)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_card_lines (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  job_card_id         INT NOT NULL,
  workshop_id         INT NOT NULL,
  estimate_line_id    INT NULL,
  operation_id        INT NULL,
  description         VARCHAR(500) NOT NULL,
  line_type           ENUM('labour','parts','sublet','consumable') DEFAULT 'labour',
  payer_direction     ENUM('customer','insurance','warranty','goodwill','internal_fleet') DEFAULT 'customer',
  assigned_mechanic_id INT NULL,
  standard_hours      DECIMAL(6,2) NULL,
  actual_hours        DECIMAL(6,2) NULL,
  status              ENUM('pending','in_progress','completed') DEFAULT 'pending',
  started_at          DATETIME NULL,
  completed_at        DATETIME NULL,
  sort_order          INT DEFAULT 0,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id),
  CONSTRAINT fk_jcl_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B5 req 79: Technician Time Logs (clock-in / clock-out)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS technician_time_logs (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  job_card_id         INT NOT NULL,
  job_card_line_id    INT NULL,
  mechanic_id         INT NOT NULL,
  mechanic_name       VARCHAR(200) NULL,
  clock_in            DATETIME NOT NULL,
  clock_out           DATETIME NULL,
  elapsed_minutes     INT GENERATED ALWAYS AS
                        (CASE WHEN clock_out IS NOT NULL
                              THEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out)
                              ELSE NULL END) STORED,
  activity_notes      TEXT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id),
  INDEX idx_mechanic (mechanic_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B5 req 80: Quality Control Checklists
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qc_checklists (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  job_card_id         INT NOT NULL UNIQUE,
  inspector_id        INT NOT NULL,
  checklist_items     JSON NOT NULL COMMENT '[{item, passed, notes}]',
  overall_result      ENUM('passed','failed','conditional') NOT NULL,
  inspector_notes     TEXT NULL,
  inspected_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B6: Material Requisitions (parts request from stores)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_requisitions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  req_number          VARCHAR(50) NOT NULL UNIQUE,
  job_card_id         INT NOT NULL,
  requested_by        INT NOT NULL COMMENT 'mechanic/foreman user_id',
  status              ENUM('pending','partially_issued','issued','cancelled') DEFAULT 'pending',
  notes               TEXT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id),
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS material_requisition_items (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  requisition_id      INT NOT NULL,
  part_number         VARCHAR(100) NULL,
  description         VARCHAR(500) NOT NULL,
  quantity_requested  DECIMAL(10,3) NOT NULL,
  quantity_issued     DECIMAL(10,3) DEFAULT 0.000,
  unit_cost           DECIMAL(12,2) NULL,
  status              ENUM('pending','issued','partially_issued','returned','cancelled') DEFAULT 'pending',
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_req (requisition_id),
  CONSTRAINT fk_mri_req FOREIGN KEY (requisition_id) REFERENCES material_requisitions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B6: Material Issues (parts issued from stores)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_issues (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  issue_number        VARCHAR(50) NOT NULL UNIQUE,
  requisition_id      INT NULL,
  job_card_id         INT NOT NULL,
  issued_by           INT NOT NULL COMMENT 'stores user_id',
  issue_type          ENUM('standard','consumable_bulk','paint_bulk') DEFAULT 'standard',
  notes               TEXT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id),
  INDEX idx_requisition (requisition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS material_issue_items (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  issue_id            INT NOT NULL,
  part_number         VARCHAR(100) NULL,
  description         VARCHAR(500) NOT NULL,
  quantity            DECIMAL(10,3) NOT NULL,
  unit_cost           DECIMAL(12,2) DEFAULT 0.00,
  line_cost           DECIMAL(12,2) GENERATED ALWAYS AS (ROUND(quantity * unit_cost, 2)) STORED,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mii_issue FOREIGN KEY (issue_id) REFERENCES material_issues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B6: Material Returns (unused parts returned to stores)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS material_returns (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  return_number       VARCHAR(50) NOT NULL UNIQUE,
  issue_id            INT NULL,
  job_card_id         INT NOT NULL,
  returned_by         INT NOT NULL,
  accepted_by         INT NULL,
  reason              TEXT NULL,
  status              ENUM('pending','accepted','rejected') DEFAULT 'pending',
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS material_return_items (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  return_id           INT NOT NULL,
  part_number         VARCHAR(100) NULL,
  description         VARCHAR(500) NOT NULL,
  quantity            DECIMAL(10,3) NOT NULL,
  unit_cost           DECIMAL(12,2) DEFAULT 0.00,
  CONSTRAINT fk_mri2_return FOREIGN KEY (return_id) REFERENCES material_returns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B6 req 88: Stock Reservations (ring-fence parts for a job)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_reservations (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  job_card_id         INT NOT NULL,
  part_number         VARCHAR(100) NOT NULL,
  description         VARCHAR(500) NULL,
  quantity_reserved   DECIMAL(10,3) NOT NULL,
  quantity_released   DECIMAL(10,3) DEFAULT 0.000,
  status              ENUM('active','partially_released','released','cancelled') DEFAULT 'active',
  reserved_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  released_at         DATETIME NULL,
  INDEX idx_job_card (job_card_id),
  INDEX idx_part (part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B8: Sublet Orders (external supplier work on a job)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sublet_orders (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  sublet_number       VARCHAR(50) NOT NULL UNIQUE,
  job_card_id         INT NOT NULL,
  work_order_id       INT NULL,
  supplier_name       VARCHAR(200) NOT NULL,
  supplier_contact    VARCHAR(200) NULL,
  description         TEXT NOT NULL,
  estimated_cost      DECIMAL(12,2) DEFAULT 0.00,
  actual_cost         DECIMAL(12,2) NULL,
  supplier_invoice_no VARCHAR(100) NULL,
  supplier_invoice_date DATE NULL,
  payer_direction     ENUM('customer','insurance','warranty','goodwill') DEFAULT 'customer',
  status              ENUM('pending','sent_to_supplier','in_progress','received','invoiced','paid','cancelled') DEFAULT 'pending',
  sent_at             DATETIME NULL,
  received_at         DATETIME NULL,
  notes               TEXT NULL,
  created_by          INT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id),
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B9: Proforma Invoices (before final billing)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proforma_invoices (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  proforma_number      VARCHAR(50) NOT NULL UNIQUE,
  job_card_id          INT NULL,
  work_order_id        INT NULL,
  customer_id          INT NULL,
  customer_name        VARCHAR(200) NULL,
  customer_type        ENUM('retail_cash','credit','insurance','internal_fleet') DEFAULT 'retail_cash',
  -- Financial
  subtotal             DECIMAL(12,2) DEFAULT 0.00,
  discount_amount      DECIMAL(12,2) DEFAULT 0.00,
  vat_rate             DECIMAL(5,2) DEFAULT 5.00,
  vat_amount           DECIMAL(12,2) DEFAULT 0.00,
  total_amount         DECIMAL(12,2) DEFAULT 0.00,
  -- Multi-payer split
  customer_share       DECIMAL(12,2) DEFAULT 0.00,
  insurance_share      DECIMAL(12,2) DEFAULT 0.00,
  warranty_share       DECIMAL(12,2) DEFAULT 0.00,
  goodwill_share       DECIMAL(12,2) DEFAULT 0.00,
  -- Insurance details
  insurance_company    VARCHAR(200) NULL,
  insurance_claim_ref  VARCHAR(100) NULL,
  insurance_approved_amount DECIMAL(12,2) NULL,
  excess_amount        DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Customer pays excess',
  -- Payment
  payment_status       ENUM('unpaid','partial','paid') DEFAULT 'unpaid',
  amount_paid          DECIMAL(12,2) DEFAULT 0.00,
  payment_method       VARCHAR(50) NULL,
  payment_reference    VARCHAR(200) NULL,
  payment_link_url     VARCHAR(500) NULL,
  -- Status
  status               ENUM('draft','sent','confirmed','converted_to_invoice','voided') DEFAULT 'draft',
  invoice_id           INT NULL COMMENT 'Set when converted to final invoice',
  valid_until          DATE NULL,
  notes                TEXT NULL,
  created_by           INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_job_card (job_card_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B9: Gate Passes (vehicle release after payment)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gate_passes (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  gate_pass_number     VARCHAR(50) NOT NULL UNIQUE,
  job_card_id          INT NULL,
  work_order_id        INT NULL,
  invoice_id           INT NULL,
  proforma_id          INT NULL,
  customer_id          INT NULL,
  customer_name        VARCHAR(200) NULL,
  vehicle_id           INT NULL,
  vehicle_plate        VARCHAR(30) NULL,
  odometer_out         INT NULL,
  -- Conditions for release
  payment_confirmed    TINYINT(1) DEFAULT 0,
  qc_confirmed         TINYINT(1) DEFAULT 0,
  -- Signature
  customer_signature   VARCHAR(500) NULL COMMENT 'Signature image URL',
  released_by          INT NULL,
  released_at          DATETIME NULL,
  status               ENUM('pending','released','voided') DEFAULT 'pending',
  notes                TEXT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_job_card (job_card_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B2 req 67: Credit Customer Facilities
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_facilities (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  customer_id          INT NOT NULL,
  company_name         VARCHAR(200) NULL,
  trade_licence_no     VARCHAR(100) NULL,
  trade_licence_expiry DATE NULL,
  tax_registration_no  VARCHAR(100) NULL,
  commercial_reg_no    VARCHAR(100) NULL,
  credit_limit         DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  credit_used          DECIMAL(12,2) DEFAULT 0.00,
  payment_terms_days   INT DEFAULT 30,
  status               ENUM('pending_approval','approved','suspended','rejected') DEFAULT 'pending_approval',
  approved_by          INT NULL,
  approved_at          DATETIME NULL,
  rejection_reason     TEXT NULL,
  created_by           INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_customer (workshop_id, customer_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B9 req 95: UAE VAT Transactions (FTA e-invoicing compliance)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vat_transactions (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  reference_type       ENUM('invoice','proforma','credit_note') NOT NULL,
  reference_id         INT NOT NULL,
  reference_number     VARCHAR(100) NOT NULL,
  customer_name        VARCHAR(200) NULL,
  customer_tax_reg_no  VARCHAR(100) NULL,
  supply_date          DATE NOT NULL,
  taxable_amount       DECIMAL(14,2) NOT NULL,
  vat_rate             DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  vat_amount           DECIMAL(14,2) NOT NULL,
  total_amount         DECIMAL(14,2) NOT NULL,
  -- FTA e-invoicing fields
  fta_submission_id    VARCHAR(200) NULL,
  fta_status           ENUM('pending','submitted','accepted','rejected') DEFAULT 'pending',
  fta_submitted_at     DATETIME NULL,
  fta_response         JSON NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_reference (reference_type, reference_id),
  INDEX idx_supply_date (supply_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B7 req 89: Supplier Warranty Terms (item-master level)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supplier_warranty_terms (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  part_number          VARCHAR(100) NOT NULL,
  part_name            VARCHAR(200) NULL,
  supplier_name        VARCHAR(200) NULL,
  warranty_months      INT NULL,
  warranty_km          INT NULL,
  warranty_conditions  TEXT NULL,
  is_active            TINYINT(1) DEFAULT 1,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop_part (workshop_id, part_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B10 req 100: WIP (Work In Progress) Ledger
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wip_ledger (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  job_card_id          INT NOT NULL,
  work_order_id        INT NULL,
  entry_type           ENUM('open','labour_charge','parts_charge','sublet_charge','close','reversal') NOT NULL,
  amount               DECIMAL(12,2) NOT NULL,
  description          VARCHAR(500) NULL,
  payer_direction      ENUM('customer','insurance','warranty','goodwill','internal_fleet') DEFAULT 'customer',
  posted_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
  posted_by            INT NULL,
  INDEX idx_job_card (job_card_id),
  INDEX idx_workshop_date (workshop_id, posted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B5 req 83: Courtesy / Loaner Vehicles
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loaner_vehicles (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  plate_number         VARCHAR(30) NOT NULL,
  make                 VARCHAR(100) NULL,
  model                VARCHAR(100) NULL,
  year                 YEAR NULL,
  status               ENUM('available','on_loan','maintenance','retired') DEFAULT 'available',
  current_job_card_id  INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS loaner_agreements (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  loaner_vehicle_id    INT NOT NULL,
  job_card_id          INT NOT NULL,
  customer_id          INT NULL,
  customer_name        VARCHAR(200) NULL,
  issued_at            DATETIME NULL,
  returned_at          DATETIME NULL,
  odometer_out         INT NULL,
  odometer_in          INT NULL,
  fuel_level_out       TINYINT NULL,
  fuel_level_in        TINYINT NULL,
  notes                TEXT NULL,
  status               ENUM('active','returned','overdue') DEFAULT 'active',
  issued_by            INT NULL,
  returned_to          INT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_job_card (job_card_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B6 req 88: Inventory Locations (multi-location stock)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_locations (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  name                 VARCHAR(200) NOT NULL,
  location_type        ENUM('main_store','workshop_sub','external') DEFAULT 'main_store',
  is_active            TINYINT(1) DEFAULT 1,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS inventory_stock (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  location_id          INT NOT NULL,
  part_number          VARCHAR(100) NOT NULL,
  description          VARCHAR(500) NULL,
  quantity_on_hand     DECIMAL(10,3) DEFAULT 0.000,
  quantity_reserved    DECIMAL(10,3) DEFAULT 0.000,
  avg_cost             DECIMAL(12,4) DEFAULT 0.0000 COMMENT 'Average cost (AVCO)',
  last_purchase_cost   DECIMAL(12,2) NULL,
  reorder_level        DECIMAL(10,3) DEFAULT 0.000,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_location_part (location_id, part_number),
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- Electronic Vehicle Health Check (B3 req 74)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_health_checks (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  work_order_id        INT NULL,
  job_card_id          INT NULL,
  vehicle_id           INT NULL,
  technician_id        INT NULL,
  inspection_items     JSON NOT NULL COMMENT '[{category, item, result: ok|advisory|urgent, notes, photos:[]}]',
  overall_score        TINYINT NULL COMMENT 'Percentage health score',
  customer_notified_at DATETIME NULL,
  customer_approved_at DATETIME NULL,
  approved_items       JSON NULL COMMENT 'Item IDs approved by customer',
  status               ENUM('in_progress','completed','customer_notified','customer_approved') DEFAULT 'in_progress',
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- Section C: Group Integration (Autostrad rental/fleet)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS group_integration_events (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  event_type           ENUM('rental_damaged_vehicle','maintenance_due','repair_complete','cost_posted') NOT NULL,
  direction            ENUM('inbound','outbound') NOT NULL,
  external_system      VARCHAR(100) DEFAULT 'autostrad',
  external_ref         VARCHAR(200) NULL COMMENT 'Rental record / fleet job ref',
  local_ref_type       VARCHAR(50) NULL COMMENT 'work_order / job_card',
  local_ref_id         INT NULL,
  payload              JSON NOT NULL,
  status               ENUM('pending','processed','failed','retrying') DEFAULT 'pending',
  attempts             INT DEFAULT 0,
  last_attempt_at      DATETIME NULL,
  processed_at         DATETIME NULL,
  error_message        TEXT NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_event_type (event_type),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- Security: MFA tokens
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mfa_tokens (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT NOT NULL,
  user_type            ENUM('staff','customer') DEFAULT 'staff',
  token_hash           VARCHAR(255) NOT NULL,
  purpose              ENUM('login','password_reset','email_verify') DEFAULT 'login',
  expires_at           DATETIME NOT NULL,
  used_at              DATETIME NULL,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, user_type),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- B2 req 66: Customer-Vehicle additional contacts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_contacts (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id          INT NOT NULL,
  vehicle_id           INT NOT NULL,
  customer_id          INT NOT NULL COMMENT 'Registered owner',
  contact_name         VARCHAR(200) NOT NULL,
  contact_phone        VARCHAR(30) NULL,
  contact_email        VARCHAR(200) NULL,
  relationship         ENUM('driver','family_member','fleet_coordinator','other') DEFAULT 'other',
  is_primary_presenter TINYINT(1) DEFAULT 0,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_vehicle (vehicle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
