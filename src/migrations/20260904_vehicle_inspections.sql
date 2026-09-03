-- Vehicle Inspection Form — the walk-around damage check done WITH the customer
-- at intake (journey step 3), and again jointly at handover (journey step 9).
--
-- The form is a car diagram the inspector clicks to drop damage markers, each
-- tagged with a legend code (DS = deep scratch, DD = dents/dings, ...), plus a
-- header snapshot of customer/vehicle details and a customer signature.
--
-- Markers live in a JSON column rather than their own table, matching how this
-- schema already stores similar variable-length inspection data
-- (vehicle_health_checks.inspection_items, qc_checklists.checklist_items,
-- vehicle_receiving.condition_photos). Shape:
--   [{ "id": "m1", "view": "top", "code": "DS", "x": 0.42, "y": 0.31, "note": "" }]
-- x/y are normalised 0..1 within the view's own box, so markers stay correct at
-- any render size. `view` is one of top | left | right | front | rear.
--
-- work_order_id is the anchor (the work order is the job card record in this
-- system today); job_card_id is kept nullable so an inspection can be linked to
-- a job_cards row if/when a Job Cards module starts creating them.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS vehicle_inspections (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id         INT NOT NULL,
  work_order_id       INT NOT NULL,
  job_card_id         INT NULL,
  vehicle_id          INT NULL,
  customer_id         INT NULL,

  inspection_type     ENUM('intake','joint','qc') NOT NULL DEFAULT 'intake'
                      COMMENT 'intake = journey step 3, joint = step 9 handover walk-around',

  -- Header snapshot — captured on the form, kept even if the customer/vehicle
  -- record is edited later (same snapshot pattern as work_orders.customer_name)
  estimate_date       DATE NULL,
  original_estimate   DECIMAL(12,2) NULL,
  customer_name       VARCHAR(255) NULL,
  customer_phone      VARCHAR(50)  NULL,
  customer_email      VARCHAR(255) NULL,
  vehicle_year        VARCHAR(10)  NULL,
  vehicle_make        VARCHAR(100) NULL,
  vehicle_model       VARCHAR(100) NULL,
  vin                 VARCHAR(64)  NULL,
  plate_number        VARCHAR(50)  NULL,
  odometer            INT NULL,

  service_recommended TEXT NULL,
  service_accepted    TEXT NULL,

  marks               JSON NULL COMMENT 'Damage markers: [{id,view,code,x,y,note}]',
  notes               TEXT NULL,
  signature_url       VARCHAR(500) NULL COMMENT 'Customer sign-off on the walk-around',

  status              ENUM('draft','completed') NOT NULL DEFAULT 'draft',
  inspected_by        INT NULL COMMENT 'users.id who carried out the inspection',
  completed_at        DATETIME NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_vi_workshop (workshop_id),
  INDEX idx_vi_work_order (work_order_id),
  INDEX idx_vi_job_card (job_card_id),
  INDEX idx_vi_vehicle (vehicle_id),
  INDEX idx_vi_status (workshop_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
