-- ═══════════════════════════════════════════════════════════════════════════
--  Customer Journey schema — Pioneer CX Journey Map + Journey-with-Exceptions
--
--  Closes the gaps between the documented retail customer journey and the
--  platform. Grouped by the journey register it serves:
--
--    A. Stage 01-02  Enquiry capture and channel attribution   (flagged GAP)
--    B. Cross-cutting Service tier 1/2/3 and payer route
--    C. Insurance lane Claim, assessor, pre-authorisation, excess
--    D. Stage 06-07  Quote urgency, deferral, per-line approval audit
--    E. Exception E1 Additional work found mid-repair
--    F. Exception E2 Rework / comeback determination + accountability
--    G. Exception E3 Refund / dispute case management
--    H. Stage 12     48-hour follow-up and feedback capture     (flagged GAP)
--
--  Idempotent — every statement is guarded, safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- A. ENQUIRIES — stage 01-02, "logs enquiry and source"
--    Journey map flags this as "Enquiry log and quote — GAP, manual today".
--    Source attribution mirrors the four sourcing groups on the map so
--    conversion can be measured by channel.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS enquiries (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id           INT NOT NULL,
  enquiry_number        VARCHAR(50) NOT NULL,

  -- Who (customer_id null until they exist as a customer)
  customer_id           INT NULL,
  vehicle_id            INT NULL,
  contact_name          VARCHAR(200) NOT NULL,
  contact_phone         VARCHAR(50) NOT NULL,
  contact_email         VARCHAR(200) NULL,
  vehicle_description   VARCHAR(255) NULL COMMENT 'Free text when no vehicle record exists yet',

  -- What
  enquiry_type          ENUM('service','repair','diagnostic','bodywork','accident','other') DEFAULT 'service',
  service_tier          ENUM('tier1_routine','tier2_diagnostic','tier3_major') NULL,
  description           TEXT NULL,
  quoted_amount         DECIMAL(12,2) NULL,
  quoted_at             DATETIME NULL,

  -- How it reached us — the four sourcing groups from the journey map
  source_channel        ENUM('owned_repeat','search_discovery','passing_local','partner_referred') NOT NULL DEFAULT 'passing_local',
  source_detail         VARCHAR(120) NULL COMMENT 'e.g. google_business_profile, referral, insurer_panel',
  referred_by           VARCHAR(200) NULL,
  contact_method        ENUM('phone','whatsapp','website_form','walk_in','partner_handoff','email') DEFAULT 'phone',

  -- Payer route (forks at triage, stage 03)
  payer_type            ENUM('self_pay','insurance','corporate','fleet') DEFAULT 'self_pay',

  -- Outcome
  status                ENUM('new','quoted','converted','lost','nurture') DEFAULT 'new',
  lost_reason           ENUM('price','timing','location','went_elsewhere','no_response','not_needed','other') NULL,
  lost_notes            TEXT NULL,
  follow_up_at          DATETIME NULL COMMENT 'Nurture / re-offer date — the re-offer loop on the map',
  converted_work_order_id INT NULL,
  converted_at          DATETIME NULL,

  assigned_to           INT NULL,
  created_by            INT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_enquiry_number (workshop_id, enquiry_number),
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status),
  INDEX idx_source (source_channel),
  INDEX idx_follow_up (follow_up_at),
  CONSTRAINT fk_enq_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ═══════════════════════════════════════════════════════════════
-- B. SERVICE TIER + PAYER ROUTE on work orders
--    Tier decides which journey stages apply (tier 1 skips 05-08).
-- ═══════════════════════════════════════════════════════════════
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'service_tier');
SET @sql := IF(@col = 0, "ALTER TABLE work_orders ADD COLUMN service_tier ENUM('tier1_routine','tier2_diagnostic','tier3_major') NULL AFTER service_category", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'payer_type');
SET @sql := IF(@col = 0, "ALTER TABLE work_orders ADD COLUMN payer_type ENUM('self_pay','insurance','corporate','fleet') DEFAULT 'self_pay' AFTER payment_method", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'enquiry_id');
SET @sql := IF(@col = 0, 'ALTER TABLE work_orders ADD COLUMN enquiry_id INT NULL COMMENT "Originating enquiry, for source attribution"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'odometer_at_service');
SET @sql := IF(@col = 0, 'ALTER TABLE work_orders ADD COLUMN odometer_at_service INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ═══════════════════════════════════════════════════════════════
-- C. INSURANCE CLAIMS — the insurance lane of the journey map
--    One row per work order taking the insurer-pays route.
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS insurance_claims (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id             INT NOT NULL,
  work_order_id           INT NOT NULL,
  customer_id             INT NULL,

  insurer_name            VARCHAR(200) NOT NULL,
  insurer_contact         VARCHAR(200) NULL,
  policy_number           VARCHAR(100) NULL,
  claim_number            VARCHAR(100) NULL,

  status                  ENUM('intake','documentation','assessor_pending','assessor_inspected',
                               'pre_auth_pending','pre_auth_approved','pre_auth_declined',
                               'in_repair','invoiced','settled','closed') DEFAULT 'intake',

  -- Recovery (tier 3 — "we can arrange recovery")
  recovery_arranged       TINYINT(1) DEFAULT 0,
  recovery_provider       VARCHAR(200) NULL,
  recovery_logged_at      DATETIME NULL,

  -- Assessor inspection (tier 3)
  assessor_name           VARCHAR(200) NULL,
  assessor_contact        VARCHAR(200) NULL,
  assessor_scheduled_at   DATETIME NULL,
  assessor_inspected_at   DATETIME NULL,
  assessor_notes          TEXT NULL,

  -- Pre-authorisation — "the insurer approves, not you"
  pre_auth_reference      VARCHAR(120) NULL,
  pre_auth_amount         DECIMAL(12,2) NULL,
  pre_auth_submitted_at   DATETIME NULL,
  pre_auth_decision_at    DATETIME NULL,
  pre_auth_declined_reason TEXT NULL,

  approved_parts_vendor   VARCHAR(200) NULL COMMENT 'Vendor confirmed with the insurer',

  -- Settlement — "you pay the excess only"
  excess_amount           DECIMAL(12,2) DEFAULT 0.00,
  excess_collected        TINYINT(1) DEFAULT 0,
  excess_collected_at     DATETIME NULL,
  insurer_invoice_amount  DECIMAL(12,2) NULL,
  insurer_settled_amount  DECIMAL(12,2) NULL,
  insurer_settled_at      DATETIME NULL,
  claim_closed_at         DATETIME NULL,

  notes                   TEXT NULL,
  created_by              INT NULL,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_claim_work_order (work_order_id),
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status),
  INDEX idx_claim_number (claim_number),
  CONSTRAINT fk_ic_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  CONSTRAINT fk_ic_work_order FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ═══════════════════════════════════════════════════════════════
-- D. QUOTE URGENCY, DEFERRAL AND PER-LINE APPROVAL AUDIT
--    "a price for each item ... approve, defer, or decline — item by item"
--    "record your answer against the job, line by line, with the time it was given"
-- ═══════════════════════════════════════════════════════════════
SET @tbl := (SELECT COUNT(*) FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'estimate_lines');

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'estimate_lines' AND column_name = 'urgency');
SET @sql := IF(@tbl > 0 AND @col = 0, "ALTER TABLE estimate_lines ADD COLUMN urgency ENUM('now','soon','can_wait') DEFAULT 'now' COMMENT 'Traffic-light urgency shown to the customer'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'estimate_lines' AND column_name = 'customer_responded_at');
SET @sql := IF(@tbl > 0 AND @col = 0, 'ALTER TABLE estimate_lines ADD COLUMN customer_responded_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'estimate_lines' AND column_name = 'customer_responded_by');
SET @sql := IF(@tbl > 0 AND @col = 0, 'ALTER TABLE estimate_lines ADD COLUMN customer_responded_by VARCHAR(200) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'estimate_lines' AND column_name = 'response_channel');
SET @sql := IF(@tbl > 0 AND @col = 0, "ALTER TABLE estimate_lines ADD COLUMN response_channel ENUM('in_person','phone','whatsapp','email','portal') NULL", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Widen customer_status to carry 'deferred' alongside approved/rejected
SET @sql := IF(@tbl > 0, "ALTER TABLE estimate_lines MODIFY COLUMN customer_status ENUM('pending','approved','rejected','deferred') DEFAULT 'pending'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- Deferred work register — "we write the rest onto your record for next time"
CREATE TABLE IF NOT EXISTS deferred_work_items (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id           INT NOT NULL,
  vehicle_id            INT NULL,
  customer_id           INT NULL,
  source_work_order_id  INT NULL,
  source_estimate_line_id INT NULL,

  description           VARCHAR(500) NOT NULL,
  estimated_amount      DECIMAL(12,2) NULL,
  urgency               ENUM('now','soon','can_wait') DEFAULT 'soon',
  evidence_photo_url    VARCHAR(500) NULL,

  status                ENUM('open','scheduled','completed','declined_permanently') DEFAULT 'open',
  deferred_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  remind_at             DATETIME NULL,
  resolved_work_order_id INT NULL,
  resolved_at           DATETIME NULL,
  notes                 TEXT NULL,

  created_by            INT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_workshop (workshop_id),
  INDEX idx_vehicle (vehicle_id),
  INDEX idx_status (status),
  CONSTRAINT fk_dwi_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ═══════════════════════════════════════════════════════════════
-- E. EXCEPTION E1 — additional work found mid-repair
--    "Work stops. You see a photograph, a price and a recommendation,
--     and you decide before anything else is touched."
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS additional_work_requests (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id             INT NOT NULL,
  work_order_id           INT NOT NULL,
  request_number          VARCHAR(50) NULL,

  raised_by_mechanic_id   INT NULL,
  raised_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
  description             VARCHAR(500) NOT NULL,
  recommendation          TEXT NULL,
  urgency                 ENUM('now','soon','can_wait') DEFAULT 'now',
  quoted_amount           DECIMAL(12,2) NULL,

  -- Evidence must exist before the customer is contacted
  evidence_captured       TINYINT(1) DEFAULT 0,
  evidence_photo_url      VARCHAR(500) NULL,
  evidence_video_url      VARCHAR(500) NULL,

  -- Work pauses until answered — never proceed on no answer
  work_paused             TINYINT(1) DEFAULT 1,

  status                  ENUM('evidence_pending','awaiting_customer','approved','declined',
                               'deferred','unreachable') DEFAULT 'evidence_pending',
  customer_contacted_at   DATETIME NULL,
  customer_responded_at   DATETIME NULL,
  response_channel        ENUM('in_person','phone','whatsapp','email','portal') NULL,
  approved_amount         DECIMAL(12,2) NULL,
  decline_reason          TEXT NULL,

  -- Insurance route needs a second pre-authorisation
  insurer_pre_auth_required TINYINT(1) DEFAULT 0,
  insurer_pre_auth_reference VARCHAR(120) NULL,
  insurer_pre_auth_at     DATETIME NULL,

  handled_by              INT NULL,
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id),
  INDEX idx_status (status),
  CONSTRAINT fk_awr_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  CONSTRAINT fk_awr_work_order FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ═══════════════════════════════════════════════════════════════
-- F. EXCEPTION E2 — rework / comeback determination + accountability
--    Extends the existing warranty_claims table.
-- ═══════════════════════════════════════════════════════════════
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'original_work_order_id');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN original_work_order_id INT NULL COMMENT "Job card the comeback is checked against"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'determination');
SET @sql := IF(@col = 0, "ALTER TABLE warranty_claims ADD COLUMN determination ENUM('pending','our_workmanship','different_fault','wear_and_tear','customer_induced') DEFAULT 'pending'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'determination_at');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN determination_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'determination_by');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN determination_by INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'chargeable');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN chargeable TINYINT(1) DEFAULT 0 COMMENT "0 = we carry the cost"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Accountability: trace back to the technician and the QC that released the car
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'responsible_mechanic_id');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN responsible_mechanic_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'qc_released_by');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN qc_released_by INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- "Book you in ahead of the queue. No diagnostic charge on a return visit."
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'queue_priority');
SET @sql := IF(@col = 0, "ALTER TABLE warranty_claims ADD COLUMN queue_priority ENUM('standard','priority','urgent') DEFAULT 'priority'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'diagnostic_fee_waived');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN diagnostic_fee_waived TINYINT(1) DEFAULT 1', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'warranty_claims' AND column_name = 'evidence_photo_url');
SET @sql := IF(@col = 0, 'ALTER TABLE warranty_claims ADD COLUMN evidence_photo_url VARCHAR(500) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ═══════════════════════════════════════════════════════════════
-- G. EXCEPTION E3 — refund / dispute case management
--    Reference number, one named owner, acknowledgement SLA,
--    authority matrix, committed refund turnaround.
-- ═══════════════════════════════════════════════════════════════
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'case_number');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN case_number VARCHAR(50) NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'owner_user_id');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN owner_user_id INT NULL COMMENT "One named person owns it from intake"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'intake_channel');
SET @sql := IF(@col = 0, "ALTER TABLE disputes ADD COLUMN intake_channel ENUM('in_person','phone','email','whatsapp','portal','letter') DEFAULT 'in_person'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'acknowledged_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN acknowledged_at DATETIME NULL COMMENT "Committed: within one working day"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'response_due_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN response_due_at DATETIME NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'outcome');
SET @sql := IF(@col = 0, "ALTER TABLE disputes ADD COLUMN outcome ENUM('pending','refund_due','charge_correct','partial_refund','goodwill') DEFAULT 'pending'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'outcome_communicated_at');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN outcome_communicated_at DATETIME NULL COMMENT "Decision given in writing"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'authority_level');
SET @sql := IF(@col = 0, "ALTER TABLE disputes ADD COLUMN authority_level ENUM('advisor','manager','senior') DEFAULT 'advisor' COMMENT 'Delegation-of-authority threshold'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'disputes' AND column_name = 'changes_made');
SET @sql := IF(@col = 0, 'ALTER TABLE disputes ADD COLUMN changes_made TEXT NULL COMMENT "What we changed as a result"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Refunds: link to the dispute, committed turnaround, authority
SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'refunds' AND column_name = 'dispute_id');
SET @sql := IF(@col = 0, 'ALTER TABLE refunds ADD COLUMN dispute_id INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'refunds' AND column_name = 'due_by');
SET @sql := IF(@col = 0, 'ALTER TABLE refunds ADD COLUMN due_by DATETIME NULL COMMENT "Committed: five working days from decision"', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'refunds' AND column_name = 'authority_level');
SET @sql := IF(@col = 0, "ALTER TABLE refunds ADD COLUMN authority_level ENUM('advisor','manager','senior') DEFAULT 'advisor'", 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;


-- ═══════════════════════════════════════════════════════════════
-- H. CUSTOMER FEEDBACK — stage 12, "two days later we call to check"
--    Journey map flags "Feedback capture — GAP, not in place".
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS customer_feedback (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id           INT NOT NULL,
  work_order_id         INT NOT NULL,
  customer_id           INT NULL,

  scheduled_at          DATETIME NULL COMMENT '48 hours after handover',
  status                ENUM('scheduled','attempted','completed','skipped') DEFAULT 'scheduled',
  channel               ENUM('phone','whatsapp','sms','email') DEFAULT 'phone',
  attempts              INT DEFAULT 0,
  contacted_at          DATETIME NULL,

  satisfied             TINYINT(1) NULL,
  rating                TINYINT NULL COMMENT '1-5',
  nps_score             TINYINT NULL COMMENT '0-10',
  comments              TEXT NULL,

  issue_raised          TINYINT(1) DEFAULT 0,
  linked_dispute_id     INT NULL,
  linked_warranty_claim_id INT NULL,

  review_requested      TINYINT(1) DEFAULT 0,
  review_left           TINYINT(1) DEFAULT 0,
  referral_prompted     TINYINT(1) DEFAULT 0,

  handled_by            INT NULL,
  completed_at          DATETIME NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id),
  INDEX idx_status (status),
  INDEX idx_scheduled (scheduled_at),
  CONSTRAINT fk_cf_workshop FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  CONSTRAINT fk_cf_work_order FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
