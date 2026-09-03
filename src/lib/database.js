import mysql from 'mysql2/promise';
import { config } from '../config.js';

// Custom date type casting to avoid timezone issues
// This ensures DATE fields are returned as 'YYYY-MM-DD' strings
const typeCast = function(field, next) {
  if (field.type === 'DATE') {
    const value = field.string();
    return value; // Return as string 'YYYY-MM-DD'
  }
  if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
    const value = field.string();
    return value; // Return as string
  }
  return next();
};

// Create connection pool
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  typeCast: typeCast, // Use custom type casting for dates
});

// Query helper — uses pool.query (not .execute) to avoid prepared-statement issues
// with dynamic SQL (LIMIT/OFFSET, JSON columns, etc.)
export async function query(sql, params = []) {
  const [results] = await pool.query(sql, params);
  return results;
}

// Execute helper (for INSERT, UPDATE, DELETE)
export async function execute(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

// Initialize database and tables
export async function initDatabase() {
  try {
    // Create database if not exists
    const tempPool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });

    await tempPool.execute(`CREATE DATABASE IF NOT EXISTS ${config.db.database}`);
    await tempPool.end();

    console.log(`Database '${config.db.database}' ready`);

    // Create tables
    await createTables();

    // Run migrations for multi-workshop schema
    await runMultiTenantMigrations();

    // Create default workshop and admin
    await createDefaultWorkshopAndAdmin();

    console.log('Database initialization completed');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

async function createTables() {
  // ===========================================
  // MULTI-WORKSHOP CORE TABLES
  // ===========================================

  // Workshops table (Companies/Organizations — each a car workshop business)
  await execute(`
    CREATE TABLE IF NOT EXISTS workshops (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      subdomain VARCHAR(100) UNIQUE,
      domain VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      logo_url VARCHAR(500),
      logo_url_white VARCHAR(500),
      address TEXT,
      city VARCHAR(100),
      emirate VARCHAR(100),
      country VARCHAR(100) DEFAULT 'UAE',
      timezone VARCHAR(50) DEFAULT 'Asia/Dubai',
      currency VARCHAR(10) DEFAULT 'AED',
      language VARCHAR(10) DEFAULT 'en',
      industry VARCHAR(100),
      company_size VARCHAR(50),
      status ENUM('active', 'trial', 'trial_expired', 'suspended', 'cancelled') DEFAULT 'trial',
      trial_ends_at DATETIME,
      settings JSON,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_subdomain (subdomain),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Subscriptions table
  await execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workshop_id INT NOT NULL,
      plan ENUM('trial', 'starter', 'professional', 'enterprise', 'self_hosted') DEFAULT 'trial',
      status ENUM('active', 'trialing', 'trial_expired', 'past_due', 'cancelled', 'paused', 'suspended') DEFAULT 'active',
      max_users INT DEFAULT 5,
      current_users INT DEFAULT 1,
      price_monthly DECIMAL(10, 2) DEFAULT 0,
      price_yearly DECIMAL(10, 2) DEFAULT 0,
      billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
      stripe_customer_id VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      features JSON,
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // License keys table (for self-hosted deployments)
  await execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Integrations table (with workshop_id)
  await execute(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('Tables created/verified successfully');
}

// Run migrations — car-workshop-service only
async function runMultiTenantMigrations() {
  console.log('Running car workshop service migrations...');

  // ── Roles table (required for auth login) ──
  try {
    await execute(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) { /* exists */ }

  // Add role_id column to users if missing
  try {
    await execute('ALTER TABLE users ADD COLUMN role_id INT DEFAULT NULL AFTER role');
  } catch (e) { /* already exists */ }

  // Add password reset columns to users if missing
  try {
    await execute('ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255) NULL');
  } catch (e) { /* already exists */ }
  try {
    await execute('ALTER TABLE users ADD COLUMN password_reset_expires DATETIME NULL');
  } catch (e) { /* already exists */ }
  try {
    await execute('ALTER TABLE users ADD INDEX idx_password_reset_token (password_reset_token)');
  } catch (e) { /* already exists */ }

  // Add pickup_signature_url to work_orders (separate from customer signature_url)
  try {
    await execute('ALTER TABLE work_orders ADD COLUMN pickup_signature_url VARCHAR(512) DEFAULT NULL AFTER pickup_proof_url');
  } catch (e) { /* already exists */ }

  // Add signature_url to pickup_requests
  try {
    await execute('ALTER TABLE pickup_requests ADD COLUMN signature_url VARCHAR(512) DEFAULT NULL AFTER proof_photo_url');
  } catch (e) { /* already exists */ }

  // Seed default roles for every workshop that has no roles yet
  try {
    const workshops = await query('SELECT id FROM workshops');
    const ALL_MODULES = [
      'dashboard','work-orders','job-assignment','mechanics','customers','live-map',
      'service-status','bulk-import','warranty-claims','wallet','invoices',
      'cash-payment','reports','performance','service-bays','pricing','notifications','settings','integrations'
    ];
    const DISPATCHER_MODULES = [
      'dashboard','work-orders','job-assignment','mechanics','customers','live-map',
      'service-status','bulk-import','warranty-claims','wallet','invoices',
      'cash-payment','reports','performance'
    ];
    const MECHANIC_MODULES = ['mechanic-dashboard','my-jobs','mechanic-scan','barcode'];
    const CUSTOMER_MODULES = [];
    const defaults = [
      { name:'Admin', name_ar:'مدير', slug:'admin', desc:'Full access to all modules', modules:ALL_MODULES, is_system:1 },
      { name:'Dispatcher', name_ar:'مرسل', slug:'dispatcher', desc:'Operations and finance access', modules:DISPATCHER_MODULES, is_system:1 },
      { name:'Mechanic', name_ar:'ميكانيكي', slug:'mechanic', desc:'Mechanic-specific tools only', modules:MECHANIC_MODULES, is_system:1 },
      { name:'Customer', name_ar:'عميل', slug:'customer', desc:'Customer portal access', modules:CUSTOMER_MODULES, is_system:1 },
    ];
    for (const t of workshops) {
      for (const r of defaults) {
        try {
          await execute(
            'INSERT INTO roles (workshop_id, name, name_ar, slug, description, modules, is_system) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [t.id, r.name, r.name_ar, r.slug, r.desc, JSON.stringify(r.modules), r.is_system]
          );
        } catch (e) { /* duplicate — skip */ }
      }
    }
    console.log('Roles table + defaults ready');
  } catch (e) { console.log('Roles seed skipped:', e.message); }

  // Add mechanic_rating and mechanic_rated_at columns to work_orders if missing
  try {
    await execute(`ALTER TABLE work_orders ADD COLUMN mechanic_rating TINYINT UNSIGNED NULL COMMENT '1-5 star rating left by customer'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN mechanic_rated_at TIMESTAMP NULL`);
    console.log('Added mechanic_rating columns to work_orders');
  } catch (e) { /* columns already exist */ }

  // Add review_comment column to work_orders for text reviews
  try {
    await execute(`ALTER TABLE work_orders ADD COLUMN review_comment TEXT NULL COMMENT 'Optional text review from customer'`);
    console.log('Added review_comment column to work_orders');
  } catch (e) { /* column already exists */ }

  // Create notification_templates table if missing
  try {
    await execute(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('notification_templates table ready');
  } catch (e) { /* already exists */ }

  // Add financial columns to work_orders: commission, VAT, net payout (#60 #61 #62)
  try {
    await execute(`ALTER TABLE work_orders ADD COLUMN commission_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT 'Platform commission % at time of work order'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN commission_amount DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Computed commission on this work order'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN vat_rate DECIMAL(5,2) DEFAULT 0.00 COMMENT 'VAT % applied at work order time'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN vat_amount DECIMAL(12,2) DEFAULT 0.00 COMMENT 'VAT computed on service_fee'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN platform_fee DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Any extra platform fixed fee'`);
    await execute(`ALTER TABLE work_orders ADD COLUMN net_payable DECIMAL(12,2) DEFAULT 0.00 COMMENT 'Net amount payable to workshop after all deductions'`);
    console.log('Added financial columns (commission, VAT, net_payable) to work_orders');
  } catch (e) { /* columns already exist */ }

  // ── #63 Surge pricing rules table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS surge_rules (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL,
      name VARCHAR(100) NOT NULL, day_of_week TINYINT, start_hour TINYINT NOT NULL DEFAULT 0,
      end_hour TINYINT NOT NULL DEFAULT 23, multiplier DECIMAL(4,2) NOT NULL DEFAULT 1.50,
      service_bay_id INT, is_active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) { /* exists */ }

  // ── Pricing rules: expand customer_type to VARCHAR for flexibility ──
  try { await execute(`ALTER TABLE service_pricing_rules MODIFY COLUMN customer_type VARCHAR(30) DEFAULT 'all'`); } catch (e) {}
  // ── Pricing rules: add priority + description columns ──
  try { await execute(`ALTER TABLE service_pricing_rules ADD COLUMN priority INT DEFAULT 0 AFTER is_active`); } catch (e) {}
  try { await execute(`ALTER TABLE service_pricing_rules ADD COLUMN description TEXT DEFAULT NULL AFTER priority`); } catch (e) {}

  // ── #64 Distance column on work_orders ──
  try { await execute(`ALTER TABLE work_orders ADD COLUMN calculated_distance_km DECIMAL(8,2) DEFAULT NULL`); } catch (e) {}

  // ── #66 Bank accounts + withdrawal requests ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS bank_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, account_holder VARCHAR(255) NOT NULL,
      bank_name VARCHAR(255) NOT NULL, iban VARCHAR(50) NOT NULL, swift_code VARCHAR(20),
      currency VARCHAR(10) DEFAULT 'AED', is_default TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_workshop (workshop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await execute(`CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, bank_account_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL, status ENUM('pending','approved','processing','completed','rejected') DEFAULT 'pending',
      reference VARCHAR(100), notes TEXT, requested_by INT, approved_by INT,
      approved_at DATETIME, completed_at DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id), INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #67 Settlement schedules ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS settlement_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL,
      frequency ENUM('daily','weekly','biweekly','monthly') DEFAULT 'weekly',
      next_run DATETIME, payment_method VARCHAR(50) DEFAULT 'bank_transfer',
      is_active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #69 earning_type on wallet_transactions ──
  try { await execute(`ALTER TABLE wallet_transactions ADD COLUMN earning_type VARCHAR(20) DEFAULT 'cash'`); } catch (e) {}

  // ── #79 held_balance on wallets ──
  try { await execute(`ALTER TABLE wallets ADD COLUMN held_balance DECIMAL(12,2) DEFAULT 0`); } catch (e) {}

  // ── Wallet type ENUM → VARCHAR to support all transaction types ──
  try { await execute(`ALTER TABLE wallet_transactions MODIFY COLUMN type VARCHAR(30) NOT NULL`); } catch (e) {}

  // ── cash_collected_at on work_orders ──
  try { await execute(`ALTER TABLE work_orders ADD COLUMN cash_collected_at TIMESTAMP NULL DEFAULT NULL`); } catch (e) {}

  // ── #84 Commission rules table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS commission_rules (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, name VARCHAR(100) NOT NULL,
      category VARCHAR(100), order_type VARCHAR(50), rate DECIMAL(5,2) NOT NULL DEFAULT 10.00,
      min_amount DECIMAL(12,2) DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_workshop (workshop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #85 Refunds table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS refunds (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, work_order_id INT NOT NULL,
      invoice_id INT, amount DECIMAL(12,2) NOT NULL, reason TEXT,
      status ENUM('pending','approved','rejected','completed') DEFAULT 'pending',
      refund_method VARCHAR(50) DEFAULT 'wallet', requested_by INT, approved_by INT,
      approved_at DATETIME, completed_at DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id), INDEX idx_work_order (work_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── Refunds notes column (for approval workflow) ──
  try { await execute(`ALTER TABLE refunds ADD COLUMN notes TEXT DEFAULT NULL`); } catch (e) {}

  // ── #88 Tax-exempt customer columns ──
  try { await execute(`ALTER TABLE customers ADD COLUMN tax_exempt TINYINT(1) DEFAULT 0`); } catch (e) {}
  try { await execute(`ALTER TABLE customers ADD COLUMN tax_exempt_certificate VARCHAR(255) DEFAULT NULL`); } catch (e) {}

  // ── #77 Custom service fee per customer
  try { await execute(`ALTER TABLE customers ADD COLUMN custom_service_fee DECIMAL(12,2) DEFAULT NULL`); } catch (e) {}

  // ── #89 Invoice type (credit note support) ──
  try { await execute(`ALTER TABLE invoices ADD COLUMN invoice_type VARCHAR(20) DEFAULT 'invoice'`); } catch (e) {}
  try { await execute(`ALTER TABLE invoices ADD COLUMN original_invoice_id INT DEFAULT NULL`); } catch (e) {}

  // ── #93 Audit logs table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, user_id INT,
      action VARCHAR(100) NOT NULL, entity_type VARCHAR(50) NOT NULL, entity_id INT,
      old_value JSON, new_value JSON, ip_address VARCHAR(45), user_agent VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id), INDEX idx_entity (entity_type, entity_id),
      INDEX idx_user (user_id), INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #101 Mechanic earnings table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS mechanic_earnings (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, mechanic_id INT NOT NULL,
      work_order_id INT NOT NULL, earning_type ENUM('job','tip','bonus','penalty') DEFAULT 'job',
      amount DECIMAL(12,2) NOT NULL DEFAULT 0, status ENUM('pending','paid','cancelled') DEFAULT 'pending',
      paid_at DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop_mechanic (workshop_id, mechanic_id), INDEX idx_work_order (work_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // #201 — Add base_amount, bonus, deductions, net_amount, notes to mechanic_earnings
  try { await execute(`ALTER TABLE mechanic_earnings ADD COLUMN base_amount DECIMAL(12,2) DEFAULT 0 AFTER amount`); } catch (e) {}
  try { await execute(`ALTER TABLE mechanic_earnings ADD COLUMN bonus DECIMAL(12,2) DEFAULT 0 AFTER base_amount`); } catch (e) {}
  try { await execute(`ALTER TABLE mechanic_earnings ADD COLUMN deductions DECIMAL(12,2) DEFAULT 0 AFTER bonus`); } catch (e) {}
  try { await execute(`ALTER TABLE mechanic_earnings ADD COLUMN net_amount DECIMAL(12,2) DEFAULT 0 AFTER deductions`); } catch (e) {}
  try { await execute(`ALTER TABLE mechanic_earnings ADD COLUMN notes TEXT DEFAULT NULL AFTER status`); } catch (e) {}
  // Make work_order_id nullable (bonuses/penalties may not be tied to a work order)
  try { await execute(`ALTER TABLE mechanic_earnings MODIFY COLUMN work_order_id INT DEFAULT NULL`); } catch (e) {}

  // ── #108 Disputes table ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS disputes (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL, work_order_id INT,
      invoice_id INT, merchant_id INT, amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL, status ENUM('open','investigating','resolved','closed') DEFAULT 'open',
      resolution TEXT, resolved_by INT, resolved_at DATETIME, created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id), INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #68 Settlement status column on cash_settlements ──
  try { await execute(`ALTER TABLE cash_settlements ADD COLUMN status ENUM('pending_approval','approved','processing','completed','rejected') DEFAULT 'completed'`); } catch (e) {}
  try { await execute(`ALTER TABLE cash_settlements ADD COLUMN approval_threshold DECIMAL(12,2) DEFAULT NULL`); } catch (e) {}

  // ── #100 Commission tiers (performance-based) ──
  try {
    await execute(`CREATE TABLE IF NOT EXISTS commission_tiers (
      id INT AUTO_INCREMENT PRIMARY KEY, workshop_id INT NOT NULL,
      min_orders INT NOT NULL DEFAULT 0, max_orders INT DEFAULT NULL,
      rate DECIMAL(5,2) NOT NULL DEFAULT 10.00, period VARCHAR(20) DEFAULT 'monthly',
      is_active TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_workshop (workshop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) {}

  // ── #109 Late fee config column on cash_settlements ──
  try { await execute(`ALTER TABLE cash_settlements ADD COLUMN late_penalty DECIMAL(12,2) DEFAULT 0`); } catch (e) {}

  // ── Service bays table: add missing columns for radius-based bays + pricing ──
  try { await execute(`ALTER TABLE service_bays ADD COLUMN city VARCHAR(255) DEFAULT NULL AFTER emirate`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN base_service_fee DECIMAL(10,2) DEFAULT 0 AFTER city`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN extra_km_fee DECIMAL(10,2) DEFAULT 0 AFTER base_service_fee`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN max_weight_kg DECIMAL(8,2) DEFAULT NULL AFTER extra_km_fee`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN estimated_minutes INT DEFAULT NULL AFTER max_weight_kg`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN radius DECIMAL(10,2) DEFAULT 5000 AFTER polygon`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN center_lat DECIMAL(10,7) DEFAULT NULL AFTER radius`); } catch (e) {}
  try { await execute(`ALTER TABLE service_bays ADD COLUMN center_lng DECIMAL(10,7) DEFAULT NULL AFTER center_lat`); } catch (e) {}

  // ── Workshops table: ensure emirate column is VARCHAR (not ENUM) for multi-country support ──
  try { await execute(`ALTER TABLE workshops ADD COLUMN emirate VARCHAR(100) DEFAULT NULL AFTER city`); } catch (e) {}
  try { await execute(`ALTER TABLE workshops MODIFY COLUMN emirate VARCHAR(100) DEFAULT NULL`); } catch (e) {}

  // ── Work orders/Customers: ensure emirate columns are VARCHAR for multi-country support ──
  try { await execute(`ALTER TABLE work_orders MODIFY COLUMN customer_emirate VARCHAR(100) DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE customers MODIFY COLUMN emirate VARCHAR(100) DEFAULT NULL`); } catch (e) {}

  // ── Work orders table: add missing columns used by routes but not in original CREATE TABLE ──
  try { await execute(`ALTER TABLE work_orders ADD COLUMN customer_email VARCHAR(255) DEFAULT NULL AFTER customer_phone`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN in_transit_at TIMESTAMP NULL AFTER failed_at`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN returned_at TIMESTAMP NULL AFTER in_transit_at`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN cancelled_at TIMESTAMP NULL AFTER returned_at`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN cash_collected DECIMAL(10,2) DEFAULT 0 AFTER cash_amount`); } catch (e) {}

  // ── MODULE A: Pre-generated barcode tokens (pre-print before work order creation) ──
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS pregenerated_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        tracking_token VARCHAR(20) NOT NULL,
        barcode_value VARCHAR(20) NOT NULL,
        batch_name VARCHAR(100) DEFAULT NULL,
        is_used TINYINT(1) DEFAULT 0,
        work_order_id INT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME DEFAULT NULL,
        expires_at DATETIME DEFAULT NULL,
        INDEX idx_workshop (workshop_id),
        INDEX idx_workshop_unused (workshop_id, is_used),
        INDEX idx_token (tracking_token),
        INDEX idx_barcode (barcode_value),
        UNIQUE KEY unique_token (tracking_token),
        UNIQUE KEY unique_barcode (barcode_value),
        FOREIGN KEY (workshop_id) REFERENCES workshops(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('pregenerated_tokens table ready');
  } catch (e) { /* exists */ }

  // Add pregenerated_token column to work_orders table for linking
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pregenerated_token_id INT DEFAULT NULL`); } catch (e) {}

  // ── MODULE R: Vehicle Pickup/Drop-off Workflow ──
  // Add photo_url column to mechanics table (migration)
  try { await execute(`ALTER TABLE mechanics ADD COLUMN photo_url VARCHAR(500) DEFAULT NULL AFTER avatar_url`); } catch (e) {}

  // Add pickup columns to work_orders table
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_status ENUM('none','pending_pickup','pickup_scheduled','en_route_to_pickup','mechanic_arrived','picked_up','pickup_failed') DEFAULT 'none'`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders MODIFY COLUMN pickup_status ENUM('none','pending_pickup','pickup_scheduled','en_route_to_pickup','mechanic_arrived','picked_up','pickup_failed') DEFAULT 'none'`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_scheduled_at DATETIME DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_scheduled_end DATETIME DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_mechanic_id INT DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_confirmed_at DATETIME DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_notes TEXT DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN pickup_proof_url VARCHAR(500) DEFAULT NULL`); } catch (e) {}

  // Pickup requests table — detailed tracking of each vehicle pickup/drop-off request
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS pickup_requests (
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
        barcode_scanned VARCHAR(100) DEFAULT NULL,
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('pickup_requests table ready');
  } catch (e) { /* exists */ }

  // ── Work order status ENUM ──
  // This used to run an ALTER back to the old delivery-app enum
  // (picked_up/in_transit/delivered/returned) on every server boot, even
  // though car_workshop.sql (the real schema source, applied at deploy time)
  // had long since moved on to the current workshop lifecycle. Since this
  // function runs on every startup via initDatabase(), that stale ALTER was
  // silently reverting the live status column's enum on every restart.
  // Kept in sync with car_workshop.sql's work_orders.status /
  // work_order_status_logs.status definitions — update both together.
  try { await execute(`ALTER TABLE work_orders MODIFY COLUMN status ENUM('pending','confirmed','assigned','accepted','in_progress','inspection','ready_for_pickup','completed','cancelled') DEFAULT 'pending'`); } catch (e) {}
  try { await execute(`ALTER TABLE work_order_status_logs MODIFY COLUMN status ENUM('pending','confirmed','assigned','accepted','in_progress','inspection','ready_for_pickup','completed','cancelled') NOT NULL`); } catch (e) {}

  // ── service_photos table for multi-photo proof of service/repair ──
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS delivery_photos (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id   INT NOT NULL,
        work_order_id INT NOT NULL,
        stop_id       INT DEFAULT NULL,
        mechanic_id   INT NOT NULL,
        photo_url     VARCHAR(500) NOT NULL,
        photo_type    ENUM('proof_of_delivery','pickup_proof','damage','other') DEFAULT 'proof_of_delivery',
        caption       VARCHAR(255) DEFAULT NULL,
        lat           DECIMAL(10,7) DEFAULT NULL,
        lng           DECIMAL(10,7) DEFAULT NULL,
        uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dp_workshop_order (workshop_id, work_order_id),
        INDEX idx_dp_stop (stop_id),
        INDEX idx_dp_mechanic (mechanic_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('delivery_photos table ready');
  } catch (e) { /* exists */ }

  // ── Work orders: add signature_url and proof_of_delivery_url columns ──
  try { await execute(`ALTER TABLE work_orders ADD COLUMN signature_url VARCHAR(500) DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN proof_of_delivery_url VARCHAR(500) DEFAULT NULL`); } catch (e) {}

  // ── Work order stops: add signature_url and proof_photo_url columns ──
  try { await execute(`ALTER TABLE order_stops ADD COLUMN signature_url VARCHAR(500) DEFAULT NULL`); } catch (e) {}
  try { await execute(`ALTER TABLE order_stops ADD COLUMN proof_photo_url VARCHAR(500) DEFAULT NULL`); } catch (e) {}

  // ── Mechanic-app enhancements: priority + estimated completion ──
  try { await execute(`ALTER TABLE work_orders ADD COLUMN priority ENUM('normal','urgent','express','vip') DEFAULT 'normal'`); } catch (e) {}
  try { await execute(`ALTER TABLE work_orders ADD COLUMN estimated_delivery_at DATETIME DEFAULT NULL`); } catch (e) {}

  console.log('Migrations completed');
}

async function createDefaultWorkshopAndAdmin() {
  // Ensure a default workshop exists in the workshops table.
  // JUDGMENT CALL: the original seeded a platform-owner tenant named "Pioneer"
  // (slug 'pioneer'). For the car-workshop domain we keep the same platform-owner
  // pattern but rebrand it as a workshop named "Pioneer Motors" (slug 'pioneer-motors')
  // so the seed still reads naturally as a car workshop business rather than a generic
  // "Demo Workshop" placeholder. Change this to your actual brand name if needed.
  // Car-workshop users/admins are managed via the `users` table (see SQL migration).
  const [workshopExists] = await pool.execute("SELECT id FROM workshops WHERE slug = 'pioneer-motors'");

  if (workshopExists.length === 0) {
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 365); // 1-year active period

    const [workshopResult] = await pool.execute(
      `INSERT INTO workshops (name, slug, subdomain, email, status, trial_ends_at, settings) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'Pioneer Motors',
        'pioneer-motors',
        'pioneer-motors',
        'info@pioneercarservice.com',
        'active',
        trialEnds.toISOString().slice(0, 19).replace('T', ' '),
        JSON.stringify({ isPlatformOwner: true }),
      ]
    );
    const workshopId = workshopResult.insertId;
    console.log('Default workshop created: Pioneer Motors (id=' + workshopId + ')');

    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, features) VALUES (?, ?, ?, ?, ?)`,
      [workshopId, 'enterprise', 'active', 999, JSON.stringify({ all: true })]
    );
  }
}


export default pool;
