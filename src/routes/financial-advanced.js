import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import crypto from 'crypto';

const router = express.Router();
router.use(authMiddleware);

// ═══════════════════════════════════════════════════════════════
// #102 — MULTI-CURRENCY SUPPORT
// ═══════════════════════════════════════════════════════════════

// GET /api/financial/currencies — supported currencies + exchange rates
router.get('/currencies', async (req, res) => {
  try {
    // Default supported currencies
    const defaults = [
      { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ' },
      { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼' },
      { code: 'USD', name: 'US Dollar', symbol: '$' },
      { code: 'EUR', name: 'Euro', symbol: '€' },
      { code: 'GBP', name: 'British Pound', symbol: '£' },
      { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك' },
      { code: 'QAR', name: 'Qatari Riyal', symbol: 'ر.ق' },
      { code: 'BHD', name: 'Bahraini Dinar', symbol: '.د.ب' },
      { code: 'OMR', name: 'Omani Rial', symbol: 'ر.ع.' },
      { code: 'EGP', name: 'Egyptian Pound', symbol: 'ج.م' },
    ];

    // Check for custom rates from settings
    let customRates = {};
    try {
      const [ratesSetting] = await query(
        "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'exchange_rates'",
        [req.workshopId]
      );
      if (ratesSetting) customRates = JSON.parse(ratesSetting.value);
    } catch {}

    // Get workshop's base currency
    const [workshop] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
    const baseCurrency = workshop?.currency || 'AED';

    return res.json({
      success: true,
      data: {
        base_currency: baseCurrency,
        currencies: defaults,
        exchange_rates: customRates,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch currencies' });
  }
});

// POST /api/financial/currencies/rates — update exchange rates
router.post('/currencies/rates', async (req, res) => {
  try {
    const { rates } = req.body; // { USD: 3.67, EUR: 4.01, ... }
    if (!rates || typeof rates !== 'object') return res.status(400).json({ success: false, message: 'rates object required' });

    await execute(
      "INSERT INTO settings (workshop_id, `key`, `value`, `type`) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE `value` = ?",
      [req.workshopId, 'exchange_rates', JSON.stringify(rates), 'json', JSON.stringify(rates)]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'currency.rates_updated', entityType: 'settings', entityId: 0, newValue: rates });

    return res.json({ success: true, message: 'Exchange rates updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update rates' });
  }
});

// POST /api/financial/currencies/convert — convert amount
router.post('/currencies/convert', async (req, res) => {
  try {
    const { amount, from, to } = req.body;
    if (!amount || !from || !to) return res.status(400).json({ success: false, message: 'amount, from, to required' });

    let rates = {};
    try {
      const [ratesSetting] = await query(
        "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'exchange_rates'",
        [req.workshopId]
      );
      if (ratesSetting) rates = JSON.parse(ratesSetting.value);
    } catch {}

    const [workshop] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
    const base = workshop?.currency || 'AED';

    // Convert to base, then to target
    const fromRate = from === base ? 1 : (rates[from] || 1);
    const toRate = to === base ? 1 : (rates[to] || 1);
    const converted = (parseFloat(amount) / fromRate) * toRate;

    return res.json({ success: true, data: { original: parseFloat(amount), from, to, converted: Math.round(converted * 100) / 100, rate: toRate / fromRate } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Conversion failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #103 — ESCROW SYSTEM
// ═══════════════════════════════════════════════════════════════

// GET /api/financial/escrow — list escrow holds
router.get('/escrow', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Use wallet held_balance system as escrow
    const holds = await query(
      `SELECT wt.*, o.work_order_number
       FROM wallet_transactions wt
       LEFT JOIN work_orders o ON wt.work_order_id = o.id
       WHERE wt.workshop_id = ? AND wt.type IN ('charge','adjustment')
       ORDER BY wt.created_at DESC LIMIT ? OFFSET ?`,
      [req.workshopId, parseInt(limit), offset]
    );

    return res.json({ success: true, data: holds });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch escrow holds' });
  }
});

// POST /api/financial/escrow/hold — place funds in escrow
router.post('/escrow/hold', async (req, res) => {
  try {
    const { work_order_id, amount, reason } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'amount required' });

    // Get workshop wallet
    const [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    // Place hold on wallet
    await execute(
      'UPDATE wallets SET held_balance = held_balance + ? WHERE workshop_id = ?',
      [amount, req.workshopId]
    );

    // Record transaction
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, work_order_id, type, amount, balance_before, balance_after, description, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [wallet.id, req.workshopId, work_order_id || null, 'charge', amount, wallet.balance, wallet.balance, reason || 'Escrow hold', req.user?.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'escrow.hold', entityType: 'wallet', entityId: wallet.id, newValue: { amount, work_order_id, reason } });

    return res.json({ success: true, message: `${amount} placed in escrow` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to place escrow hold' });
  }
});

// POST /api/financial/escrow/release — release escrow funds
router.post('/escrow/release', async (req, res) => {
  try {
    const { work_order_id, amount, reason } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'amount required' });

    // Get workshop wallet
    const [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

    const balanceAfter = parseFloat(wallet.balance) + parseFloat(amount);

    // Release from held to available
    await execute(
      'UPDATE wallets SET held_balance = GREATEST(0, held_balance - ?), balance = balance + ? WHERE workshop_id = ?',
      [amount, amount, req.workshopId]
    );

    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, work_order_id, type, amount, balance_before, balance_after, description, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [wallet.id, req.workshopId, work_order_id || null, 'adjustment', amount, wallet.balance, balanceAfter, reason || 'Escrow release', req.user?.id]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'escrow.release', entityType: 'wallet', entityId: wallet.id, newValue: { amount, reason } });

    return res.json({ success: true, message: `${amount} released from escrow` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to release escrow' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #104 — SUBSCRIPTION / RECURRING BILLING PLANS
// ═══════════════════════════════════════════════════════════════

// Runtime table creation
(async () => {
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        billing_cycle ENUM('monthly','quarterly','yearly') DEFAULT 'monthly',
        price DECIMAL(12,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'AED',
        features JSON,
        max_work_orders INT DEFAULT NULL,
        free_services INT DEFAULT 0,
        commission_discount_pct DECIMAL(5,2) DEFAULT 0,
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sp_workshop (workshop_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await execute(`
      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        customer_id INT NOT NULL,
        plan_id INT NOT NULL,
        status ENUM('active','paused','cancelled','expired') DEFAULT 'active',
        started_at DATE NOT NULL,
        expires_at DATE,
        next_billing_date DATE,
        work_orders_used INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cs_workshop (workshop_id),
        INDEX idx_cs_customer (customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch {}
})();

// GET plans
router.get('/subscriptions/plans', async (req, res) => {
  try {
    const plans = await query('SELECT * FROM subscription_plans WHERE workshop_id = ? ORDER BY price', [req.workshopId]);
    return res.json({ success: true, data: plans.map(p => ({ ...p, features: p.features ? JSON.parse(p.features) : [] })) });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch plans' });
  }
});

// POST plan
router.post('/subscriptions/plans', async (req, res) => {
  try {
    const { name, description, billing_cycle, price, features, max_work_orders, free_services, commission_discount_pct } = req.body;
    if (!name || !price) return res.status(400).json({ success: false, message: 'name and price required' });

    const result = await execute(
      `INSERT INTO subscription_plans (workshop_id, name, description, billing_cycle, price, features, max_work_orders, free_services, commission_discount_pct)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, name, description || '', billing_cycle || 'monthly', price,
       features ? JSON.stringify(features) : null, max_work_orders || null, free_services || 0, commission_discount_pct || 0]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create plan' });
  }
});

// PUT plan
router.put('/subscriptions/plans/:id', async (req, res) => {
  try {
    const { name, description, billing_cycle, price, features, max_work_orders, free_services, commission_discount_pct, is_active } = req.body;
    await execute(
      `UPDATE subscription_plans SET name=?, description=?, billing_cycle=?, price=?, features=?,
       max_work_orders=?, free_services=?, commission_discount_pct=?, is_active=? WHERE id=? AND workshop_id=?`,
      [name, description, billing_cycle, price, features ? JSON.stringify(features) : null,
       max_work_orders, free_services, commission_discount_pct, is_active ?? 1, req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Plan updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update plan' });
  }
});

// DELETE plan
router.delete('/subscriptions/plans/:id', async (req, res) => {
  try {
    await execute('DELETE FROM subscription_plans WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Plan deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete plan' });
  }
});

// POST subscribe customer
router.post('/subscriptions/subscribe', async (req, res) => {
  try {
    const { customer_id, plan_id } = req.body;
    if (!customer_id || !plan_id) return res.status(400).json({ success: false, message: 'customer_id and plan_id required' });

    const [plan] = await query('SELECT * FROM subscription_plans WHERE id = ? AND workshop_id = ?', [plan_id, req.workshopId]);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

    const months = plan.billing_cycle === 'yearly' ? 12 : plan.billing_cycle === 'quarterly' ? 3 : 1;
    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + months);
    const nextBilling = new Date(expires);

    const result = await execute(
      `INSERT INTO customer_subscriptions (workshop_id, customer_id, plan_id, started_at, expires_at, next_billing_date)
       VALUES (?,?,?,?,?,?)`,
      [req.workshopId, customer_id, plan_id, now, expires, nextBilling]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'subscription.created', entityType: 'subscription', entityId: result.insertId,
      newValue: { customer_id, plan_id, plan_name: plan.name } });

    return res.status(201).json({ success: true, data: { id: result.insertId, expires_at: expires } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to subscribe customer' });
  }
});

// GET customer subscriptions
router.get('/subscriptions', async (req, res) => {
  try {
    const { customer_id, status } = req.query;
    let where = 'cs.workshop_id = ?';
    const params = [req.workshopId];
    if (customer_id) { where += ' AND cs.customer_id = ?'; params.push(customer_id); }
    if (status) { where += ' AND cs.status = ?'; params.push(status); }

    const subs = await query(
      `SELECT cs.*, sp.name as plan_name, sp.price, sp.billing_cycle, c.full_name as customer_name
       FROM customer_subscriptions cs
       JOIN subscription_plans sp ON cs.plan_id = sp.id
       LEFT JOIN customers c ON cs.customer_id = c.id
       WHERE ${where} ORDER BY cs.created_at DESC`,
      params
    );
    return res.json({ success: true, data: subs });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch subscriptions' });
  }
});

// PATCH cancel/pause subscription
router.patch('/subscriptions/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['paused', 'cancelled', 'active'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
    await execute('UPDATE customer_subscriptions SET status = ? WHERE id = ? AND workshop_id = ?', [status, req.params.id, req.workshopId]);
    return res.json({ success: true, message: `Subscription ${status}` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update subscription' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #105 — RECURRING INVOICES
// ═══════════════════════════════════════════════════════════════

(async () => {
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS recurring_invoices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        customer_id INT NOT NULL,
        frequency ENUM('weekly','biweekly','monthly','quarterly') DEFAULT 'monthly',
        amount DECIMAL(12,2) NOT NULL,
        description VARCHAR(255),
        tax_rate DECIMAL(5,2) DEFAULT 0,
        next_generate_date DATE,
        last_generated_at DATETIME,
        is_active TINYINT DEFAULT 1,
        auto_send TINYINT DEFAULT 0,
        total_generated INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ri_workshop (workshop_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch {}
})();

// CRUD for recurring invoice templates
router.get('/recurring-invoices', async (req, res) => {
  try {
    const rows = await query(
      `SELECT ri.*, c.full_name as customer_name
       FROM recurring_invoices ri LEFT JOIN customers c ON ri.customer_id = c.id
       WHERE ri.workshop_id = ? ORDER BY ri.next_generate_date`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch recurring invoices' });
  }
});

router.post('/recurring-invoices', async (req, res) => {
  try {
    const { customer_id, frequency, amount, description, tax_rate, next_generate_date, auto_send } = req.body;
    if (!customer_id || !amount) return res.status(400).json({ success: false, message: 'customer_id and amount required' });

    const result = await execute(
      `INSERT INTO recurring_invoices (workshop_id, customer_id, frequency, amount, description, tax_rate, next_generate_date, auto_send)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.workshopId, customer_id, frequency || 'monthly', amount, description || 'Recurring service',
       tax_rate || 0, next_generate_date || new Date().toISOString().split('T')[0], auto_send ? 1 : 0]
    );
    return res.status(201).json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create recurring invoice' });
  }
});

router.put('/recurring-invoices/:id', async (req, res) => {
  try {
    const { frequency, amount, description, tax_rate, next_generate_date, auto_send, is_active } = req.body;
    await execute(
      `UPDATE recurring_invoices SET frequency=?, amount=?, description=?, tax_rate=?,
       next_generate_date=?, auto_send=?, is_active=? WHERE id=? AND workshop_id=?`,
      [frequency, amount, description, tax_rate, next_generate_date, auto_send ? 1 : 0, is_active ?? 1, req.params.id, req.workshopId]
    );
    return res.json({ success: true, message: 'Recurring invoice updated' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to update' });
  }
});

router.delete('/recurring-invoices/:id', async (req, res) => {
  try {
    await execute('DELETE FROM recurring_invoices WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Recurring invoice deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete' });
  }
});

// POST generate due recurring invoices
router.post('/recurring-invoices/generate', async (req, res) => {
  try {
    const due = await query(
      `SELECT * FROM recurring_invoices WHERE workshop_id = ? AND is_active = 1
       AND next_generate_date <= CURDATE()`,
      [req.workshopId]
    );

    let generated = 0;
    for (const ri of due) {
      // Generate invoice number
      const [last] = await query("SELECT invoice_number FROM invoices WHERE workshop_id = ? ORDER BY id DESC LIMIT 1", [req.workshopId]);
      const num = last ? parseInt(last.invoice_number.replace('INV-', '')) + 1 : 1;
      const invoiceNumber = `INV-${String(num).padStart(4, '0')}`;

      const taxAmount = ri.tax_rate > 0 ? Math.round(ri.amount * (ri.tax_rate / 100) * 100) / 100 : 0;
      const total = parseFloat(ri.amount) + taxAmount;

      const [_wc] = await query('SELECT currency FROM workshops WHERE id = ?', [req.workshopId]);
      const workshopCurrency = _wc?.currency || 'AED';
      await execute(
        `INSERT INTO invoices (workshop_id, invoice_number, customer_id, subtotal, tax_rate, tax_amount, total_amount, currency, status, notes, invoice_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [req.workshopId, invoiceNumber, ri.customer_id, ri.amount, ri.tax_rate, taxAmount, total, workshopCurrency, 'sent',
         `Generated from recurring template #${ri.id}: ${ri.description}`, 'invoice']
      );

      // Advance next date
      const next = new Date(ri.next_generate_date);
      if (ri.frequency === 'weekly') next.setDate(next.getDate() + 7);
      else if (ri.frequency === 'biweekly') next.setDate(next.getDate() + 14);
      else if (ri.frequency === 'quarterly') next.setMonth(next.getMonth() + 3);
      else next.setMonth(next.getMonth() + 1);

      await execute(
        'UPDATE recurring_invoices SET next_generate_date = ?, last_generated_at = NOW(), total_generated = total_generated + 1 WHERE id = ?',
        [next.toISOString().split('T')[0], ri.id]
      );
      generated++;
    }

    return res.json({ success: true, message: `${generated} invoices generated`, data: { generated } });
  } catch (err) {
    console.error('Recurring generate error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate invoices' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #106 — PAYMENT LINK GENERATION
// ═══════════════════════════════════════════════════════════════

(async () => {
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS payment_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL,
        invoice_id INT,
        token VARCHAR(64) UNIQUE NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'AED',
        description VARCHAR(255),
        customer_name VARCHAR(100),
        customer_email VARCHAR(100),
        status ENUM('active','paid','expired','cancelled') DEFAULT 'active',
        expires_at DATETIME,
        paid_at DATETIME,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pl_workshop (workshop_id),
        INDEX idx_pl_token (token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch {}
})();

// POST generate payment link
router.post('/payment-links', async (req, res) => {
  try {
    const { invoice_id, amount, description, customer_name, customer_email, expires_hours = 72 } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'amount required' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + parseInt(expires_hours));

    const [workshop] = await query('SELECT currency, slug FROM workshops WHERE id = ?', [req.workshopId]);

    const result = await execute(
      `INSERT INTO payment_links (workshop_id, invoice_id, token, amount, currency, description, customer_name, customer_email, expires_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.workshopId, invoice_id || null, token, amount, workshop?.currency || 'AED',
       description || '', customer_name || '', customer_email || '', expiresAt, req.user?.id]
    );

    const paymentUrl = `${req.protocol}://${req.get('host')}/pay/${token}`;

    return res.status(201).json({
      success: true,
      data: {
        id: result.insertId,
        token,
        payment_url: paymentUrl,
        amount,
        expires_at: expiresAt,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to create payment link' });
  }
});

// GET list payment links
router.get('/payment-links', async (req, res) => {
  try {
    const links = await query(
      `SELECT * FROM payment_links WHERE workshop_id = ? ORDER BY created_at DESC LIMIT 100`,
      [req.workshopId]
    );
    return res.json({ success: true, data: links });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch payment links' });
  }
});

// DELETE cancel payment link
router.delete('/payment-links/:id', async (req, res) => {
  try {
    await execute("UPDATE payment_links SET status = 'cancelled' WHERE id = ? AND workshop_id = ?", [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Payment link cancelled' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to cancel link' });
  }
});

// ═══════════════════════════════════════════════════════════════
// #107 — BANK STATEMENT RECONCILIATION
// ═══════════════════════════════════════════════════════════════

// POST /api/financial/bank-reconcile — match bank entries to work orders/invoices
router.post('/bank-reconcile', async (req, res) => {
  try {
    const { entries } = req.body; // Array of { date, amount, reference, description }
    if (!entries || !entries.length) return res.status(400).json({ success: false, message: 'entries[] required' });

    const results = [];
    for (const entry of entries) {
      const matched = { ...entry, matches: [] };

      // Try to match by work order number in reference/description
      const searchText = `${entry.reference || ''} ${entry.description || ''}`;
      const workOrderNumMatch = searchText.match(/WO-\d+/i);
      if (workOrderNumMatch) {
        const [workOrder] = await query(
          'SELECT id, work_order_number, service_fee, status FROM work_orders WHERE work_order_number = ? AND workshop_id = ?',
          [workOrderNumMatch[0], req.workshopId]
        );
        if (workOrder) matched.matches.push({ type: 'work_order', id: workOrder.id, reference: workOrder.work_order_number, amount: workOrder.service_fee, status: workOrder.status });
      }

      // Try to match by invoice number
      const invNumMatch = searchText.match(/INV-\d+/i);
      if (invNumMatch) {
        const [inv] = await query(
          'SELECT id, invoice_number, total_amount, status FROM invoices WHERE invoice_number = ? AND workshop_id = ?',
          [invNumMatch[0], req.workshopId]
        );
        if (inv) matched.matches.push({ type: 'invoice', id: inv.id, reference: inv.invoice_number, amount: parseFloat(inv.total_amount), status: inv.status });
      }

      // Try to match by exact amount if no reference match
      if (matched.matches.length === 0 && entry.amount) {
        const amtMatches = await query(
          `SELECT id, invoice_number, total_amount, status FROM invoices
           WHERE workshop_id = ? AND ABS(total_amount - ?) < 0.01 AND status IN ('sent','overdue')
           LIMIT 5`,
          [req.workshopId, Math.abs(parseFloat(entry.amount))]
        );
        matched.matches.push(...amtMatches.map(m => ({ type: 'invoice', id: m.id, reference: m.invoice_number, amount: parseFloat(m.total_amount), status: m.status })));
      }

      matched.status = matched.matches.length > 0 ? 'matched' : 'unmatched';
      results.push(matched);
    }

    const matchedCount = results.filter(r => r.status === 'matched').length;
    return res.json({
      success: true,
      data: {
        total_entries: entries.length,
        matched: matchedCount,
        unmatched: entries.length - matchedCount,
        results
      }
    });
  } catch (err) {
    console.error('Reconcile error:', err);
    return res.status(500).json({ success: false, message: 'Reconciliation failed' });
  }
});

export default router;
