-- CRM phase 1: the three tables behind Customer 360, Service Reminders and
-- Tasks & Follow-ups.
--
-- The platform already captures enquiries, customers, vehicles, jobs, invoices
-- and feedback. What it could not do was act on that history: know a car is due
-- for service, keep one thread of what happened with a customer, or make sure a
-- promised follow-up happens. These three tables are the whole addition — every
-- other part of phase 1 reads data that already exists.
--
-- Idempotent throughout: CREATE TABLE IF NOT EXISTS, and index additions
-- guarded on information_schema so a re-run is a no-op.

-- ─────────────────────────────────────────────────────────────────────────
--  customer_activities — the manual half of the Customer 360 timeline.
--
--  Automatic events (enquiry raised, job completed, invoice issued, survey
--  answered) are NOT copied in here; the timeline endpoint reads those from
--  their own tables. Duplicating them would create two sources of truth that
--  drift. This table is only for what staff record by hand: a phone call, a
--  walk-in conversation, a note worth keeping.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_activities (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id   INT NOT NULL,
  customer_id   INT NOT NULL,
  vehicle_id    INT          DEFAULT NULL,
  activity_type ENUM('call_in','call_out','whatsapp','email','visit','note','complaint','other')
                             NOT NULL DEFAULT 'note',
  subject       VARCHAR(200) DEFAULT NULL,
  body          TEXT         DEFAULT NULL,
  -- What this was about, when it relates to a specific record.
  related_type  ENUM('enquiry','work_order','invoice','quote','warranty_claim','none')
                             NOT NULL DEFAULT 'none',
  related_id    INT          DEFAULT NULL,
  occurred_at   DATETIME     NOT NULL,
  created_by    INT          DEFAULT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ca_customer (workshop_id, customer_id, occurred_at),
  KEY idx_ca_vehicle  (vehicle_id),
  KEY idx_ca_related  (related_type, related_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─────────────────────────────────────────────────────────────────────────
--  service_reminders — one row per upcoming service on one vehicle.
--
--  Due by date, by mileage, or both, so "every 6 months or 10,000 km" is
--  expressible. A reminder is generated once per due service and then tracked
--  through to whether it actually brought the car back — without that link the
--  module cannot prove it pays for itself.
--
--  send_channel deliberately mirrors how the customer already reaches us
--  rather than defaulting everyone to SMS.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_reminders (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id        INT NOT NULL,
  customer_id        INT NOT NULL,
  vehicle_id         INT NOT NULL,
  service_type       ENUM('oil_change','brake_repair','diagnostic','bodywork','tire_service',
                          'engine_repair','transmission','electrical','general_maintenance','other')
                                  NOT NULL DEFAULT 'general_maintenance',
  -- Why it is due. Set whichever applies.
  due_at             DATE         DEFAULT NULL,
  due_mileage        INT          DEFAULT NULL,
  -- What we knew at the time it was generated, for the message body.
  last_service_at    DATE         DEFAULT NULL,
  last_service_wo_id INT          DEFAULT NULL,
  current_mileage    INT          DEFAULT NULL,
  status             ENUM('scheduled','due','sent','snoozed','booked','converted','dismissed','expired')
                                  NOT NULL DEFAULT 'scheduled',
  send_channel       ENUM('whatsapp','sms','email','call','none') NOT NULL DEFAULT 'sms',
  sent_at            DATETIME     DEFAULT NULL,
  send_attempts      INT          DEFAULT 0,
  last_error         VARCHAR(300) DEFAULT NULL,
  snoozed_until      DATE         DEFAULT NULL,
  -- Proof of value: the enquiry or job this reminder actually produced.
  converted_enquiry_id    INT     DEFAULT NULL,
  converted_work_order_id INT     DEFAULT NULL,
  converted_at            DATETIME DEFAULT NULL,
  notes              TEXT         DEFAULT NULL,
  created_by         INT          DEFAULT NULL,
  created_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One open reminder per vehicle per service type. Without this the daily
  -- cron would raise a duplicate every morning for the same overdue car.
  UNIQUE KEY uniq_open_reminder (workshop_id, vehicle_id, service_type, due_at),
  KEY idx_sr_due      (workshop_id, status, due_at),
  KEY idx_sr_customer (workshop_id, customer_id),
  KEY idx_sr_vehicle  (vehicle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─────────────────────────────────────────────────────────────────────────
--  crm_tasks — what staff owe customers, across every kind of record.
--
--  The Enquiries page already counts follow-ups due from enquiries.follow_up_at
--  and shows overdue ones in red. That works, but only for enquiries: a promise
--  made on a work order or a complaint is invisible. This generalises it with a
--  polymorphic link, so one list answers "what do I owe anyone today".
--
--  enquiries.follow_up_at is intentionally left alone. Migrating it would break
--  the Enquiries KPI that depends on it; the task list reads both.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_tasks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id   INT NOT NULL,
  title         VARCHAR(200) NOT NULL,
  details       TEXT         DEFAULT NULL,
  task_type     ENUM('follow_up','call_back','quote_chase','collect_payment','check_part',
                     'complaint','reminder','other') NOT NULL DEFAULT 'follow_up',
  priority      ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status        ENUM('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
  -- Who it concerns, when that is known.
  customer_id   INT          DEFAULT NULL,
  vehicle_id    INT          DEFAULT NULL,
  -- What it hangs off. 'none' for a standalone task.
  related_type  ENUM('enquiry','work_order','invoice','quote','warranty_claim','reminder','none')
                             NOT NULL DEFAULT 'none',
  related_id    INT          DEFAULT NULL,
  assigned_to   INT          DEFAULT NULL,
  due_at        DATETIME     DEFAULT NULL,
  completed_at  DATETIME     DEFAULT NULL,
  completed_by  INT          DEFAULT NULL,
  outcome       TEXT         DEFAULT NULL,
  created_by    INT          DEFAULT NULL,
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ct_open     (workshop_id, status, due_at),
  KEY idx_ct_assignee (workshop_id, assigned_to, status, due_at),
  KEY idx_ct_customer (workshop_id, customer_id),
  KEY idx_ct_related  (related_type, related_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ─────────────────────────────────────────────────────────────────────────
--  Marketing consent on the customer.
--
--  Added now, in phase 1, rather than with Campaigns in phase 3. A service
--  reminder about a car we serviced is a service message; a promotion is
--  marketing, and the two are treated differently. Capturing consent from the
--  start costs nothing here and cannot be reconstructed later for customers
--  already on file.
--
--  Default is 0: nobody is opted in by assumption.
-- ─────────────────────────────────────────────────────────────────────────
SET @has_consent := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'customers'
    AND column_name = 'marketing_consent');
SET @sql := IF(@has_consent = 0,
  'ALTER TABLE customers
     ADD COLUMN marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN marketing_consent_at DATETIME DEFAULT NULL,
     ADD COLUMN marketing_consent_source VARCHAR(60) DEFAULT NULL',
  'SELECT "customers.marketing_consent already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Preferred contact channel, used to pick how a reminder is sent.
SET @has_pref := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'customers'
    AND column_name = 'preferred_channel');
SET @sql := IF(@has_pref = 0,
  "ALTER TABLE customers
     ADD COLUMN preferred_channel ENUM('whatsapp','sms','email','call') NOT NULL DEFAULT 'sms'",
  'SELECT "customers.preferred_channel already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
