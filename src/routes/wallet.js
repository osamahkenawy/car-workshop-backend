import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = express.Router();
router.use(authMiddleware);

/**
 * Ported from delivery-service-backend/src/routes/wallet.js.
 * Workshop wallet balance + wallet_transactions per car_workshop.sql
 * (cash_pending, not cod_pending; held_balance kept as-is).
 * Renamed tenant_id -> workshop_id throughout; cod_* -> cash_* throughout.
 */

// GET /api/wallet — get wallet info + recent transactions
router.get('/', async (req, res) => {
  try {
    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) {
      await execute('INSERT INTO wallets (workshop_id) VALUES (?)', [req.workshopId]);
      return res.json({ success: true, data: { balance: 0, cash_pending: 0, held_balance: 0, total_credited: 0, total_debited: 0, transactions: [] } });
    }

    // Compute aggregated totals from transactions
    const [agg] = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ('topup','credit','cash_settled','release','prepaid_settled') THEN ABS(amount) ELSE 0 END), 0) AS total_credited,
         COALESCE(SUM(CASE WHEN type IN ('debit','charge','withdrawal') THEN ABS(amount) ELSE 0 END), 0) AS total_debited
       FROM wallet_transactions WHERE workshop_id = ?`,
      [req.workshopId]
    );

    const transactions = await query(
      `SELECT wt.*, o.work_order_number FROM wallet_transactions wt
       LEFT JOIN work_orders o ON wt.work_order_id = o.id
       WHERE wt.workshop_id = ? ORDER BY wt.created_at DESC LIMIT 50`,
      [req.workshopId]
    );
    return res.json({ success: true, data: { ...wallet, total_credited: agg.total_credited, total_debited: agg.total_debited, transactions } });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
  }
});

// POST /api/wallet/topup — add balance (admin action)
router.post('/topup', async (req, res) => {
  try {
    const { amount, reference, description } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });
    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) {
      await execute('INSERT INTO wallets (workshop_id) VALUES (?)', [req.workshopId]);
      [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    }
    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter = balanceBefore + parseFloat(amount);
    await execute('UPDATE wallets SET balance = ? WHERE workshop_id = ?', [balanceAfter, req.workshopId]);
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by)
       VALUES (?, ?, 'topup', ?, ?, ?, ?, ?, ?)`,
      [wallet.id, req.workshopId, amount, balanceBefore, balanceAfter, reference || null, description || 'Manual top-up', req.user.id]
    );
    return res.json({ success: true, data: { balance: balanceAfter } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Top-up failed' });
  }
});

// GET /api/wallet/transactions
router.get('/transactions', async (req, res) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const pg = parseInt(page, 10) || 1;
    const lim = parseInt(limit, 10) || 50;
    const offset = (pg - 1) * lim;
    let where = 'WHERE wt.workshop_id = ?';
    const params = [req.workshopId];
    if (type) { where += ' AND wt.type = ?'; params.push(type); }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM wallet_transactions wt ${where}`, params
    );
    const txns = await query(
      `SELECT wt.*, o.work_order_number FROM wallet_transactions wt
       LEFT JOIN work_orders o ON wt.work_order_id = o.id
       ${where} ORDER BY wt.created_at DESC LIMIT ${lim} OFFSET ${offset}`,
      params
    );
    return res.json({ success: true, data: txns, total });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// POST /api/wallet/collect-cash — mechanic collected cash, add to pending balance
router.post('/collect-cash', async (req, res) => {
  try {
    const { work_order_id, amount, note } = req.body;
    if (!work_order_id || !amount) return res.status(400).json({ success: false, message: 'work_order_id and amount required' });

    const [order] = await query(
      "SELECT * FROM work_orders WHERE id = ? AND workshop_id = ? AND payment_method = 'cash' AND status = 'completed'",
      [work_order_id, req.workshopId]
    );
    if (!order) return res.status(404).json({ success: false, message: 'Completed cash-payment work order not found' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) {
      await execute('INSERT INTO wallets (workshop_id, balance, cash_pending) VALUES (?, 0, 0)', [req.workshopId]);
      [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    }

    const cashPending = parseFloat(wallet.cash_pending || 0) + parseFloat(amount);
    await execute('UPDATE wallets SET cash_pending = ? WHERE workshop_id = ?', [cashPending, req.workshopId]);
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, work_order_id, reference, description, created_by)
       VALUES (?, ?, 'cash_collected', ?, ?, ?, ?, ?, ?, ?)`,
      [wallet.id, req.workshopId, amount, wallet.balance, wallet.balance, work_order_id,
       `CASH-${order.work_order_number}`, note || `Cash collected for ${order.work_order_number}`, req.user.id]
    );
    await execute("UPDATE work_orders SET cash_collected = ?, cash_collected_at = NOW() WHERE id = ?", [amount, work_order_id]);

    return res.json({ success: true, message: 'Cash collected', data: { cash_pending: cashPending } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Cash collection failed' });
  }
});

// POST /api/wallet/settle-cash — settle cash pending into available balance (remittance)
router.post('/settle-cash', async (req, res) => {
  try {
    const { amount, reference, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet || parseFloat(wallet.cash_pending || 0) < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: 'Insufficient cash pending balance' });
    }

    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter  = balanceBefore + parseFloat(amount);
    const cashPending   = parseFloat(wallet.cash_pending) - parseFloat(amount);

    await execute(
      'UPDATE wallets SET balance = ?, cash_pending = ? WHERE workshop_id = ?',
      [balanceAfter, cashPending, req.workshopId]
    );
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by)
       VALUES (?, ?, 'cash_settled', ?, ?, ?, ?, ?, ?)`,
      [wallet.id, req.workshopId, amount, balanceBefore, balanceAfter, reference || null,
       note || 'Cash settlement — moved to available balance', req.user.id]
    );

    return res.json({ success: true, data: { balance: balanceAfter, cash_pending: cashPending } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Cash settlement failed' });
  }
});

// GET /api/wallet/cash-orders — list of completed cash-payment work orders not yet collected
router.get('/cash-orders', async (req, res) => {
  try {
    const orders = await query(
      `SELECT o.id, o.work_order_number, o.customer_name, o.cash_amount, o.cash_collected,
              o.created_at, o.service_fee, o.cash_collected_at,
              m.full_name as mechanic_name
       FROM work_orders o
       LEFT JOIN mechanics m ON o.mechanic_id = m.id
       WHERE o.workshop_id = ? AND o.payment_method = 'cash' AND o.status = 'completed'
       ORDER BY o.created_at DESC LIMIT 100`,
      [req.workshopId]
    );
    return res.json({ success: true, data: orders });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch cash-payment work orders' });
  }
});

// ═══════════════════════════════════════════════════════════════
// BANK ACCOUNTS CRUD
// ═══════════════════════════════════════════════════════════════

// GET /api/wallet/bank-accounts
router.get('/bank-accounts', async (req, res) => {
  try {
    const accounts = await query(
      'SELECT * FROM bank_accounts WHERE workshop_id = ? ORDER BY is_default DESC, created_at DESC',
      [req.workshopId]
    );
    return res.json({ success: true, data: accounts });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch bank accounts' });
  }
});

// POST /api/wallet/bank-accounts
router.post('/bank-accounts', async (req, res) => {
  try {
    const { account_holder, bank_name, iban, swift_code, currency, is_default } = req.body;
    if (!account_holder || !bank_name || !iban) {
      return res.status(400).json({ success: false, message: 'Account holder, bank name and IBAN required' });
    }
    if (is_default) {
      await execute('UPDATE bank_accounts SET is_default = 0 WHERE workshop_id = ?', [req.workshopId]);
    }
    const result = await execute(
      `INSERT INTO bank_accounts (workshop_id, account_holder, bank_name, iban, swift_code, currency, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.workshopId, account_holder, bank_name, iban, swift_code || null, currency || 'AED', is_default ? 1 : 0]
    );
    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'bank_account.create', entityType: 'bank_account', entityId: result.insertId, newValue: { account_holder, bank_name, iban } });
    const [account] = await query('SELECT * FROM bank_accounts WHERE id = ?', [result.insertId]);
    return res.status(201).json({ success: true, data: account });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to add bank account' });
  }
});

// DELETE /api/wallet/bank-accounts/:id
router.delete('/bank-accounts/:id', async (req, res) => {
  try {
    await execute('DELETE FROM bank_accounts WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    return res.json({ success: true, message: 'Bank account deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to delete bank account' });
  }
});

// ═══════════════════════════════════════════════════════════════
// WALLET WITHDRAWAL FLOW
// ═══════════════════════════════════════════════════════════════

// POST /api/wallet/withdraw — request a withdrawal
router.post('/withdraw', async (req, res) => {
  try {
    const { bank_account_id, amount, notes } = req.body;
    if (!bank_account_id || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'bank_account_id and positive amount required' });
    }
    const [bank] = await query('SELECT * FROM bank_accounts WHERE id = ? AND workshop_id = ?', [bank_account_id, req.workshopId]);
    if (!bank) return res.status(404).json({ success: false, message: 'Bank account not found' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) return res.status(400).json({ success: false, message: 'No wallet found' });

    const available = parseFloat(wallet.balance) - parseFloat(wallet.held_balance || 0);
    if (available < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: `Insufficient available balance. Available: ${available.toFixed(2)}` });
    }

    const result = await execute(
      `INSERT INTO withdrawal_requests (workshop_id, bank_account_id, amount, notes, requested_by)
       VALUES (?, ?, ?, ?, ?)`,
      [req.workshopId, bank_account_id, amount, notes || null, req.user?.id || null]
    );

    // Place hold on the withdrawal amount
    const newHeld = parseFloat(wallet.held_balance || 0) + parseFloat(amount);
    await execute('UPDATE wallets SET held_balance = ? WHERE workshop_id = ?', [newHeld, req.workshopId]);

    // Log transaction
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by, earning_type)
       VALUES (?, ?, 'withdrawal', ?, ?, ?, ?, ?, ?, 'withdrawal')`,
      [wallet.id, req.workshopId, -amount, wallet.balance, wallet.balance, `WD-${result.insertId}`,
       `Withdrawal request #${result.insertId} to ${bank.bank_name}`, req.user?.id || null]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'wallet.withdraw_request', entityType: 'withdrawal', entityId: result.insertId, newValue: { amount, bank_account_id } });

    return res.status(201).json({ success: true, message: 'Withdrawal request submitted', data: { id: result.insertId, amount, status: 'pending' } });
  } catch (err) {
    console.error('Withdrawal error:', err);
    return res.status(500).json({ success: false, message: 'Withdrawal failed' });
  }
});

// GET /api/wallet/withdrawals — list withdrawal requests
router.get('/withdrawals', async (req, res) => {
  try {
    const rows = await query(
      `SELECT w.*, b.bank_name, b.iban, b.account_holder
       FROM withdrawal_requests w
       LEFT JOIN bank_accounts b ON w.bank_account_id = b.id
       WHERE w.workshop_id = ? ORDER BY w.created_at DESC LIMIT 100`,
      [req.workshopId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch withdrawals' });
  }
});

// PATCH /api/wallet/withdrawals/:id — approve/reject (admin)
router.patch('/withdrawals/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!['approved', 'rejected', 'completed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved, rejected or completed' });
    }
    const [wd] = await query('SELECT * FROM withdrawal_requests WHERE id = ? AND workshop_id = ?', [req.params.id, req.workshopId]);
    if (!wd) return res.status(404).json({ success: false, message: 'Withdrawal not found' });
    if (wd.status === 'completed' || wd.status === 'rejected') {
      return res.status(409).json({ success: false, message: `Withdrawal already ${wd.status}` });
    }

    const updates = { status };
    if (status === 'approved') { updates.approved_by = req.user?.id; updates.approved_at = new Date(); }
    if (status === 'completed') { updates.completed_at = new Date(); }

    await execute(
      `UPDATE withdrawal_requests SET status=?, notes=CONCAT(COALESCE(notes,''), ?), approved_by=?, approved_at=?, completed_at=?
       WHERE id = ?`,
      [status, notes ? `\n${notes}` : '', updates.approved_by || wd.approved_by || null,
       updates.approved_at || wd.approved_at || null, updates.completed_at || null, req.params.id]
    );

    // On completion or rejection, update wallet
    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (wallet) {
      if (status === 'completed') {
        // Deduct from balance and release hold
        const newBalance = parseFloat(wallet.balance) - parseFloat(wd.amount);
        const newHeld = Math.max(0, parseFloat(wallet.held_balance || 0) - parseFloat(wd.amount));
        await execute('UPDATE wallets SET balance = ?, held_balance = ? WHERE workshop_id = ?', [newBalance, newHeld, req.workshopId]);
      } else if (status === 'rejected') {
        // Release hold only
        const newHeld = Math.max(0, parseFloat(wallet.held_balance || 0) - parseFloat(wd.amount));
        await execute('UPDATE wallets SET held_balance = ? WHERE workshop_id = ?', [newHeld, req.workshopId]);
      }
    }

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: `withdrawal.${status}`, entityType: 'withdrawal', entityId: parseInt(req.params.id), newValue: { status, amount: wd.amount } });

    return res.json({ success: true, message: `Withdrawal ${status}`, data: { id: wd.id, status } });
  } catch (err) {
    console.error('Withdrawal update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update withdrawal' });
  }
});

// ═══════════════════════════════════════════════════════════════
// HOLD / FREEZE WALLET BALANCE
// ═══════════════════════════════════════════════════════════════

// POST /api/wallet/hold — place a hold on funds
router.post('/hold', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) return res.status(400).json({ success: false, message: 'No wallet found' });

    const available = parseFloat(wallet.balance) - parseFloat(wallet.held_balance || 0);
    if (available < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: 'Insufficient available balance for hold' });
    }

    const newHeld = parseFloat(wallet.held_balance || 0) + parseFloat(amount);
    await execute('UPDATE wallets SET held_balance = ? WHERE workshop_id = ?', [newHeld, req.workshopId]);

    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by)
       VALUES (?, ?, 'hold', ?, ?, ?, ?, ?, ?)`,
      [wallet.id, req.workshopId, amount, wallet.balance, wallet.balance, null,
       reason || 'Funds held', req.user?.id || null]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'wallet.hold', entityType: 'wallet', entityId: wallet.id, newValue: { amount, reason } });

    return res.json({ success: true, message: 'Funds held', data: { held_balance: newHeld, available: parseFloat(wallet.balance) - newHeld } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to hold funds' });
  }
});

// POST /api/wallet/release — release held funds
router.post('/release', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) return res.status(400).json({ success: false, message: 'No wallet found' });

    const held = parseFloat(wallet.held_balance || 0);
    if (held < parseFloat(amount)) {
      return res.status(400).json({ success: false, message: `Only ${held.toFixed(2)} is held` });
    }

    const newHeld = Math.max(0, held - parseFloat(amount));
    await execute('UPDATE wallets SET held_balance = ? WHERE workshop_id = ?', [newHeld, req.workshopId]);

    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by)
       VALUES (?, ?, 'release', ?, ?, ?, ?, ?, ?)`,
      [wallet.id, req.workshopId, amount, wallet.balance, wallet.balance, null,
       reason || 'Funds released', req.user?.id || null]
    );

    return res.json({ success: true, message: 'Funds released', data: { held_balance: newHeld } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to release funds' });
  }
});

// ═══════════════════════════════════════════════════════════════
// NON-CASH SETTLEMENT (credit prepaid earnings into wallet)
// ═══════════════════════════════════════════════════════════════

// POST /api/wallet/settle-prepaid — settle prepaid work order earnings
router.post('/settle-prepaid', async (req, res) => {
  try {
    const { work_order_ids, amount, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    let [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    if (!wallet) {
      await execute('INSERT INTO wallets (workshop_id) VALUES (?)', [req.workshopId]);
      [wallet] = await query('SELECT * FROM wallets WHERE workshop_id = ?', [req.workshopId]);
    }

    const balanceBefore = parseFloat(wallet.balance);
    const balanceAfter = balanceBefore + parseFloat(amount);

    await execute('UPDATE wallets SET balance = ? WHERE workshop_id = ?', [balanceAfter, req.workshopId]);
    await execute(
      `INSERT INTO wallet_transactions (wallet_id, workshop_id, type, amount, balance_before, balance_after, reference, description, created_by, earning_type)
       VALUES (?, ?, 'prepaid_settled', ?, ?, ?, ?, ?, ?, 'prepaid')`,
      [wallet.id, req.workshopId, amount, balanceBefore, balanceAfter,
       work_order_ids?.length ? `PREPAID-${work_order_ids.length}` : null,
       note || `Prepaid work order earnings settlement`, req.user?.id || null]
    );

    await logAudit({ workshopId: req.workshopId, userId: req.user?.id, action: 'wallet.settle_prepaid', entityType: 'wallet', entityId: wallet.id, newValue: { amount, work_order_ids } });

    return res.json({ success: true, data: { balance: balanceAfter }, message: `Settled ${parseFloat(amount).toFixed(2)} in prepaid earnings` });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Prepaid settlement failed' });
  }
});

export default router;
