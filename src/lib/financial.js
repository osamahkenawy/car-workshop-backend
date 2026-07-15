/**
 * Financial Calculation Engine
 *
 * Computes commission, VAT, and net mechanic/workshop payout per work order.
 * Used by work order creation (POST/PUT), invoice creation, and reports.
 *
 * Features:
 *   #60 — Commission Engine (per-work-order platform commission)
 *   #61 — VAT Auto-Application
 *   #62 — Net Workshop Payout Calculation
 */
import { query, execute } from './database.js';

/**
 * Load financial config for a workshop from the settings table.
 * Returns an object with defaults for any missing keys.
 */
export async function getFinancialConfig(workshopId) {
  const rows = await query(
    "SELECT `key`, `value`, `type` FROM settings WHERE workshop_id = ? AND `key` IN ('platform_commission_percent','vat_enabled','vat_rate','vat_number','apply_vat_on_service_fee','apply_vat_on_cash','mechanic_commission_percent','payment_gateway_fee_pct','free_service_min_order','late_settlement_fee_pct','mechanic_earning_type','mechanic_earning_rate','mechanic_earning_cash_pct')",
    [workshopId]
  );

  const parsed = {};
  for (const row of rows) {
    try {
      if (row.type === 'boolean') parsed[row.key] = row.value === 'true';
      else if (row.type === 'number') parsed[row.key] = Number(row.value);
      else parsed[row.key] = row.value;
    } catch {
      parsed[row.key] = row.value;
    }
  }

  return {
    // Commission: use platform_commission_percent first, fall back to mechanic_commission_percent
    commissionPercent: parsed.platform_commission_percent ?? parsed.mechanic_commission_percent ?? 0,
    vatEnabled: parsed.vat_enabled ?? false,
    vatRate: parsed.vat_rate ?? 5,           // UAE default 5%
    vatNumber: parsed.vat_number ?? '',
    applyVatOnServiceFee: parsed.apply_vat_on_service_fee ?? true,
    applyVatOnCash: parsed.apply_vat_on_cash ?? false,
    // #75 — payment gateway fee percentage
    paymentGatewayFeePct: parsed.payment_gateway_fee_pct ?? 0,
    // #65 — service fee waiver threshold (was: free delivery threshold)
    freeServiceMinOrder: parsed.free_service_min_order ?? 0,
    // #109 — late settlement fee
    lateSettlementFeePct: parsed.late_settlement_fee_pct ?? 0,
    // #201 — mechanic earning config
    mechanicEarningType: parsed.mechanic_earning_type ?? 'fixed',        // 'fixed' | 'percentage'
    mechanicEarningRate: parsed.mechanic_earning_rate ?? 0,              // fixed AED amount or % of service fee
    mechanicEarningCashPct: parsed.mechanic_earning_cash_pct ?? 0,      // % of cash amount mechanic earns (usually 0)
  };
}

/**
 * Compute all financial fields for a work order.
 *
 * @param {object} params
 * @param {number} params.serviceFee    — gross service fee
 * @param {number} params.discount      — discount amount
 * @param {number} params.cashAmount    — cash payment amount (if method is cash)
 * @param {object} params.config        — from getFinancialConfig()
 *
 * @returns {{ commissionRate, commissionAmount, vatRate, vatAmount, platformFee, totalAmount, netPayable }}
 */
export function computeWorkOrderFinancials({ serviceFee = 0, discount = 0, cashAmount = 0, config }) {
  const fee = Math.max(0, serviceFee);
  const disc = Math.max(0, discount);

  // ── Commission ──────────────────────────────────────────
  const commissionRate = config.commissionPercent || 0;
  // Commission is % of the service fee (after discount)
  const taxableBase = Math.max(0, fee - disc);
  const commissionAmount = commissionRate > 0
    ? Math.round(taxableBase * (commissionRate / 100) * 100) / 100
    : 0;

  // ── VAT ──────────────────────────────────────────────────
  let vatRate = 0;
  let vatAmount = 0;
  if (config.vatEnabled) {
    vatRate = config.vatRate || 0;
    // VAT applies on the service fee (after discount) by default
    let vatBase = 0;
    if (config.applyVatOnServiceFee) {
      vatBase += taxableBase;
    }
    // Optionally apply VAT on cash amount too (less common)
    if (config.applyVatOnCash) {
      vatBase += cashAmount;
    }
    vatAmount = vatRate > 0
      ? Math.round(vatBase * (vatRate / 100) * 100) / 100
      : 0;
  }

  // ── Platform fee (fixed, if configured in future) ────────
  const platformFee = 0; // Reserved for future use

  // ── #75 Payment gateway fee ──────────────────────────────
  const gatewayFeePct = config.paymentGatewayFeePct || 0;
  const paymentGatewayFee = gatewayFeePct > 0
    ? Math.round(taxableBase * (gatewayFeePct / 100) * 100) / 100
    : 0;

  // ── Total amount — the customer's bill ──────────────────
  // Parts & services (cashAmount) + labor/service fee after discount (taxableBase) + VAT.
  // Parts are pass-through; commission and net payable below stay on the labor portion.
  const cash = Math.max(0, cashAmount);
  const totalAmount = Math.round((cash + taxableBase + vatAmount) * 100) / 100;

  // ── Net payable to workshop ──────────────────────────────
  // Net = service fee - discount - commission - platform fee - gateway fee
  // (VAT is collected and remitted, not part of workshop net)
  const netPayable = Math.round((taxableBase - commissionAmount - platformFee - paymentGatewayFee) * 100) / 100;

  return {
    commissionRate,
    commissionAmount,
    vatRate,
    vatAmount,
    platformFee,
    totalAmount,
    netPayable,
  };
}

/**
 * #65 — Check if a work order qualifies for a service fee waiver
 * (was: "free delivery" — a car workshop equivalent might be a free
 * diagnostic/inspection once the customer's spend crosses a threshold;
 * kept generically named/structured since the underlying config
 * (`free_service_min_order`) is still a simple spend-threshold waiver).
 * @param {number} workshopId
 * @param {number} orderSubtotal — the parts/labor value of the order (not service fee)
 * @returns {Promise<{ feeWaived: boolean, threshold: number }>}
 */
export async function checkServiceFeeWaiver(workshopId, orderSubtotal) {
  try {
    const [row] = await query(
      "SELECT `value` FROM settings WHERE workshop_id = ? AND `key` = 'free_service_min_order'",
      [workshopId]
    );
    const threshold = row ? parseFloat(row.value) || 0 : 0;
    if (threshold > 0 && orderSubtotal >= threshold) {
      return { feeWaived: true, threshold };
    }
    return { feeWaived: false, threshold };
  } catch {
    return { feeWaived: false, threshold: 0 };
  }
}

/**
 * #77 — Get custom service fee for a specific customer.
 * Returns null if no custom fee is configured, meaning use default.
 * @param {number} workshopId
 * @param {number} customerId
 * @returns {Promise<number|null>}
 */
export async function getCustomerCustomServiceFee(workshopId, customerId) {
  try {
    const [row] = await query(
      "SELECT custom_service_fee FROM customers WHERE id = ? AND workshop_id = ? AND custom_service_fee IS NOT NULL",
      [customerId, workshopId]
    );
    if (row && row.custom_service_fee !== null) {
      return parseFloat(row.custom_service_fee);
    }
  } catch { /* column may not exist */ }
  return null;
}

/**
 * #78 — Get city-specific pricing rule.
 * Checks if a pricing rule exists for the given city/emirate.
 * @param {number} workshopId
 * @param {string} city — customer city or emirate
 * @returns {Promise<{ base_price: number, price_per_km: number }|null>}
 */
export async function getCityPricing(workshopId, city) {
  if (!city) return null;
  try {
    const [rule] = await query(
      `SELECT base_price, price_per_km, min_price, max_price FROM service_pricing_rules
       WHERE workshop_id = ? AND is_active = TRUE AND client_type = ?
       ORDER BY id DESC LIMIT 1`,
      [workshopId, city.toLowerCase()]
    );
    if (rule) return rule;
  } catch { /* ignore */ }
  return null;
}

/**
 * #84 — Get category-specific commission rate if configured.
 * Falls back to the workshop default rate.
 * @param {number} workshopId
 * @param {string|null} category
 * @param {string|null} orderType
 * @returns {Promise<number>} commission rate percentage
 */
export async function getCategoryCommissionRate(workshopId, category, orderType) {
  try {
    const rules = await query(
      `SELECT rate FROM commission_rules
       WHERE workshop_id = ? AND is_active = TRUE
         AND (category = ? OR category IS NULL)
         AND (order_type = ? OR order_type IS NULL)
       ORDER BY category DESC, order_type DESC
       LIMIT 1`,
      [workshopId, category || null, orderType || null]
    );
    if (rules.length) return parseFloat(rules[0].rate);
  } catch { /* table may not exist */ }
  return null; // caller should fall back to default
}

/**
 * #100 — Get tiered commission rate based on customer work order volume.
 * @param {number} workshopId
 * @param {number} customerId
 * @returns {Promise<number|null>} commission rate or null if no tiers
 */
export async function getTieredCommissionRate(workshopId, customerId) {
  try {
    // Count work orders this month for the customer
    const [{ count }] = await query(
      `SELECT COUNT(*) as count FROM work_orders
       WHERE workshop_id = ? AND customer_id = ?
       AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())`,
      [workshopId, customerId]
    );
    const tiers = await query(
      `SELECT rate FROM commission_tiers
       WHERE workshop_id = ? AND is_active = TRUE
       AND min_orders <= ? AND (max_orders IS NULL OR max_orders >= ?)
       ORDER BY min_orders DESC LIMIT 1`,
      [workshopId, count, count]
    );
    if (tiers.length) return parseFloat(tiers[0].rate);
  } catch { /* table may not exist */ }
  return null;
}

/**
 * #201 — Compute how much a mechanic earns for a single work order/job.
 *
 * Earning types:
 *   'fixed'      — flat rate per job (e.g. AED 17 per work order)
 *   'percentage'  — % of the work order's service fee
 *
 * @param {object} params
 * @param {number} params.serviceFee — the work order's service fee
 * @param {number} params.cashAmount — cash payment amount (mechanic may earn % of cash handling)
 * @param {object} params.config      — from getFinancialConfig()
 * @returns {{ baseAmount: number, cashBonus: number, netEarning: number }}
 */
export function computeMechanicEarning({ serviceFee = 0, cashAmount = 0, config }) {
  const type = config.mechanicEarningType || 'fixed';
  const rate = parseFloat(config.mechanicEarningRate) || 0;
  const cashPct = parseFloat(config.mechanicEarningCashPct) || 0;

  let baseAmount = 0;
  if (rate > 0) {
    if (type === 'percentage') {
      // Mechanic earns a percentage of the service fee
      baseAmount = Math.round(serviceFee * (rate / 100) * 100) / 100;
    } else {
      // Fixed amount per job
      baseAmount = rate;
    }
  } else {
    // No earning rate configured — mechanic earns the full service fee
    baseAmount = serviceFee;
  }

  // Optional cash handling bonus (% of cash amount)
  const cashBonus = cashPct > 0 && cashAmount > 0
    ? Math.round(cashAmount * (cashPct / 100) * 100) / 100
    : 0;

  const netEarning = Math.round((baseAmount + cashBonus) * 100) / 100;

  return { baseAmount, cashBonus, netEarning };
}

/**
 * #201 — Auto-record a mechanic earning when a work order is completed.
 * Skips if earning already exists for this work order+mechanic, or if rate is 0.
 *
 * @param {object} params
 * @param {number} params.workshopId
 * @param {number} params.mechanicId
 * @param {number} params.workOrderId
 * @param {number} params.serviceFee
 * @param {number} params.cashAmount
 * @returns {Promise<{ id: number, net_amount: number }|null>}
 */
export async function recordMechanicEarning({ workshopId, mechanicId, workOrderId, serviceFee = 0, cashAmount = 0 }) {
  try {
    // Check if earning already recorded for this work order
    const [existing] = await query(
      'SELECT id FROM mechanic_earnings WHERE work_order_id = ? AND mechanic_id = ? AND workshop_id = ?',
      [workOrderId, mechanicId, workshopId]
    );
    if (existing) return null; // already recorded

    const config = await getFinancialConfig(workshopId);
    const { baseAmount, cashBonus, netEarning } = computeMechanicEarning({ serviceFee, cashAmount, config });

    if (netEarning <= 0) return null; // no earning configured

    const result = await execute(
      `INSERT INTO mechanic_earnings (workshop_id, mechanic_id, work_order_id, earning_type, base_amount, bonus, deductions, net_amount, status)
       VALUES (?, ?, ?, 'service', ?, ?, 0, ?, 'pending')`,
      [workshopId, mechanicId, workOrderId, baseAmount, cashBonus, netEarning]
    );

    return { id: result.insertId, net_amount: netEarning };
  } catch (e) {
    console.error('[recordMechanicEarning] Error:', e.message);
    return null;
  }
}
