-- ============================================================
-- Car Workshop SaaS Platform — Full DB Schema
-- Database: car_workshop
--
-- Ported/rebranded from a delivery-service platform schema
-- (pioneer_delivery.sql). Entity renames applied throughout:
--   tenants        -> workshops           (a workshop branch/location)
--   drivers        -> mechanics
--   driver_locations -> mechanic_locations
--   clients        -> customers
--   orders         -> work_orders
--   order_items    -> work_order_items
--   order_status_logs -> work_order_status_logs
--   order_assignments -> work_order_assignments
--   order_scan_logs   -> work_order_scan_logs
--   zones          -> service_bays        (physical bay/lane, not geo-zone)
--   pricing_rules  -> service_pricing_rules
--   packages       -> parts               (inventory parts used in a repair)
-- Plus a NEW `vehicles` table (customer-owned vehicles), not present in the
-- original delivery schema, referenced by work_orders.vehicle_id.
-- ============================================================

CREATE DATABASE IF NOT EXISTS car_workshop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE car_workshop;

-- ============================================================
-- 1. PLANS (subscription tiers — managed by super admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500) DEFAULT NULL,
  max_mechanics INT DEFAULT 10,
  max_users INT DEFAULT 5,
  max_work_orders_per_month INT DEFAULT 1000,
  price_aed DECIMAL(10,2) DEFAULT 0.00,
  setup_fee_aed DECIMAL(10,2) DEFAULT 0.00,
  features JSON,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO plans (name, slug, description, max_mechanics, max_users, max_work_orders_per_month, price_aed, setup_fee_aed, features) VALUES
('Starter', 'starter', '1,000 base work orders and unlimited mechanics and dashboard members', 999999, 999999, 1000, 125.00, 0.00, '["Create and schedule jobs","Unlimited workshops and mechanics","Real-time job status and notifications","1 custom work order field","5 completion photos per job","30 day data history"]'),
('Growth', 'professional', '2,000 base work orders and unlimited mechanics and dashboard members', 999999, 999999, 2000, 225.00, 0.00, '["Everything in Starter","Branded service status page","Custom notification sender ID","3 custom work order fields","Extra completion photos per job (10)","1 year data history"]'),
('Enterprise', 'enterprise', '12,000 base work orders and unlimited mechanics and dashboard members', 999999, 999999, 12000, 415.00, 0.00, '["Everything in Growth","Personalized onboarding","Multi-branch geofencing","10 custom work order fields","5 year data history","Dedicated account manager"]');

-- ============================================================
-- 2. WORKSHOPS (workshop branches/locations using the platform)
-- ============================================================
CREATE TABLE IF NOT EXISTS workshops (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  type ENUM('independent','franchise','dealership','other') DEFAULT 'other',
  plan_id INT,
  status ENUM('active','suspended','trial','cancelled') DEFAULT 'trial',
  logo_url VARCHAR(500),
  logo_url_white VARCHAR(500),
  phone VARCHAR(50),
  email VARCHAR(255),
  address TEXT,
  city VARCHAR(100),
  emirate VARCHAR(100) DEFAULT 'Dubai',
  country VARCHAR(10) DEFAULT 'UAE',
  currency VARCHAR(10) DEFAULT 'AED',
  timezone VARCHAR(50) DEFAULT 'Asia/Dubai',
  trial_ends_at TIMESTAMP NULL,
  billing_cycle_start TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- ============================================================
-- 3. USERS (all platform users — linked to workshop + role)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT,
  full_name VARCHAR(255) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50),
  password VARCHAR(255) NOT NULL,
  role ENUM('super_admin','admin','dispatcher','mechanic','customer') NOT NULL DEFAULT 'admin',
  avatar_url VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  is_owner BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
);

-- ============================================================
-- 4. MECHANICS
-- Note: dropped vehicle_type/vehicle_plate/vehicle_model/vehicle_color columns
-- that existed on the original `drivers` table — those described the driver's
-- OWN delivery vehicle, which has no equivalent for an in-shop mechanic.
-- total_deliveries -> total_jobs_completed.
-- ============================================================
CREATE TABLE IF NOT EXISTS mechanics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  user_id INT,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(255),
  national_id VARCHAR(100),
  license_number VARCHAR(100) COMMENT 'Trade / mechanic certification number',
  specialty ENUM('general','engine','transmission','electrical','bodywork','tires','diagnostics') DEFAULT 'general',
  status ENUM('available','busy','offline','on_break') DEFAULT 'offline',
  is_active BOOLEAN DEFAULT TRUE,
  avatar_url VARCHAR(500),
  photo_url VARCHAR(500),
  rating DECIMAL(3,2) DEFAULT 5.00,
  total_jobs_completed INT DEFAULT 0,
  service_bay_id INT COMMENT 'Preferred/default service bay assignment',
  notes TEXT,
  joined_at DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- 5. SERVICE BAYS (physical bays/lanes within a workshop)
-- Reinterpreted from geographic delivery "zones" (GeoJSON polygon zones) into
-- physical bays/lanes in a workshop — dropped polygon/radius/center_lat/lng/
-- extra_km_fee/max_weight_kg fields that made sense for geo-zones but not bays.
-- ============================================================
CREATE TABLE IF NOT EXISTS service_bays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  bay_number VARCHAR(20),
  bay_type ENUM('general','quick_service','diagnostic','bodywork','tire','alignment') DEFAULT 'general',
  capacity INT DEFAULT 1 COMMENT 'How many vehicles this bay can hold at once',
  color VARCHAR(20) DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
);

-- ============================================================
-- 6. SERVICE PRICING RULES
-- Reinterpreted from delivery pricing_rules — price_per_km/price_per_kg dropped
-- as delivery-specific weight/distance pricing; kept travel_fee_per_km for
-- mobile-mechanic / vehicle-pickup callouts, which IS a real workshop concept.
-- ============================================================
CREATE TABLE IF NOT EXISTS service_pricing_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  service_bay_id INT,
  customer_type ENUM('individual','business','fleet','all') DEFAULT 'all',
  base_price DECIMAL(10,2) NOT NULL DEFAULT 50.00 COMMENT 'Base service call-out / labor fee',
  travel_fee_per_km DECIMAL(10,2) DEFAULT 0.00 COMMENT 'Mobile mechanic / vehicle-pickup travel fee per km',
  min_price DECIMAL(10,2) DEFAULT 20.00,
  max_price DECIMAL(10,2) DEFAULT 5000.00,
  cash_fee_pct DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Cash-payment handling percentage fee',
  express_surcharge DECIMAL(10,2) DEFAULT 25.00 COMMENT 'Rush-job surcharge',
  priority INT DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (service_bay_id) REFERENCES service_bays(id) ON DELETE SET NULL
);

-- ============================================================
-- 6b. SURGE / PEAK-HOUR PRICING RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS surge_rules (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id   INT NOT NULL,
  name          VARCHAR(100) NOT NULL,
  day_of_week   TINYINT COMMENT '0=Sun, 1=Mon … 6=Sat, NULL=all',
  start_hour    TINYINT NOT NULL DEFAULT 0,
  end_hour      TINYINT NOT NULL DEFAULT 23,
  multiplier    DECIMAL(4,2) NOT NULL DEFAULT 1.50,
  service_bay_id INT,
  is_active     TINYINT(1) DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_active (workshop_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 7. CUSTOMERS (car owners / fleet accounts)
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  user_id INT,
  full_name VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) COMMENT 'For fleet / corporate accounts',
  email VARCHAR(255),
  phone VARCHAR(50) NOT NULL,
  phone_alt VARCHAR(50),
  type ENUM('individual','business','fleet','other') DEFAULT 'individual',
  address_line1 TEXT,
  address_line2 TEXT,
  city VARCHAR(100),
  emirate VARCHAR(100) DEFAULT 'Dubai',
  latitude DECIMAL(10,7),
  longitude DECIMAL(10,7),
  credit_limit DECIMAL(10,2) DEFAULT 0.00,
  credit_used DECIMAL(10,2) DEFAULT 0.00,
  tax_exempt TINYINT(1) DEFAULT 0,
  tax_exempt_certificate VARCHAR(255) DEFAULT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- 7b. VEHICLES (NEW — not present in the original delivery schema)
-- Customer-owned vehicles, linked to customers and referenced from work_orders.
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  customer_id INT NOT NULL,
  make VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  year SMALLINT,
  plate_number VARCHAR(50),
  vin VARCHAR(50) COMMENT 'Vehicle Identification Number',
  color VARCHAR(50),
  mileage INT DEFAULT NULL COMMENT 'Odometer reading at last known service, km',
  fuel_type ENUM('petrol','diesel','hybrid','electric','other') DEFAULT 'petrol',
  transmission ENUM('automatic','manual') DEFAULT 'automatic',
  notes TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vehicles_workshop (workshop_id),
  INDEX idx_vehicles_customer (customer_id),
  INDEX idx_vehicles_plate (plate_number),
  INDEX idx_vehicles_vin (vin),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- ============================================================
-- 8. WORK ORDERS (master work order table)
-- Reinterpreted status enum for a workshop lifecycle (delivery-only statuses
-- 'picked_up'/'in_transit'/'returned' dropped or replaced):
--   pending -> confirmed -> assigned -> accepted -> in_progress ->
--   ready_for_pickup -> completed / cancelled
-- 'returned' work maps instead to the separate warranty_claims flow.
-- sender_*/recipient_* fields collapsed into customer + vehicle references,
-- since a work order has no delivery "recipient", just the customer/vehicle.
-- weight/dimensions/category(parcel,food,...) dropped; replaced with
-- service_category describing the kind of workshop job.
-- ============================================================
CREATE TABLE IF NOT EXISTS work_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  work_order_number VARCHAR(100) NOT NULL UNIQUE,
  customer_id INT,
  vehicle_id INT,
  mechanic_id INT,
  service_bay_id INT,
  pricing_rule_id INT,

  -- Customer contact snapshot (kept redundantly on the work order, as the
  -- original schema kept sender/recipient snapshots on the order)
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  customer_email VARCHAR(255),

  -- Drop-off / pickup address (only relevant if vehicle-pickup / mobile
  -- mechanic service applies to this work order)
  dropoff_address TEXT,
  dropoff_lat DECIMAL(10,7),
  dropoff_lng DECIMAL(10,7),

  -- Work order details
  work_order_type ENUM('standard','express','same_day','scheduled','warranty') DEFAULT 'standard',
  service_category ENUM('oil_change','brake_repair','diagnostic','bodywork','tire_service','engine_repair','transmission','electrical','general_maintenance','other') DEFAULT 'general_maintenance',
  description TEXT,
  special_instructions TEXT,

  -- Scheduling
  scheduled_at TIMESTAMP NULL,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  failed_at TIMESTAMP NULL,
  cancelled_at TIMESTAMP NULL,

  -- Payment
  payment_method ENUM('cash','prepaid','credit','wallet') DEFAULT 'cash',
  payment_status ENUM('pending','partial','paid','refunded') DEFAULT 'pending',
  cash_amount DECIMAL(10,2) DEFAULT 0.00,
  cash_collected DECIMAL(10,2) DEFAULT 0.00,
  cash_collected_at TIMESTAMP NULL,
  service_fee DECIMAL(10,2) DEFAULT 0.00,
  discount DECIMAL(10,2) DEFAULT 0.00,
  total_amount DECIMAL(10,2) DEFAULT 0.00,

  -- Financial breakdown (commission/VAT/net payable to workshop)
  commission_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Platform commission % at time of work order',
  commission_amount DECIMAL(12,2) DEFAULT 0.00,
  vat_rate DECIMAL(5,2) DEFAULT 0.00,
  vat_amount DECIMAL(12,2) DEFAULT 0.00,
  platform_fee DECIMAL(12,2) DEFAULT 0.00,
  net_payable DECIMAL(12,2) DEFAULT 0.00,
  calculated_distance_km DECIMAL(8,2) DEFAULT NULL COMMENT 'For mobile-mechanic / vehicle-pickup travel fee calc',

  -- Status
  status ENUM('pending','confirmed','assigned','accepted','in_progress','ready_for_pickup','completed','failed','cancelled') DEFAULT 'pending',
  priority ENUM('normal','urgent','express','vip') DEFAULT 'normal',
  cancellation_reason TEXT,
  failure_reason TEXT,
  estimated_completion_at DATETIME DEFAULT NULL,

  -- Customer-facing service status tracking
  service_status_token VARCHAR(100) UNIQUE,
  pregenerated_token_id INT NULL DEFAULT NULL COMMENT 'Links to a pre-printed service status token when used',
  signature_url VARCHAR(500) COMMENT 'Customer sign-off signature',
  completion_photo_url VARCHAR(500),

  -- Mechanic rating / review left by customer
  mechanic_rating TINYINT UNSIGNED NULL COMMENT '1-5 star rating left by customer',
  mechanic_rated_at TIMESTAMP NULL,
  review_comment TEXT NULL,

  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
  FOREIGN KEY (mechanic_id) REFERENCES mechanics(id) ON DELETE SET NULL,
  FOREIGN KEY (service_bay_id) REFERENCES service_bays(id) ON DELETE SET NULL
);

-- ============================================================
-- 9. WORK ORDER ITEMS (labor/line items — general line items; parts
--    inventory used is tracked separately in the `parts` table)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  quantity INT DEFAULT 1,
  unit_price DECIMAL(10,2) DEFAULT 0.00,
  notes TEXT,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
);

-- ============================================================
-- 10. WORK ORDER STATUS LOGS (full timeline per work order)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_order_status_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_id INT NOT NULL,
  status ENUM('pending','confirmed','assigned','accepted','in_progress','ready_for_pickup','completed','failed','cancelled') NOT NULL,
  changed_by INT COMMENT 'user_id who made the change',
  note TEXT,
  lat DECIMAL(10,7),
  lng DECIMAL(10,7),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
);

-- ============================================================
-- 11. WORK ORDER ASSIGNMENTS (mechanic assignment records)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_order_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_id INT NOT NULL,
  mechanic_id INT NOT NULL,
  assigned_by INT COMMENT 'user_id',
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP NULL,
  rejected_at TIMESTAMP NULL,
  rejection_reason TEXT,
  is_current BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanic_id) REFERENCES mechanics(id) ON DELETE CASCADE
);

-- ============================================================
-- 12. MECHANIC LOCATIONS (GPS ping history — used during vehicle pickup /
--     mobile-mechanic travel, not for in-shop work)
-- ============================================================
CREATE TABLE IF NOT EXISTS mechanic_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  mechanic_id INT NOT NULL,
  work_order_id INT,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  speed DECIMAL(5,2),
  heading DECIMAL(5,2),
  accuracy DECIMAL(8,2),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (mechanic_id) REFERENCES mechanics(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
);

-- ============================================================
-- 13. NOTIFICATIONS LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  type ENUM('sms','whatsapp','push','email') NOT NULL,
  recipient_phone VARCHAR(50),
  recipient_email VARCHAR(255),
  template_key VARCHAR(100),
  message TEXT NOT NULL,
  work_order_id INT,
  user_id INT,
  mechanic_id INT,
  status ENUM('pending','sent','delivered','failed') DEFAULT 'pending',
  error_message TEXT,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notification_templates (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  template_key VARCHAR(80) NOT NULL,
  label       VARCHAR(120) NOT NULL,
  channels    JSON NOT NULL,
  message     TEXT NOT NULL,
  is_active   TINYINT(1) DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  UNIQUE unique_workshop_key (workshop_id, template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 14. WALLETS (workshop commission / cash-payment settlement wallet)
-- ============================================================
CREATE TABLE IF NOT EXISTS wallets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL UNIQUE,
  balance DECIMAL(12,2) DEFAULT 0.00,
  held_balance DECIMAL(12,2) DEFAULT 0.00,
  cash_pending DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Cash collected not yet settled',
  currency VARCHAR(10) DEFAULT 'AED',
  last_transaction_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
);

-- ============================================================
-- 15. WALLET TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  wallet_id INT NOT NULL,
  workshop_id INT NOT NULL,
  type VARCHAR(30) NOT NULL COMMENT 'topup, charge, cash_credit, cash_debit, refund, adjustment',
  earning_type VARCHAR(20) DEFAULT 'cash',
  amount DECIMAL(12,2) NOT NULL,
  balance_before DECIMAL(12,2),
  balance_after DECIMAL(12,2),
  reference VARCHAR(255),
  work_order_id INT,
  description TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL
);

-- ============================================================
-- 16. INVOICES (auto-generated from completed work orders)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  work_order_id INT,
  invoice_number VARCHAR(20) NOT NULL,
  customer_id INT NOT NULL,
  subtotal DECIMAL(12,2) DEFAULT 0,
  discount_amount DECIMAL(12,2) DEFAULT 0,
  discount_type ENUM('fixed','percentage') DEFAULT 'fixed',
  tax_rate DECIMAL(5,2) DEFAULT 5.00 COMMENT 'UAE VAT 5%',
  tax_amount DECIMAL(12,2) DEFAULT 0,
  total_amount DECIMAL(12,2) DEFAULT 0,
  amount_paid DECIMAL(12,2) DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'AED',
  status ENUM('draft','sent','paid','partially_paid','overdue','void','cancelled') DEFAULT 'draft',
  invoice_type VARCHAR(20) DEFAULT 'invoice' COMMENT 'invoice or credit_note',
  original_invoice_id INT DEFAULT NULL,
  payment_method VARCHAR(50),
  paid_at DATETIME NULL,
  due_date DATE NULL,
  notes TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_invoice_number (invoice_number),
  INDEX idx_work_order_id (work_order_id),
  INDEX idx_customer (customer_id),
  INDEX idx_status (status),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE SET NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 17. INVOICE ITEMS (line items in invoices)
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  item_type ENUM('service','parts','cash_fee','discount') DEFAULT 'service',
  description VARCHAR(255) NOT NULL,
  quantity INT DEFAULT 1,
  unit_price DECIMAL(12,2) DEFAULT 0,
  discount DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_invoice (invoice_id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_invoices_workshop ON invoices(workshop_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_created ON invoices(created_at);

-- ============================================================
-- 18. API KEYS (for 3rd party integrations)
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) NOT NULL UNIQUE,
  secret VARCHAR(255),
  permissions JSON COMMENT '["work_orders:create","work_orders:read","service_status:read"]',
  last_used_at TIMESTAMP NULL,
  last_used_ip VARCHAR(45),
  request_count INT DEFAULT 0,
  expires_at TIMESTAMP NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
);

-- ============================================================
-- 19. SETTINGS (per-workshop key-value config)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  `key` VARCHAR(100) NOT NULL,
  `value` TEXT,
  type ENUM('string','number','boolean','json') DEFAULT 'string',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_workshop_key (workshop_id, `key`),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
);

-- ============================================================
-- 20. SUPER ADMINS (platform-level administrators)
-- ============================================================
CREATE TABLE IF NOT EXISTS super_admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role ENUM('super_admin','support') DEFAULT 'super_admin',
  permissions JSON,
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ============================================================
-- 21. ROLES (dynamic per-workshop role/permission modules)
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  name        VARCHAR(100) NOT NULL,
  name_ar     VARCHAR(100) DEFAULT NULL,
  slug        VARCHAR(50)  NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  modules     JSON         DEFAULT NULL,
  is_system   TINYINT(1)   DEFAULT 0,
  is_active   TINYINT(1)   DEFAULT 1,
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_workshop_slug (workshop_id, slug),
  KEY idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- SUBSCRIPTIONS (billing — Stripe-backed)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  plan ENUM('trial', 'starter', 'growth', 'professional', 'enterprise', 'self_hosted') DEFAULT 'trial',
  status ENUM('active', 'trialing', 'trial_expired', 'past_due', 'cancelled', 'paused', 'suspended') DEFAULT 'active',
  max_users INT DEFAULT 5,
  current_users INT DEFAULT 1,
  price_monthly DECIMAL(10, 2) DEFAULT 0,
  price_yearly DECIMAL(10, 2) DEFAULT 0,
  billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  features JSON,
  trial_start DATETIME,
  trial_end DATETIME,
  trial_days INT DEFAULT 14,
  started_at DATETIME,
  current_period_start DATETIME,
  current_period_end DATETIME,
  cancelled_at DATETIME,
  cancel_at_period_end TINYINT(1) DEFAULT 0,
  cancel_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_work_orders_workshop ON work_orders(workshop_id);
CREATE INDEX idx_work_orders_status ON work_orders(status);
CREATE INDEX idx_work_orders_mechanic ON work_orders(mechanic_id);
CREATE INDEX idx_work_orders_customer ON work_orders(customer_id);
CREATE INDEX idx_work_orders_vehicle ON work_orders(vehicle_id);
CREATE INDEX idx_work_orders_service_status_token ON work_orders(service_status_token);
CREATE INDEX idx_work_orders_created ON work_orders(created_at);
CREATE INDEX idx_mechanics_workshop ON mechanics(workshop_id);
CREATE INDEX idx_mechanics_status ON mechanics(status);
CREATE INDEX idx_status_logs_work_order ON work_order_status_logs(work_order_id);
CREATE INDEX idx_mechanic_locations_mechanic ON mechanic_locations(mechanic_id);
CREATE INDEX idx_notifications_workshop ON notifications(workshop_id);
CREATE INDEX idx_wallet_txn_workshop ON wallet_transactions(workshop_id);

-- ============================================================
-- WORK ORDER SCAN LOGS (VIN/plate check-in scan events at drop-off)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_order_scan_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_id INT NOT NULL,
  workshop_id INT NOT NULL,
  scanned_by INT NULL,
  scan_type ENUM('checkin_scan','bay_in','bay_out','pickup_scan','completion_scan') DEFAULT 'checkin_scan',
  lat DECIMAL(10,8) NULL,
  lng DECIMAL(11,8) NULL,
  note TEXT NULL,
  scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_scan_logs_work_order ON work_order_scan_logs(work_order_id);
CREATE INDEX idx_scan_logs_workshop ON work_order_scan_logs(workshop_id);

-- ============================================================
-- PARTS (inventory parts used in a work order/repair — reinterpreted
-- from the original "packages" module, which modeled physical shipping
-- parcels with their own barcode/tracking/recipient/COD/proof-of-delivery.
-- None of that shipping-parcel machinery applies to shop inventory, so this
-- is a much simpler line-item table.)
-- ============================================================
CREATE TABLE IF NOT EXISTS parts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  work_order_id INT NOT NULL,
  part_number VARCHAR(60),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  quantity INT NOT NULL DEFAULT 1,
  unit_cost DECIMAL(10,2) DEFAULT 0.00,
  total_cost DECIMAL(10,2) DEFAULT 0.00,
  warranty_period_days INT DEFAULT 0,
  status ENUM('ordered','in_stock','installed','returned') DEFAULT 'ordered',
  installed_at TIMESTAMP NULL DEFAULT NULL,
  returned_at TIMESTAMP NULL DEFAULT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_parts_workshop (workshop_id),
  INDEX idx_parts_work_order (work_order_id),
  INDEX idx_parts_status (status),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- MECHANIC EARNINGS (labor commission)
-- ============================================================
CREATE TABLE IF NOT EXISTS mechanic_earnings (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  mechanic_id     INT NOT NULL,
  work_order_id   INT DEFAULT NULL,
  earning_type    ENUM('labor','tip','bonus','penalty') DEFAULT 'labor',
  amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  base_amount     DECIMAL(12,2) DEFAULT 0,
  bonus           DECIMAL(12,2) DEFAULT 0,
  deductions      DECIMAL(12,2) DEFAULT 0,
  net_amount      DECIMAL(12,2) DEFAULT 0,
  status          ENUM('pending','paid','cancelled') DEFAULT 'pending',
  notes           TEXT,
  paid_at         DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop_mechanic (workshop_id, mechanic_id),
  INDEX idx_work_order (work_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- COMMISSION RULES / TIERS
-- ============================================================
CREATE TABLE IF NOT EXISTS commission_rules (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  name            VARCHAR(100) NOT NULL,
  service_category VARCHAR(100),
  work_order_type VARCHAR(50),
  rate            DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  min_amount      DECIMAL(12,2) DEFAULT 0,
  is_active       TINYINT(1) DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS commission_tiers (
  id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL,
  min_work_orders INT NOT NULL DEFAULT 0, max_work_orders INT DEFAULT NULL,
  rate DECIMAL(5,2) NOT NULL DEFAULT 10.00, period VARCHAR(20) DEFAULT 'monthly',
  is_active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- REFUNDS
-- ============================================================
CREATE TABLE IF NOT EXISTS refunds (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  work_order_id   INT NOT NULL,
  invoice_id      INT,
  amount          DECIMAL(12,2) NOT NULL,
  reason          TEXT,
  status          ENUM('pending','approved','rejected','completed') DEFAULT 'pending',
  refund_method   VARCHAR(50) DEFAULT 'wallet',
  notes           TEXT,
  requested_by    INT,
  approved_by     INT,
  approved_at     DATETIME,
  completed_at    DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- DISPUTES (customer disputes over billing / service quality)
-- ============================================================
CREATE TABLE IF NOT EXISTS disputes (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  work_order_id   INT,
  invoice_id      INT,
  customer_id     INT,
  amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  status          ENUM('open','investigating','resolved','closed') DEFAULT 'open',
  resolution      TEXT,
  resolved_by     INT,
  resolved_at     DATETIME,
  created_by      INT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  user_id         INT,
  action          VARCHAR(100) NOT NULL,
  entity_type     VARCHAR(50) NOT NULL,
  entity_id       INT,
  old_value       JSON,
  new_value       JSON,
  ip_address      VARCHAR(45),
  user_agent      VARCHAR(500),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_user (user_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- BANK ACCOUNTS / WITHDRAWALS / SETTLEMENT SCHEDULES (billing payout infra)
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_accounts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  account_holder  VARCHAR(255) NOT NULL,
  bank_name       VARCHAR(255) NOT NULL,
  iban            VARCHAR(50) NOT NULL,
  swift_code      VARCHAR(20),
  currency        VARCHAR(10) DEFAULT 'AED',
  is_default      TINYINT(1) DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  bank_account_id INT NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  status          ENUM('pending','approved','processing','completed','rejected') DEFAULT 'pending',
  reference       VARCHAR(100),
  notes           TEXT,
  requested_by    INT,
  approved_by     INT,
  approved_at     DATETIME,
  completed_at    DATETIME,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settlement_schedules (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  frequency       ENUM('daily','weekly','biweekly','monthly') DEFAULT 'weekly',
  next_run        DATETIME,
  payment_method  VARCHAR(50) DEFAULT 'bank_transfer',
  is_active       TINYINT(1) DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- CASH SETTLEMENTS (reconciliation of cash collected at pickup/pay-at-pickup)
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_settlements (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id     INT NOT NULL,
  mechanic_id     INT DEFAULT NULL,
  amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          ENUM('pending_approval','approved','processing','completed','rejected') DEFAULT 'completed',
  approval_threshold DECIMAL(12,2) DEFAULT NULL,
  late_penalty    DECIMAL(12,2) DEFAULT 0,
  settled_at      DATETIME,
  notes           TEXT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_mechanic (mechanic_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- WARRANTY CLAIMS (reinterpreted from delivery "returns" — post-completion
-- rework / warranty requests instead of parcel returns)
-- ============================================================
CREATE TABLE IF NOT EXISTS warranty_claims (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  work_order_id INT NOT NULL,
  customer_id INT,
  reason TEXT NOT NULL,
  status ENUM('requested','approved','rejected','in_progress','resolved','closed') DEFAULT 'requested',
  resolution_notes TEXT,
  resolved_work_order_id INT DEFAULT NULL COMMENT 'New work order created to perform the rework, if any',
  requested_by INT,
  approved_by INT,
  approved_at DATETIME,
  resolved_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id),
  INDEX idx_status (status),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- VEHICLE PICKUP REQUESTS (mobile mechanic / tow pickup of customer vehicle)
-- ============================================================
CREATE TABLE IF NOT EXISTS vehicle_pickup_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  work_order_id INT NOT NULL,
  mechanic_id INT DEFAULT NULL,
  status ENUM('pending','scheduled','mechanic_assigned','arrived','picked_up','failed','cancelled') DEFAULT 'pending',
  scheduled_at DATETIME DEFAULT NULL,
  scheduled_end DATETIME DEFAULT NULL,
  arrived_at DATETIME DEFAULT NULL,
  picked_up_at DATETIME DEFAULT NULL,
  failed_at DATETIME DEFAULT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  proof_photo_url VARCHAR(500) DEFAULT NULL,
  signature_url VARCHAR(500) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  failure_reason TEXT DEFAULT NULL,
  lat DECIMAL(10,7) DEFAULT NULL,
  lng DECIMAL(10,7) DEFAULT NULL,
  created_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_work_order (work_order_id),
  INDEX idx_mechanic (mechanic_id),
  INDEX idx_status (status),
  INDEX idx_scheduled (scheduled_at),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (work_order_id) REFERENCES work_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- COMPLETION PHOTOS (multi-photo proof of completed work, was delivery_photos)
-- ============================================================
CREATE TABLE IF NOT EXISTS completion_photos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id   INT NOT NULL,
  work_order_id INT NOT NULL,
  mechanic_id   INT NOT NULL,
  photo_url     VARCHAR(500) NOT NULL,
  photo_type    ENUM('completion','pickup_proof','damage','other') DEFAULT 'completion',
  caption       VARCHAR(255) DEFAULT NULL,
  lat           DECIMAL(10,7) DEFAULT NULL,
  lng           DECIMAL(10,7) DEFAULT NULL,
  uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cp_workshop_wo (workshop_id, work_order_id),
  INDEX idx_cp_mechanic (mechanic_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- MECHANIC DOCUMENTS (certifications/licenses with expiry tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS mechanic_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  mechanic_id INT NOT NULL,
  doc_type ENUM('trade_certificate','safety_certificate','id_card','other') DEFAULT 'other',
  document_url VARCHAR(500) NOT NULL,
  issued_at DATE,
  expires_at DATE,
  status ENUM('valid','expiring_soon','expired') DEFAULT 'valid',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_mechanic (mechanic_id),
  INDEX idx_expires (expires_at),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanic_id) REFERENCES mechanics(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- PREGENERATED SERVICE STATUS TOKENS (pre-print before work order creation)
-- ============================================================
CREATE TABLE IF NOT EXISTS pregenerated_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  service_status_token VARCHAR(20) NOT NULL,
  barcode_value VARCHAR(20) NOT NULL,
  batch_name VARCHAR(100) DEFAULT NULL,
  is_used TINYINT(1) DEFAULT 0,
  work_order_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  used_at DATETIME DEFAULT NULL,
  expires_at DATETIME DEFAULT NULL,
  INDEX idx_workshop (workshop_id),
  INDEX idx_workshop_unused (workshop_id, is_used),
  INDEX idx_token (service_status_token),
  INDEX idx_barcode (barcode_value),
  UNIQUE KEY unique_token (service_status_token),
  UNIQUE KEY unique_barcode (barcode_value),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- DEVICE TOKENS (FCM push notifications) & PUSH SUBSCRIPTIONS (web-push)
-- ============================================================
CREATE TABLE IF NOT EXISTS device_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT,
  user_id INT NOT NULL,
  device_token VARCHAR(500) NOT NULL,
  platform VARCHAR(20) DEFAULT 'android',
  device_info JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_user_token (user_id, device_token(255)),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT,
  user_id INT NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  subscription JSON NOT NULL,
  user_agent VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- WEBHOOK SUBSCRIPTIONS + LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  url VARCHAR(500) NOT NULL,
  events JSON NOT NULL,
  secret VARCHAR(255),
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT NOT NULL,
  webhook_id INT,
  event VARCHAR(100) NOT NULL,
  payload JSON,
  response_status INT,
  response_body TEXT,
  success TINYINT(1) DEFAULT 0,
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  INDEX idx_webhook (webhook_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- INTEGRATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS integrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL,
  config JSON,
  is_active TINYINT(1) DEFAULT 0,
  last_sync_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_workshop (workshop_id),
  UNIQUE KEY unique_workshop_type (workshop_id, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- LICENSE KEYS (self-hosted deployments)
-- ============================================================
CREATE TABLE IF NOT EXISTS license_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id INT,
  license_key VARCHAR(255) UNIQUE NOT NULL,
  license_type ENUM('trial', 'starter', 'professional', 'enterprise', 'unlimited') DEFAULT 'trial',
  max_users INT DEFAULT 5,
  features JSON,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  is_active TINYINT(1) DEFAULT 1,
  activated_at DATETIME,
  last_validated_at DATETIME,
  validation_count INT DEFAULT 0,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_license_key (license_key),
  INDEX idx_workshop (workshop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
