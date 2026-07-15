/**
 * stripe.js — Stripe payment integration for plan upgrades
 *
 * Endpoints:
 *   POST /api/stripe/create-checkout-session  — first-time subscription via Stripe Checkout
 *   POST /api/stripe/preview-upgrade          — preview prorated cost before upgrading
 *   POST /api/stripe/upgrade-subscription     — upgrade existing subscription with proration
 *   POST /api/stripe/webhook                  — handle Stripe webhook events
 *   POST /api/stripe/verify-session            — verify checkout session & activate plan
 *   GET  /api/stripe/subscription-status      — get current subscription status
 */
import express from 'express';
import Stripe from 'stripe';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendEmail, buildEmailTemplate, getWorkshopBranding } from '../lib/email.js';
import { notifySuperAdminPaymentFailed } from '../lib/trial-enforcer.js';
import { config } from '../config.js';

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set in environment — Stripe features will fail');
}
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Export stripe instance for webhook handler in index.js
export { stripe };

// Guard: if Stripe isn't configured, reject all requests early
const requireStripe = (req, res, next) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }
  next();
};
router.use(requireStripe);

// Plan pricing in AED (converted to fils for Stripe — 1 AED = 100 fils)
// Hardcoded fallback — the primary source of truth is the `plans` DB table
// (same table the landing page reads from via GET /api/public/pricing)
const FALLBACK_PLAN_PRICES = {
  starter: {
    monthly: 12500,   // 125 AED
    yearly: 127500,   // 1275 AED (125 * 12 * 0.85 = 15% discount)
    max_users: 5,
    max_mechanics: 10,
    max_work_orders: 1000,
    baseStops: 1000,
    extraRate: 0.007,
    level: 1,
  },
  growth: {
    monthly: 22500,   // 225 AED
    yearly: 229500,   // 2295 AED (225 * 12 * 0.85 = 15% discount)
    max_users: 20,
    max_mechanics: 50,
    max_work_orders: 3000,
    baseStops: 2000,
    extraRate: 0.01,
    level: 2,
  },
  enterprise: {
    monthly: 41500,   // 415 AED
    yearly: 423300,   // 4233 AED (415 * 12 * 0.85 = 15% discount)
    max_users: 100,
    max_mechanics: 999,
    max_work_orders: 12000,
    baseStops: 12000,
    extraRate: 0.012,
    level: 3,
  },
};

const FALLBACK_PLAN_NAMES = {
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

// ─── Dynamic plan loader (reads from the same DB table the landing page uses) ──
let _dbPlanCache = null;
let _dbPlanCacheTime = 0;
const DB_PLAN_CACHE_TTL = 60_000; // 1 minute

async function loadDbPlans() {
  const now = Date.now();
  if (_dbPlanCache && now - _dbPlanCacheTime < DB_PLAN_CACHE_TTL) return _dbPlanCache;
  try {
    const rows = await query(
      `SELECT slug, name, price_aed, max_mechanics, max_users, max_work_orders_per_month,
              base_stops, extra_rate_aed, sort_order
       FROM plans WHERE is_active = 1 ORDER BY sort_order ASC`
    );
    if (rows?.length) {
      const map = {};
      rows.forEach((r, idx) => {
        const monthlyFils = Math.round(Number(r.price_aed) * 100);
        const yearlyFils = Math.round(monthlyFils * 12 * 0.85);
        map[r.slug] = {
          monthly: monthlyFils,
          yearly: yearlyFils,
          max_users: r.max_users ?? 999999,
          max_mechanics: r.max_mechanics ?? 999999,
          max_work_orders: r.max_work_orders_per_month ?? 1000,
          baseStops: r.base_stops ?? 0,
          extraRate: Number(r.extra_rate_aed) || 0,
          level: idx + 1,
          name: r.name,
        };
      });
      _dbPlanCache = map;
      _dbPlanCacheTime = now;
      return map;
    }
  } catch (err) {
    console.warn('[Stripe] Failed to load plans from DB, using fallback:', err.message);
  }
  return null;
}

/** Get plan config (DB first, then hardcoded fallback) */
async function getPlanPrices() {
  const db = await loadDbPlans();
  return db || FALLBACK_PLAN_PRICES;
}

function getPlanName(planConfig, slug) {
  if (planConfig?.[slug]?.name) return planConfig[slug].name;
  return FALLBACK_PLAN_NAMES[slug] || slug;
}

// ─── Stripe Price Cache ──────────────────────────────────────
// Cache Stripe Price IDs with TTL and max size to prevent memory leaks.
const stripePriceCache = {};
const stripePriceCacheTimestamps = {};
const STRIPE_PRICE_CACHE_TTL = 3600_000; // 1 hour
const STRIPE_PRICE_CACHE_MAX_SIZE = 100;

function getFromPriceCache(key) {
  const ts = stripePriceCacheTimestamps[key];
  if (!ts || Date.now() - ts > STRIPE_PRICE_CACHE_TTL) {
    delete stripePriceCache[key];
    delete stripePriceCacheTimestamps[key];
    return undefined;
  }
  return stripePriceCache[key];
}

function setInPriceCache(key, value) {
  // Evict oldest entries if cache is full
  const keys = Object.keys(stripePriceCache);
  if (keys.length >= STRIPE_PRICE_CACHE_MAX_SIZE) {
    const oldest = keys.sort((a, b) => (stripePriceCacheTimestamps[a] || 0) - (stripePriceCacheTimestamps[b] || 0))[0];
    delete stripePriceCache[oldest];
    delete stripePriceCacheTimestamps[oldest];
  }
  stripePriceCache[key] = value;
  stripePriceCacheTimestamps[key] = Date.now();
}

/** Invalidate all caches (call after plan price changes) */
export function invalidatePlanCaches() {
  _dbPlanCache = null;
  _dbPlanCacheTime = 0;
  Object.keys(stripePriceCache).forEach(k => { delete stripePriceCache[k]; delete stripePriceCacheTimestamps[k]; });
  console.log('[Stripe] All plan caches invalidated');
}

/**
 * Compute dynamic price in fils based on estimated work orders.
 * Formula: base + max(0, estimatedWorkOrders - baseStops) * extraRate
 * Returns price in fils (AED × 100).
 */
function computeDynamicPrice(planConfig, billingCycle, estimatedWorkOrders) {
  const baseFils = planConfig[billingCycle];
  if (!estimatedWorkOrders || estimatedWorkOrders <= 0) return baseFils;

  const baseStops = planConfig.baseStops || 0;
  const extraRate = planConfig.extraRate || 0;
  const extra = Math.max(0, estimatedWorkOrders - baseStops);
  const extraCostAed = extra * extraRate;
  // For yearly billing, charge the extra for 12 months (matching frontend computePrice)
  const multiplier = billingCycle === 'yearly' ? 12 : 1;
  const extraCostFils = Math.round(extraCostAed * multiplier * 100);
  return baseFils + extraCostFils;
}

/**
 * Get or create a Stripe recurring Price for a given plan + billing cycle.
 * If estimatedWorkOrders is provided, creates a custom price for the dynamic amount.
 * Stripe requires a persistent Price object for subscription updates / proration.
 */
async function getOrCreateStripePrice(plan, billingCycle, estimatedWorkOrders = 0, currency = 'aed') {
  const PLAN_PRICES = await getPlanPrices();
  const planConfig = PLAN_PRICES[plan];
  if (!planConfig) throw new Error(`Unknown plan: ${plan}`);

  const unitAmount = estimatedWorkOrders > 0
    ? computeDynamicPrice(planConfig, billingCycle, estimatedWorkOrders)
    : planConfig[billingCycle];

  // Use amount in cache key so different work order volumes get different prices
  const cacheKey = `${plan}_${billingCycle}_${unitAmount}_${currency}`;
  const cached = getFromPriceCache(cacheKey);
  if (cached) return cached;

  const interval = billingCycle === 'yearly' ? 'year' : 'month';
  const planName = getPlanName(PLAN_PRICES, plan);

  // Search for an existing active price with matching metadata
  const existingPrices = await stripe.prices.search({
    query: `active:'true' AND metadata['traseallo_plan']:'${plan}' AND metadata['traseallo_cycle']:'${billingCycle}'`,
    limit: 5,
  });

  // Find one whose unit_amount still matches the DB price
  const match = existingPrices.data.find(p => p.unit_amount === unitAmount);
  if (match) {
    setInPriceCache(cacheKey, match.id);
    console.log(`[Stripe] Found existing price ${match.id} for ${cacheKey}`);
    return match.id;
  }

  // If there are stale prices with old amounts, archive them
  for (const old of existingPrices.data) {
    if (old.unit_amount !== unitAmount) {
      try { await stripe.prices.update(old.id, { active: false }); } catch { /* ignore */ }
      console.log(`[Stripe] Archived stale price ${old.id} (was ${old.unit_amount}, now ${unitAmount})`);
    }
  }

  // Find or create a reusable Product for this plan (avoid duplicates)
  let product;
  const existingProducts = await stripe.products.search({
    query: `active:'true' AND metadata['traseallo_plan']:'${plan}'`,
    limit: 1,
  });
  if (existingProducts.data.length > 0) {
    product = existingProducts.data[0];
  } else {
    product = await stripe.products.create({
      name: `Traseallo ${planName}`,
      description: `${planName} subscription`,
      metadata: { traseallo_plan: plan },
    });
  }

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: unitAmount,
    currency,
    recurring: { interval },
    metadata: { traseallo_plan: plan, traseallo_cycle: billingCycle },
  });

  setInPriceCache(cacheKey, price.id);
  console.log(`[Stripe] Created new price ${price.id} for ${cacheKey}`);
  return price.id;
}

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe checkout session for FIRST-TIME subscription (no existing Stripe sub).
 * If workshop already has a Stripe subscription, returns has_subscription=true so the
 * frontend can use the upgrade-subscription endpoint instead.
 */
router.post('/create-checkout-session', authMiddleware, async (req, res) => {
  try {
    const { plan, billing_cycle = 'monthly' } = req.body;
    const estimated_work_orders = Math.min(500000, Math.max(0, parseInt(req.body.estimated_deliveries ?? req.body.estimated_work_orders) || 0));
    const workshopId = req.workshopId;

    const PLAN_PRICES = await getPlanPrices();

    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan. Choose starter, growth, or enterprise.' });
    }

    if (!['monthly', 'yearly'].includes(billing_cycle)) {
      return res.status(400).json({ success: false, message: 'Invalid billing cycle.' });
    }

    // Check if workshop already has a Stripe subscription → route to upgrade instead
    const [existingSub] = await query(
      "SELECT stripe_subscription_id, stripe_customer_id, plan, billing_cycle AS sub_billing_cycle FROM subscriptions WHERE workshop_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [workshopId]
    );

    if (existingSub?.stripe_subscription_id) {
      return res.json({
        success: true,
        has_subscription: true,
        current_plan: existingSub.plan,
        message: 'You already have an active subscription. Use the upgrade endpoint for proration.',
      });
    }

    // Prevent creating checkout for the same plan user is already on
    if (existingSub && existingSub.plan === plan && (existingSub.sub_billing_cycle || 'monthly') === billing_cycle) {
      return res.status(400).json({
        success: false,
        message: `You are already on the ${getPlanName(PLAN_PRICES, plan)} plan (${billing_cycle}). No payment needed.`,
      });
    }

    const planName = getPlanName(PLAN_PRICES, plan);

    // Get workshop info for metadata
    const [workshop] = await query('SELECT name, email, slug, currency FROM workshops WHERE id = ?', [workshopId]);
    if (!workshop) {
      return res.status(404).json({ success: false, message: 'Workshop not found' });
    }

    // Get or create a persistent Stripe Price (dynamic if estimated_work_orders > 0)
    const priceId = await getOrCreateStripePrice(plan, billing_cycle, estimated_work_orders, (workshop?.currency || 'AED').toLowerCase());

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        workshop_id: String(workshopId),
        plan: plan,
        billing_cycle: billing_cycle,
        workshop_name: workshop.name,
        estimated_deliveries: String(estimated_work_orders || 0),
      },
      customer_email: workshop.email || req.user?.email,
      success_url: `${frontendUrl}/settings?tab=subscription&payment=success&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/settings?tab=subscription&payment=cancelled`,
      allow_promotion_codes: true,
    });

    return res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error('[Stripe] Create checkout session error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create checkout session' });
  }
});

// ─── Proration: Preview ──────────────────────────────────────

/**
 * POST /api/stripe/preview-upgrade
 * Preview the prorated cost of switching to a new plan.
 * Returns the exact amounts Stripe will charge (credit + charge = net).
 */
router.post('/preview-upgrade', authMiddleware, async (req, res) => {
  try {
    const { plan, billing_cycle = 'monthly' } = req.body;
    const estimated_work_orders = Math.min(500000, Math.max(0, parseInt(req.body.estimated_deliveries ?? req.body.estimated_work_orders) || 0));
    const workshopId = req.workshopId;
    const [_wc] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
    const workshopCurrency = _wc?.currency || 'AED';

    const PLAN_PRICES = await getPlanPrices();

    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    // Get current subscription
    const [sub] = await query(
      "SELECT id, plan, billing_cycle, stripe_subscription_id, stripe_customer_id FROM subscriptions WHERE workshop_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [workshopId]
    );

    if (!sub?.stripe_subscription_id) {
      return res.json({
        success: true,
        has_subscription: false,
        message: 'No active Stripe subscription. A full checkout is required.',
        full_amount: PLAN_PRICES[plan][billing_cycle] / 100,
        currency: workshopCurrency,
      });
    }

    // Plan level validation
    const currentLevel = PLAN_PRICES[sub.plan]?.level || 0;
    const newLevel = PLAN_PRICES[plan]?.level || 0;
    const isUpgrade = newLevel > currentLevel;
    const isDowngrade = newLevel < currentLevel;
    const isSamePlan = plan === sub.plan && billing_cycle === (sub.billing_cycle || 'monthly');

    if (isSamePlan) {
      return res.status(400).json({ success: false, message: 'You are already on this plan and billing cycle.' });
    }

    // Retrieve the Stripe subscription to get the current item
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    if (!stripeSub || stripeSub.status === 'canceled') {
      return res.json({
        success: true,
        has_subscription: false,
        message: 'Stripe subscription is no longer active. A full checkout is required.',
        full_amount: PLAN_PRICES[plan][billing_cycle] / 100,
        currency: workshopCurrency,
      });
    }

    const currentItem = stripeSub.items.data[0];
    if (!currentItem) {
      return res.status(500).json({ success: false, message: 'Subscription has no items.' });
    }

    // Get new price ID (dynamic if estimated_work_orders > 0)
    const newPriceId = await getOrCreateStripePrice(plan, billing_cycle, estimated_work_orders, workshopCurrency.toLowerCase());

    // Preview the upcoming invoice with the proposed change
    const prorationDate = Math.floor(Date.now() / 1000);

    const upcomingInvoice = await stripe.invoices.createPreview({
      customer: sub.stripe_customer_id,
      subscription: sub.stripe_subscription_id,
      subscription_details: {
        items: [{
          id: currentItem.id,
          price: newPriceId,
        }],
        proration_date: prorationDate,
      },
    });

    // Parse invoice line items for clear breakdown
    // In Stripe v20+, type/proration may be undefined on createPreview lines
    // Detect proration items by description pattern as fallback
    const lines = upcomingInvoice.lines.data.map(line => ({
      description: line.description,
      amount: line.amount / 100,
      currency: workshopCurrency,
      proration: line.type === 'invoiceitem' || !!line.proration || (line.description && (line.description.includes('Unused time') || line.description.includes('Remaining time'))),
    }));

    // Separate proration items from the next cycle charge
    const prorationItems = lines.filter(l => l.proration);
    const recurringItems = lines.filter(l => !l.proration);

    const creditAmount = prorationItems.filter(l => l.amount < 0).reduce((sum, l) => sum + l.amount, 0);
    const chargeAmount = prorationItems.filter(l => l.amount > 0).reduce((sum, l) => sum + l.amount, 0);
    const prorationNet = prorationItems.reduce((sum, l) => sum + l.amount, 0);

    // Amount due now (proration only — the recurring charge is for next cycle)
    const amountDueNow = Math.max(0, prorationNet);

    // Current period end (when the full new price kicks in)
    const periodEndTs = stripeSub.current_period_end;
    const periodEnd = periodEndTs ? new Date(periodEndTs * 1000) : new Date();
    const periodFormatted = isNaN(periodEnd.getTime())
      ? 'Next billing cycle'
      : periodEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });

    return res.json({
      success: true,
      has_subscription: true,
      is_upgrade: isUpgrade,
      is_downgrade: isDowngrade,
      current_plan: sub.plan,
      current_plan_name: getPlanName(PLAN_PRICES, sub.plan),
      new_plan: plan,
      new_plan_name: getPlanName(PLAN_PRICES, plan),
      billing_cycle,
      proration: {
        credit: parseFloat(creditAmount.toFixed(2)),      // negative number (unused current plan)
        charge: parseFloat(chargeAmount.toFixed(2)),      // positive number (remaining new plan)
        net: parseFloat(prorationNet.toFixed(2)),          // net difference
        amount_due_now: parseFloat(amountDueNow.toFixed(2)),
      },
      next_cycle: {
        amount: computeDynamicPrice(PLAN_PRICES[plan], billing_cycle, estimated_work_orders) / 100,
        date: periodEnd.toISOString(),
        date_formatted: periodFormatted,
      },
      line_items: lines,
      proration_date: prorationDate,
      currency: workshopCurrency,
    });
  } catch (err) {
    console.error('[Stripe] Preview upgrade error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to preview upgrade: ' + err.message });
  }
});

// ─── Proration: Execute Upgrade ──────────────────────────────

/**
 * POST /api/stripe/upgrade-subscription
 * Upgrade (or downgrade) an existing Stripe subscription in-place with proration.
 * Stripe calculates the prorated difference and charges/credits immediately.
 */
router.post('/upgrade-subscription', authMiddleware, async (req, res) => {
  try {
    const { plan, billing_cycle = 'monthly', proration_date } = req.body;
    const estimated_work_orders = Math.min(500000, Math.max(0, parseInt(req.body.estimated_deliveries ?? req.body.estimated_work_orders) || 0));
    const workshopId = req.workshopId;
    const [_wc2] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
    const workshopCurrency = _wc2?.currency || 'AED';

    const PLAN_PRICES = await getPlanPrices();

    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({ success: false, message: 'Invalid plan.' });
    }

    // Get current subscription
    const [sub] = await query(
      "SELECT id, plan, billing_cycle, stripe_subscription_id, stripe_customer_id FROM subscriptions WHERE workshop_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [workshopId]
    );

    if (!sub?.stripe_subscription_id) {
      return res.status(400).json({
        success: false,
        message: 'No active Stripe subscription found. Please use checkout for first-time subscription.',
        needs_checkout: true,
      });
    }

    const currentLevel = PLAN_PRICES[sub.plan]?.level || 0;
    const newLevel = PLAN_PRICES[plan]?.level || 0;
    const isUpgrade = newLevel > currentLevel;
    const isDowngrade = newLevel < currentLevel;
    const isSamePlan = plan === sub.plan && billing_cycle === (sub.billing_cycle || 'monthly');

    if (isSamePlan) {
      return res.status(400).json({ success: false, message: 'You are already on this plan and billing cycle.' });
    }

    // BUG 4 FIX: Block downgrades — require contacting support
    if (isDowngrade) {
      return res.status(400).json({
        success: false,
        message: 'Downgrading your plan is not available through self-service. Please contact support@traseallo.com to request a plan change.',
        downgrade_blocked: true,
        current_plan: sub.plan,
        requested_plan: plan,
      });
    }

    // Retrieve the Stripe subscription
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    if (!stripeSub || stripeSub.status === 'canceled') {
      return res.status(400).json({
        success: false,
        message: 'Stripe subscription is no longer active. Please use checkout.',
        needs_checkout: true,
      });
    }

    const currentItem = stripeSub.items.data[0];
    if (!currentItem) {
      return res.status(500).json({ success: false, message: 'Subscription has no items.' });
    }

    // Get new price ID (dynamic if estimated_work_orders > 0)
    const newPriceId = await getOrCreateStripePrice(plan, billing_cycle, estimated_work_orders, workshopCurrency.toLowerCase());

    // Build update params
    const updateParams = {
      items: [{
        id: currentItem.id,
        price: newPriceId,
      }],
      proration_behavior: 'always_invoice',   // generate & collect proration immediately
      metadata: {
        ...stripeSub.metadata,
        plan: plan,
        billing_cycle: billing_cycle,
        previous_plan: sub.plan,
        upgraded_at: new Date().toISOString(),
        estimated_deliveries: String(estimated_work_orders || 0),
      },
    };

    // Use the same proration_date from preview for consistency
    if (proration_date) {
      updateParams.proration_date = proration_date;
    }

    // Execute the subscription update — expand latest_invoice to verify payment
    updateParams.expand = ['latest_invoice.payment_intent'];
    const updatedSub = await stripe.subscriptions.update(sub.stripe_subscription_id, updateParams);

    // ── CRITICAL: Verify the prorated invoice was actually paid ──
    const latestInvoice = updatedSub.latest_invoice;
    if (latestInvoice && typeof latestInvoice === 'object' && latestInvoice.amount_due > 0) {
      const invoiceStatus = latestInvoice.status;
      const piStatus = latestInvoice.payment_intent?.status;

      if (invoiceStatus !== 'paid') {
        // 3D Secure or additional authentication required
        if (piStatus === 'requires_action' || piStatus === 'requires_confirmation') {
          return res.status(402).json({
            success: false,
            message: 'Payment requires additional authentication. Please complete the verification.',
            requires_action: true,
            payment_intent_client_secret: latestInvoice.payment_intent.client_secret,
            invoice_id: latestInvoice.id,
          });
        }

        // Payment method failed (declined, insufficient funds, etc.)
        // Revert the subscription back to the previous price
        try {
          const revertPriceId = await getOrCreateStripePrice(sub.plan, sub.billing_cycle || 'monthly', 0, workshopCurrency.toLowerCase());
          await stripe.subscriptions.update(sub.stripe_subscription_id, {
            items: [{ id: currentItem.id, price: revertPriceId }],
            proration_behavior: 'none',
            metadata: { ...stripeSub.metadata, plan: sub.plan, billing_cycle: sub.billing_cycle || 'monthly' },
          });
        } catch (revertErr) {
          console.error('[Stripe] Failed to revert subscription after payment failure:', revertErr.message);
        }

        console.error(`[Stripe] Upgrade payment failed for workshop ${workshopId}: invoice=${invoiceStatus}, pi=${piStatus}`);
        return res.status(402).json({
          success: false,
          message: 'Payment failed. Your card was declined or could not be charged. Please update your payment method and try again.',
          payment_failed: true,
        });
      }
    }

    // Payment confirmed — activate new plan in our database
    const planConfig = PLAN_PRICES[plan];
    const periodEndTs = updatedSub.current_period_end;
    const periodEnd = periodEndTs ? new Date(periodEndTs * 1000) : null;
    const periodEndValid = periodEnd && !isNaN(periodEnd.getTime());
    const periodEndSql = periodEndValid
      ? periodEnd.toISOString().slice(0, 19).replace('T', ' ')
      : null;

    if (periodEndSql) {
      await execute(
        `UPDATE subscriptions SET
          plan = ?, status = 'active', max_users = ?, billing_cycle = ?,
          price_monthly = ?, price_yearly = ?,
          current_period_end = ?
        WHERE id = ?`,
        [plan, planConfig.max_users, billing_cycle,
         planConfig.monthly / 100, planConfig.yearly / 100,
         periodEndSql,
         sub.id]
      );
    } else {
      await execute(
        `UPDATE subscriptions SET
          plan = ?, status = 'active', max_users = ?, billing_cycle = ?,
          price_monthly = ?, price_yearly = ?,
          current_period_end = DATE_ADD(NOW(), INTERVAL ? DAY)
        WHERE id = ?`,
        [plan, planConfig.max_users, billing_cycle,
         planConfig.monthly / 100, planConfig.yearly / 100,
         billing_cycle === 'yearly' ? 365 : 30,
         sub.id]
      );
    }

    console.log(`[Stripe] Workshop ${workshopId} ${isUpgrade ? 'upgraded' : 'changed'} from ${sub.plan} to ${plan} (${billing_cycle}) with proration`);

    // Log to platform_invoices (billing audit)
    try {
      await logBillingAudit(workshopId, sub.id, {
        type: isUpgrade ? 'proration_upgrade' : 'proration_change',
        previous_plan: sub.plan,
        new_plan: plan,
        billing_cycle,
        stripe_subscription_id: sub.stripe_subscription_id,
      });
    } catch (auditErr) {
      console.error('[Stripe] Billing audit log failed:', auditErr.message);
    }

    // Send invoice email (non-blocking)
    sendProrationInvoiceEmail(workshopId, sub.plan, plan, billing_cycle, planConfig, isUpgrade).catch(err => {
      console.error('[Stripe] Failed to send proration invoice email:', err.message);
    });

    return res.json({
      success: true,
      message: isUpgrade
        ? `Upgraded to ${getPlanName(PLAN_PRICES, plan)}! Prorated charge applied for the remaining billing period.`
        : `Plan changed to ${getPlanName(PLAN_PRICES, plan)}. Prorated adjustment applied.`,
      plan,
      billing_cycle,
      is_upgrade: isUpgrade,
      current_period_end: periodEndValid ? periodEnd.toISOString() : new Date(Date.now() + (billing_cycle === 'yearly' ? 365 : 30) * 86400000).toISOString(),
    });
  } catch (err) {
    console.error('[Stripe] Upgrade subscription error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to upgrade subscription: ' + err.message });
  }
});

// ─── Billing Audit Log ───────────────────────────────────────

/**
 * Store a billing event in platform_invoices for audit trail.
 */
async function logBillingAudit(workshopId, subscriptionId, details) {
  const invoiceNumber = `PRO-${workshopId}-${Date.now().toString(36).toUpperCase()}`;
  const notes = JSON.stringify(details);
  const [_wc] = await query('SELECT currency FROM workshops WHERE id = ?', [workshopId]);
  const auditCurrency = _wc?.currency || 'AED';

  await execute(
    `INSERT INTO platform_invoices (workshop_id, subscription_id, invoice_number, amount, currency, status, billing_period_start, billing_period_end, paid_at, payment_method, notes)
     VALUES (?, ?, ?, 0, ?, 'paid', CURDATE(), CURDATE(), NOW(), 'stripe_proration', ?)`,
    [workshopId, subscriptionId, invoiceNumber, auditCurrency, notes]
  );

  console.log(`[Billing Audit] ${invoiceNumber} — ${details.type}: ${details.previous_plan} → ${details.new_plan}`);
}

/**
 * Shared: activate a plan for a workshop after confirmed payment
 * Called by both webhook and verify-session endpoints (for first-time checkout)
 */
async function activatePlan(workshopId, plan, billingCycle, stripeSubscriptionId = null, stripeCustomerId = null, stripePeriodEnd = null) {
  const PLAN_PRICES = await getPlanPrices();
  const planConfig = PLAN_PRICES[plan];
  if (!planConfig) {
    console.error(`[Stripe] activatePlan: unknown plan "${plan}"`);
    return false;
  }

  // Use Stripe's actual period end if available, otherwise estimate
  const periodEndSql = stripePeriodEnd
    ? `'${new Date(stripePeriodEnd * 1000).toISOString().slice(0, 19).replace('T', ' ')}'`
    : `DATE_ADD(NOW(), INTERVAL ${billingCycle === 'yearly' ? 365 : 30} DAY)`;

  const [existingSub] = await query(
    'SELECT id, plan, status, stripe_subscription_id FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1',
    [workshopId]
  );

  // BUG 2 FIX: Idempotency guard — if this exact Stripe subscription is already active
  // with the same plan, skip the update to prevent duplicate audit entries / emails
  // from the verify-session + webhook race condition.
  if (
    existingSub &&
    stripeSubscriptionId &&
    existingSub.stripe_subscription_id === stripeSubscriptionId &&
    existingSub.plan === plan &&
    existingSub.status === 'active'
  ) {
    console.log(`[Stripe] activatePlan: workshop ${workshopId} already active on ${plan} with sub ${stripeSubscriptionId} — skipping duplicate`);
    return true;
  }

  if (existingSub) {
    await execute(
      `UPDATE subscriptions SET
        plan = ?, status = 'active', max_users = ?, billing_cycle = ?,
        price_monthly = ?, price_yearly = ?,
        current_period_start = NOW(), current_period_end = ${periodEndSql},
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        stripe_customer_id = COALESCE(?, stripe_customer_id)
      WHERE id = ?`,
      [plan, planConfig.max_users, billingCycle,
       planConfig.monthly / 100, planConfig.yearly / 100,
       stripeSubscriptionId, stripeCustomerId,
       existingSub.id]
    );
  } else {
    await execute(
      `INSERT INTO subscriptions (workshop_id, plan, status, max_users, billing_cycle, price_monthly, price_yearly, started_at, current_period_start, current_period_end, stripe_subscription_id, stripe_customer_id)
       VALUES (?, ?, 'active', ?, ?, ?, ?, NOW(), NOW(), ${periodEndSql}, ?, ?)`,
      [workshopId, plan, planConfig.max_users, billingCycle,
       planConfig.monthly / 100, planConfig.yearly / 100,
       stripeSubscriptionId, stripeCustomerId]
    );
  }

  // Update workshop status to active
  await execute('UPDATE workshops SET status = "active" WHERE id = ?', [workshopId]);

  // Reactivate all users (in case they were deactivated during trial_expired/suspended)
  await execute('UPDATE users SET is_active = 1 WHERE workshop_id = ?', [workshopId]);

  console.log(`[Stripe] Workshop ${workshopId} activated ${plan} (${billingCycle})`);

  // Log billing audit for new subscription
  try {
    const [subRow] = await query('SELECT id FROM subscriptions WHERE workshop_id = ? ORDER BY id DESC LIMIT 1', [workshopId]);
    await logBillingAudit(workshopId, subRow?.id, {
      type: 'new_subscription',
      previous_plan: null,
      new_plan: plan,
      billing_cycle: billingCycle,
      stripe_subscription_id: stripeSubscriptionId,
    });
  } catch (auditErr) {
    console.error('[Stripe] Billing audit log failed:', auditErr.message);
  }

  // Send invoice emails (non-blocking — don't fail the activation)
  sendInvoiceEmails(workshopId, plan, billingCycle, planConfig).catch(err => {
    console.error('[Stripe] Failed to send invoice emails:', err.message);
  });

  return true;
}

// Export activatePlan for use in standalone webhook handler
export { activatePlan };

/**
 * Send invoice email to both company email and all workshop admins after payment.
 */
async function sendInvoiceEmails(workshopId, plan, billingCycle, planConfig) {
  const recipients = await getInvoiceRecipients(workshopId);
  if (recipients.size === 0) return;

  const [workshop] = await query('SELECT id, name, slug, email, currency FROM workshops WHERE id = ?', [workshopId]);
  if (!workshop) return;
  const admins = await query("SELECT email, full_name FROM users WHERE workshop_id = ? AND role = 'admin' AND is_active = 1", [workshopId]);

  const workshopCurrency = workshop?.currency || 'AED';
  const planName = getPlanName(null, plan);
  const priceAED = billingCycle === 'yearly'
    ? (planConfig.yearly / 100).toFixed(2)
    : (planConfig.monthly / 100).toFixed(2);
  const cycleLabel = billingCycle === 'yearly' ? 'Annual' : 'Monthly';
  const invoiceNumber = `INV-${workshopId}-${Date.now().toString(36).toUpperCase()}`;
  const invoiceDate = new Date().toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + (billingCycle === 'yearly' ? 365 : 30));
  const nextBillingDate = periodEnd.toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });

  const branding = await getWorkshopBranding(workshopId);

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;">
      Hi <strong>${admins[0]?.full_name || workshop.name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
      Thank you for your payment! Your plan has been successfully activated.
      Below is your invoice for your records.
    </p>
    ${buildInvoiceBoxHtml(invoiceNumber, invoiceDate, workshop.name, [
      { description: `Traseallo ${planName}`, cycle: cycleLabel, amount: `${workshopCurrency} ${priceAED}` },
    ], `${workshopCurrency} ${priceAED}`)}
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 22px;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#166534;">&#10003; Plan Activated: ${planName}</p>
      <p style="margin:0;font-size:13px;color:#166534;">
        Users: up to <strong>${planConfig.max_users}</strong> &nbsp;&bull;&nbsp;
        Work Orders: up to <strong>${planConfig.max_work_orders?.toLocaleString() || 'unlimited'}/mo</strong> &nbsp;&bull;&nbsp;
        Next billing: <strong>${nextBillingDate}</strong>
      </p>
    </div>
    ${buildContactLineHtml()}`;

  const html = buildEmailTemplate({ branding, accentColor: '#f97316', title: '&#127881; Payment Confirmed — Invoice', subtitle: `Invoice ${invoiceNumber}`, bodyHtml, footerName: branding.name, isSystem: branding.isSystem });
  const subject = `Payment Invoice — ${planName} (${cycleLabel}) — ${workshop.name}`;

  return broadcastEmail(recipients, subject, html, workshopId);
}

/**
 * Send proration invoice email after an in-place upgrade.
 */
async function sendProrationInvoiceEmail(workshopId, previousPlan, newPlan, billingCycle, planConfig, isUpgrade) {
  const recipients = await getInvoiceRecipients(workshopId);
  if (recipients.size === 0) return;

  const [workshop] = await query('SELECT id, name, slug, email, currency FROM workshops WHERE id = ?', [workshopId]);
  if (!workshop) return;
  const admins = await query("SELECT email, full_name FROM users WHERE workshop_id = ? AND role = 'admin' AND is_active = 1", [workshopId]);

  const workshopCurrency = workshop?.currency || 'AED';
  const prevName = getPlanName(null, previousPlan);
  const newName = getPlanName(null, newPlan);
  const cycleLabel = billingCycle === 'yearly' ? 'Annual' : 'Monthly';
  const newPriceAED = (planConfig[billingCycle] / 100).toFixed(2);
  const invoiceNumber = `PRO-${workshopId}-${Date.now().toString(36).toUpperCase()}`;
  const invoiceDate = new Date().toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });

  const branding = await getWorkshopBranding(workshopId);

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;">
      Hi <strong>${admins[0]?.full_name || workshop.name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
      Your plan has been ${isUpgrade ? 'upgraded' : 'changed'} from <strong>${prevName}</strong> to <strong>${newName}</strong>.
      Stripe has automatically calculated the prorated difference for the remaining billing period.
    </p>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:18px 22px;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1e40af;">&#128260; Proration Applied</p>
      <p style="margin:0;font-size:13px;color:#1e40af;">
        You were only charged the <strong>prorated difference</strong> for the remaining days in this billing period.
        Your next full billing cycle will be at the new plan rate of <strong>${workshopCurrency} ${newPriceAED}/${billingCycle === 'yearly' ? 'year' : 'month'}</strong>.
      </p>
    </div>

    ${buildInvoiceBoxHtml(invoiceNumber, invoiceDate, workshop.name, [
      { description: `${prevName} → ${newName}`, cycle: `Prorated (${cycleLabel})`, amount: 'See Stripe receipt' },
    ], 'Prorated — see Stripe receipt')}

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 22px;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#166534;">&#10003; Now Active: ${newName}</p>
      <p style="margin:0;font-size:13px;color:#166534;">
        Users: up to <strong>${planConfig.max_users}</strong> &nbsp;&bull;&nbsp;
        Work Orders: up to <strong>${planConfig.max_work_orders?.toLocaleString() || 'unlimited'}/mo</strong>
      </p>
    </div>

    <p style="margin:0 0 10px;font-size:13px;color:#6b7280;text-align:center;">
      A detailed receipt from Stripe has also been sent to your billing email.
    </p>
    ${buildContactLineHtml()}`;

  const html = buildEmailTemplate({ branding, accentColor: '#8b5cf6', title: isUpgrade ? '&#128640; Plan Upgraded — Prorated Invoice' : '&#128260; Plan Changed — Prorated Invoice', subtitle: `Invoice ${invoiceNumber}`, bodyHtml, footerName: branding.name, isSystem: branding.isSystem });
  const subject = `Plan ${isUpgrade ? 'Upgrade' : 'Change'} Invoice — ${prevName} → ${newName} — ${workshop.name}`;

  return broadcastEmail(recipients, subject, html, workshopId);
}

/**
 * Send payment receipt email for recurring invoice payments (renewals, prorations).
 * Triggered by invoice.paid webhook for non-initial invoices.
 */
async function sendPaymentReceiptEmail(workshopId, plan, billingCycle, stripeInvoice) {
  const recipients = await getInvoiceRecipients(workshopId);
  if (recipients.size === 0) return;

  const [workshop] = await query('SELECT id, name, email FROM workshops WHERE id = ?', [workshopId]);
  if (!workshop) return;
  const admins = await query("SELECT full_name FROM users WHERE workshop_id = ? AND role = 'admin' AND is_active = 1 LIMIT 1", [workshopId]);

  const planName = getPlanName(null, plan);
  const amountAED = (stripeInvoice.amount_paid / 100).toFixed(2);
  const currency = stripeInvoice.currency?.toUpperCase() || 'AED';
  const invoiceNumber = stripeInvoice.number || `REC-${workshopId}-${Date.now().toString(36).toUpperCase()}`;
  const invoiceDate = new Date().toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' });
  const cycleLabel = billingCycle === 'yearly' ? 'Annual' : 'Monthly';

  const billingReason = {
    subscription_cycle: 'Subscription Renewal',
    subscription_update: 'Plan Change (Prorated)',
    manual: 'Manual Payment',
  }[stripeInvoice.billing_reason] || 'Payment';

  const branding = await getWorkshopBranding(workshopId);

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#374151;">
      Hi <strong>${admins[0]?.full_name || workshop.name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
      Your payment has been processed successfully. Here is your receipt.
    </p>
    ${buildInvoiceBoxHtml(invoiceNumber, invoiceDate, workshop.name, [
      { description: `Traseallo ${planName} — ${billingReason}`, cycle: cycleLabel, amount: `${currency} ${amountAED}` },
    ], `${currency} ${amountAED}`)}
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 22px;margin:0 0 24px;">
      <p style="margin:0;font-size:14px;font-weight:700;color:#166534;">&#10003; Payment Successful</p>
      <p style="margin:0;font-size:13px;color:#166534;margin-top:6px;">
        Your <strong>${planName}</strong> (${cycleLabel}) subscription is active.
      </p>
    </div>
    ${stripeInvoice.hosted_invoice_url ? `
    <p style="margin:0 0 10px;font-size:13px;color:#6b7280;text-align:center;">
      <a href="${stripeInvoice.hosted_invoice_url}" style="color:#f97316;text-decoration:none;font-weight:600;">View full invoice on Stripe &rarr;</a>
    </p>` : ''}
    ${buildContactLineHtml()}`;

  const html = buildEmailTemplate({ branding, accentColor: '#10b981', title: '&#9989; Payment Receipt', subtitle: `Invoice ${invoiceNumber}`, bodyHtml, footerName: branding.name, isSystem: branding.isSystem });
  const subject = `Payment Receipt — ${planName} (${cycleLabel}) — ${workshop.name}`;

  return broadcastEmail(recipients, subject, html, workshopId);
}

// ─── Email Helpers ───────────────────────────────────────────

/**
 * Get deduplicated recipient set: workshop email + admin emails
 */
async function getInvoiceRecipients(workshopId) {
  const [workshop] = await query('SELECT email FROM workshops WHERE id = ?', [workshopId]);
  const admins = await query("SELECT email FROM users WHERE workshop_id = ? AND role = 'admin' AND is_active = 1", [workshopId]);
  // BUG 13 FIX: Only include workshop email + admin emails — do NOT include the
  // company/platform SMTP email, as that is the sender not a recipient.
  const recipients = new Set();
  if (workshop?.email) recipients.add(workshop.email);
  for (const a of admins) { if (a.email) recipients.add(a.email); }
  return recipients;
}

/**
 * Send an email to all recipients in a set.
 */
async function broadcastEmail(recipients, subject, html, workshopId) {
  const results = [];
  for (const to of recipients) {
    const result = await sendEmail({ to, subject, html, tenantId: workshopId });
    results.push({ to, ...result });
    console.log(`[Invoice Email] ${result.success ? '✅' : '❌'} Sent to ${to}`);
  }
  return results;
}

/**
 * Build a reusable invoice table HTML block.
 */
function buildInvoiceBoxHtml(invoiceNumber, invoiceDate, companyName, lineItems, totalLabel) {
  const rows = lineItems.map(item => `
    <tr>
      <td style="padding:14px;font-size:14px;color:#1e293b;font-weight:600;">${item.description}</td>
      <td align="center" style="padding:14px;font-size:14px;color:#6b7280;">${item.cycle}</td>
      <td align="right" style="padding:14px;font-size:14px;color:#1e293b;font-weight:600;">${item.amount}</td>
    </tr>`).join('');

  return `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:28px;margin:0 0 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
        <tr>
          <td style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Invoice Number</td>
          <td align="right" style="font-size:14px;font-weight:700;color:#1e293b;">${invoiceNumber}</td>
        </tr>
        <tr>
          <td style="padding-top:8px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Date</td>
          <td align="right" style="padding-top:8px;font-size:14px;color:#1e293b;">${invoiceDate}</td>
        </tr>
        <tr>
          <td style="padding-top:8px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Company</td>
          <td align="right" style="padding-top:8px;font-size:14px;color:#1e293b;">${companyName}</td>
        </tr>
      </table>
      <div style="border-top:1px solid #e2e8f0;margin:0 0 16px;"></div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr style="background:#e2e8f0;border-radius:6px;">
          <td style="padding:10px 14px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;border-radius:6px 0 0 6px;">Description</td>
          <td align="center" style="padding:10px 14px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;">Cycle</td>
          <td align="right" style="padding:10px 14px;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;border-radius:0 6px 6px 0;">Amount</td>
        </tr>
        ${rows}
      </table>
      <div style="border-top:2px solid #f97316;margin:16px 0 0;padding:14px 0 0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:15px;font-weight:700;color:#1e293b;">Total</td>
            <td align="right" style="font-size:20px;font-weight:800;color:#f97316;">${totalLabel}</td>
          </tr>
        </table>
      </div>
    </div>`;
}

function buildContactLineHtml() {
  return `<p style="margin:0;font-size:13px;color:#94a3b8;text-align:center;">
      If you have any questions about this invoice, contact us at
      <a href="mailto:info@traseallo.com" style="color:#f97316;">info@traseallo.com</a>
      or WhatsApp <a href="https://wa.me/971503920037" style="color:#f97316;">+971 50 392 0037</a>.
    </p>`;
}

/**
 * POST /api/stripe/verify-session
 * Called by frontend after returning from Stripe Checkout redirect.
 * Retrieves the session from Stripe, verifies payment, and activates the plan.
 * This is the RELIABLE path — webhooks are a backup.
 */
router.post('/verify-session', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.body;
    const workshopId = req.workshopId;

    if (!session_id) {
      return res.status(400).json({ success: false, message: 'Missing session_id' });
    }

    // Retrieve the full checkout session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription'],
    });

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    // Verify this session belongs to this workshop
    const sessionWorkshopId = session.metadata?.workshop_id;
    if (String(sessionWorkshopId) !== String(workshopId)) {
      return res.status(403).json({ success: false, message: 'Session does not belong to this workshop' });
    }

    // Check payment status
    if (session.payment_status !== 'paid') {
      return res.status(400).json({
        success: false,
        message: `Payment not completed. Status: ${session.payment_status}`,
        payment_status: session.payment_status,
      });
    }

    const { plan, billing_cycle } = session.metadata || {};
    if (!plan) {
      return res.status(400).json({ success: false, message: 'No plan info in session metadata' });
    }

    // Activate the plan — pass Stripe's actual period end if available
    const stripePeriodEnd = session.subscription?.current_period_end || null;
    const activated = await activatePlan(
      workshopId,
      plan,
      billing_cycle || 'monthly',
      session.subscription?.id || session.subscription || null,
      session.customer || null,
      stripePeriodEnd,
    );

    if (!activated) {
      return res.status(500).json({ success: false, message: 'Failed to activate plan' });
    }

    return res.json({
      success: true,
      message: `Plan upgraded to ${plan} successfully!`,
      plan,
      billing_cycle: billing_cycle || 'monthly',
    });
  } catch (err) {
    console.error('[Stripe] Verify session error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to verify session: ' + err.message });
  }
});

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhook events (plan activation, cancellation, etc.)
 * NOTE: The main webhook handler is registered in index.js BEFORE express.json()
 *       to preserve the raw body for signature verification.
 *       This router-level handler is a fallback for dev mode.
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else if (!webhookSecret) {
      console.warn('[Stripe Webhook] STRIPE_WEBHOOK_SECRET not set — rejecting unsigned webhook');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    } else {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error('[Stripe Webhook] Processing error:', err.message);
  }

  res.json({ received: true });
});

/**
 * Shared event handler used by both the standalone webhook (index.js) and the router handler.
 * Handles: checkout completion, subscription updates, cancellation, payment failures.
 */
export async function handleStripeEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { workshop_id, plan, billing_cycle } = session.metadata || {};
      if (workshop_id && plan) {
        await activatePlan(workshop_id, plan, billing_cycle || 'monthly', session.subscription || null, session.customer || null);
      }
      break;
    }

    case 'customer.subscription.updated': {
      // Handles proration subscription updates and cancellation scheduling from Stripe
      const subscription = event.data.object;
      const [sub] = await query(
        'SELECT workshop_id, plan FROM subscriptions WHERE stripe_subscription_id = ?',
        [subscription.id]
      );
      if (sub) {
        // ── Handle cancellation scheduling (cancel_at_period_end OR cancel_at) ──
        const isCancelling = subscription.cancel_at_period_end || subscription.cancel_at;
        if (isCancelling) {
          const cancelAt = subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null;
          await execute(
            `UPDATE subscriptions SET cancel_at_period_end = 1, cancel_at = ? WHERE stripe_subscription_id = ?`,
            [cancelAt, subscription.id]
          );
          console.log(`[Stripe Webhook] Cancellation scheduled for workshop ${sub.workshop_id} at ${cancelAt}`);
          // Send cancellation pending email
          try {
            const [workshop] = await query('SELECT name, email FROM workshops WHERE id = ?', [sub.workshop_id]);
            if (workshop?.email) {
              const cancelDate = cancelAt
                ? cancelAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                : 'the end of your billing period';
              const branding = await getWorkshopBranding(sub.workshop_id);
              const html = buildEmailTemplate(branding, `
                <h2 style="color:#f59e0b;">Subscription Cancellation Scheduled</h2>
                <p>Hi <strong>${workshop.name}</strong>,</p>
                <p>Your subscription is scheduled to cancel on <strong>${cancelDate}</strong>. You'll continue to have full access until then.</p>
                <p>Changed your mind? You can reactivate anytime before the cancellation date:</p>
                <a href="https://dispatch.traseallo.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Reactivate Subscription</a>
                <p style="margin-top:20px;color:#6b7280;">Your data will be preserved even after cancellation. Questions? Contact support@traseallo.com</p>
              `);
              await sendEmail({ to: workshop.email, subject: `Subscription Cancellation Scheduled — ${workshop.name}`, html });
            }
          } catch (e) { console.error('[Stripe] Cancellation pending email error:', e.message); }
        } else {
          // Reactivated or normal update — clear cancellation flags if previously set
          await execute(
            `UPDATE subscriptions SET cancel_at_period_end = 0, cancel_at = NULL WHERE stripe_subscription_id = ? AND (cancel_at_period_end = 1 OR cancel_at IS NOT NULL)`,
            [subscription.id]
          );

          // Handle plan change (proration)
          const newPlan = subscription.metadata?.plan;
          const newCycle = subscription.metadata?.billing_cycle;
          if (newPlan && newPlan !== sub.plan) {
            const PLAN_PRICES = await getPlanPrices();
            const planConfig = PLAN_PRICES[newPlan];
            if (planConfig) {
              const periodEnd = new Date(subscription.current_period_end * 1000);
              await execute(
                `UPDATE subscriptions SET plan = ?, max_users = ?, billing_cycle = ?,
                  price_monthly = ?, price_yearly = ?, current_period_end = ?, status = 'active'
                 WHERE stripe_subscription_id = ?`,
                [newPlan, planConfig.max_users, newCycle || 'monthly',
                 planConfig.monthly / 100, planConfig.yearly / 100,
                 periodEnd, subscription.id]
              );
              console.log(`[Stripe Webhook] Subscription updated for workshop ${sub.workshop_id}: ${sub.plan} → ${newPlan}`);
            }
          }
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const [sub] = await query(
        'SELECT workshop_id FROM subscriptions WHERE stripe_subscription_id = ?',
        [subscription.id]
      );
      if (sub) {
        // 1. Mark subscription as cancelled
        await execute(
          "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), cancel_at_period_end = 0, cancel_at = NULL WHERE stripe_subscription_id = ?",
          [subscription.id]
        );
        // 2. Check if workshop has any other active subscription
        const [otherActive] = await query(
          "SELECT id FROM subscriptions WHERE workshop_id = ? AND status = 'active' AND stripe_subscription_id != ?",
          [sub.workshop_id, subscription.id]
        );
        if (!otherActive) {
          // 3. Update workshop status to cancelled
          await execute("UPDATE workshops SET status = 'cancelled' WHERE id = ?", [sub.workshop_id]);
          // 4. Deactivate all non-admin users
          await execute(
            "UPDATE users SET is_active = 0 WHERE workshop_id = ? AND role != 'admin'",
            [sub.workshop_id]
          );
          console.log(`[Stripe] Workshop ${sub.workshop_id} cancelled — users deactivated`);
        }
        // 5. Send cancellation confirmation email
        try {
          const [workshop] = await query('SELECT name, email FROM workshops WHERE id = ?', [sub.workshop_id]);
          if (workshop?.email) {
            const branding = await getWorkshopBranding(sub.workshop_id);
            const html = buildEmailTemplate(branding, `
              <h2 style="color:#dc2626;">Subscription Cancelled</h2>
              <p>Hi <strong>${workshop.name}</strong>,</p>
              <p>Your subscription has been cancelled. Your account access has been restricted.</p>
              <p><strong>Your data is safe</strong> — we never delete workshop data. You can resubscribe at any time to restore full access.</p>
              <p>Ready to come back? Resubscribe in one click:</p>
              <a href="https://dispatch.traseallo.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Resubscribe Now</a>
              <p style="margin-top:20px;color:#6b7280;">Questions? Contact support@traseallo.com</p>
            `);
            await sendEmail({ to: workshop.email, subject: `Subscription Cancelled — ${workshop.name}`, html });
          }
        } catch (e) { console.error('[Stripe] Cancellation email error:', e.message); }
        console.log(`[Stripe] Subscription cancelled for workshop ${sub.workshop_id}`);
      }
      break;
    }

    case 'invoice.paid': {
      // Log all paid invoices (including proration invoices) for audit trail
      const invoice = event.data.object;
      const [sub] = await query(
        'SELECT id, workshop_id, plan, billing_cycle FROM subscriptions WHERE stripe_customer_id = ?',
        [invoice.customer]
      );
      if (sub && invoice.amount_paid > 0) {
        try {
          await logBillingAudit(sub.workshop_id, sub.id, {
            type: 'stripe_invoice_paid',
            stripe_invoice_id: invoice.id,
            amount: invoice.amount_paid / 100,
            currency: invoice.currency?.toUpperCase() || 'AED',
          });
        } catch (e) { /* ignore duplicate */ }

        // Send payment receipt email for recurring invoices (not the initial checkout — that's handled by activatePlan)
        if (invoice.billing_reason !== 'subscription_create') {
          sendPaymentReceiptEmail(sub.workshop_id, sub.plan, sub.billing_cycle, invoice).catch(err => {
            console.error('[Stripe] Failed to send payment receipt email:', err.message);
          });
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const [sub] = await query(
        `SELECT s.workshop_id, s.plan, s.billing_cycle, s.price_monthly, s.price_yearly,
                t.name AS workshop_name, t.email AS workshop_email, t.currency
         FROM subscriptions s JOIN workshops t ON t.id = s.workshop_id
         WHERE s.stripe_customer_id = ?
         ORDER BY s.id DESC LIMIT 1`,
        [invoice.customer]
      );
      if (sub) {
        await execute(
          "UPDATE subscriptions SET status = 'past_due' WHERE stripe_customer_id = ? AND status IN ('active', 'trialing')",
          [invoice.customer]
        );
        console.log(`[Stripe] Payment failed for workshop ${sub.workshop_id} — marked as past_due`);

        // Real-time alert to super admin (info@traseallo.com).
        // The daily cron will continue to send reminders to the customer.
        const amount = invoice.amount_due ? invoice.amount_due / 100
          : (sub.billing_cycle === 'yearly' ? sub.price_yearly : sub.price_monthly);
        notifySuperAdminPaymentFailed({
          tenantId: sub.workshop_id,
          tenantName: sub.workshop_name,
          tenantEmail: sub.workshop_email,
          plan: sub.plan,
          billingCycle: sub.billing_cycle,
          amount,
          currency: (invoice.currency || sub.currency || 'AED').toUpperCase(),
          attemptCount: invoice.attempt_count,
          nextPaymentAttempt: invoice.next_payment_attempt,
          hostedInvoiceUrl: invoice.hosted_invoice_url,
        }).catch(e => console.error('[Stripe] super-admin alert failed:', e.message));
      }
      break;
    }

    case 'customer.subscription.trial_will_end': {
      // Stripe sends this 3 days before a trial subscription ends
      const subscription = event.data.object;
      const [sub] = await query(
        `SELECT s.workshop_id, s.plan, t.name AS workshop_name, t.email AS workshop_email
         FROM subscriptions s
         JOIN workshops t ON t.id = s.workshop_id
         WHERE s.stripe_subscription_id = ? AND s.status IN ('active','trialing')
         ORDER BY s.id DESC LIMIT 1`,
        [subscription.id]
      );
      if (sub && sub.workshop_email) {
        try {
          const trialEnd = subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'in 3 days';
          const branding = await getWorkshopBranding(sub.workshop_id);
          const html = buildEmailTemplate(branding, `
            <h2 style="color:#f59e0b;">Your Trial is Ending Soon</h2>
            <p>Hi <strong>${sub.workshop_name}</strong>,</p>
            <p>Your free trial will end on <strong>${trialEnd}</strong>. After that, your subscription will be cancelled unless you add a payment method.</p>
            <p>Subscribe now to keep your data, mechanics, and workshop operations running without interruption:</p>
            <a href="https://dispatch.traseallo.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#f97316;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Choose a Plan</a>
            <p style="margin-top:20px;color:#6b7280;">Questions? Contact us at support@traseallo.com</p>
          `);
          await sendEmail({ to: sub.workshop_email, subject: `Trial Ending Soon — ${sub.workshop_name}`, html });
          console.log(`[Stripe] Sent trial ending reminder to workshop ${sub.workshop_id}`);
        } catch (e) {
          console.error(`[Stripe] Trial ending reminder error:`, e.message);
        }
      }
      break;
    }

    case 'invoice.upcoming': {
      // Stripe sends this ~3 days before a subscription renews
      const invoice = event.data.object;
      const [sub] = await query(
        `SELECT s.workshop_id, s.plan, s.billing_cycle, s.price_monthly, s.price_yearly,
                s.current_period_end, t.name AS workshop_name, t.email AS workshop_email, t.currency
         FROM subscriptions s
         JOIN workshops t ON t.id = s.workshop_id
         WHERE s.stripe_customer_id = ? AND s.status = 'active'
         ORDER BY s.id DESC LIMIT 1`,
        [invoice.customer]
      );
      if (sub && sub.workshop_email) {
        try {
          const amount = sub.billing_cycle === 'yearly' ? sub.price_yearly : sub.price_monthly;
          const periodLabel = sub.billing_cycle === 'yearly' ? 'annual' : 'monthly';
          const renewDate = sub.current_period_end
            ? new Date(sub.current_period_end).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            : 'soon';
          const branding = await getWorkshopBranding(sub.workshop_id);
          const html = buildEmailTemplate(branding, `
            <h2 style="color:#2563eb;">Upcoming Subscription Renewal</h2>
            <p>Hi <strong>${sub.workshop_name}</strong>,</p>
            <p>This is a friendly reminder that your <strong>${periodLabel}</strong> subscription will renew on <strong>${renewDate}</strong>.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="color:#6b7280;">Plan</span>
                <strong>${sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="color:#6b7280;">Billing Cycle</span>
                <strong>${sub.billing_cycle === 'yearly' ? 'Annual' : 'Monthly'}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:#6b7280;">Amount</span>
                <strong style="color:#f97316;">${sub.currency || 'AED'} ${Number(amount).toFixed(2)}</strong>
              </div>
            </div>
            <p>Your payment method on file will be charged automatically. If you need to update your payment method or change your plan, visit your settings:</p>
            <a href="https://dispatch.traseallo.com/settings?tab=subscription" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Manage Subscription</a>
            <p style="margin-top:20px;color:#6b7280;">If you have questions, contact us at support@traseallo.com</p>
          `);
          await sendEmail({ to: sub.workshop_email, subject: `Subscription Renewal Reminder — ${sub.workshop_name}`, html });
          console.log(`[Stripe] Sent renewal reminder to workshop ${sub.workshop_id} (${sub.workshop_name})`);
        } catch (e) {
          console.error(`[Stripe] Renewal reminder email error:`, e.message);
        }
      }
      break;
    }
  }
}

/**
 * GET /api/stripe/subscription-status
 * Get current subscription status including Stripe info
 */
router.get('/subscription-status', authMiddleware, async (req, res) => {
  try {
    const [sub] = await query(
      `SELECT s.*, p.name as plan_name, p.slug as plan_slug
       FROM subscriptions s
       LEFT JOIN plans p ON p.slug = s.plan AND p.is_active = 1
       WHERE s.workshop_id = ?
       ORDER BY s.id DESC LIMIT 1`,
      [req.workshopId]
    );

    if (!sub) {
      return res.json({
        success: true,
        data: {
          plan: 'trial',
          status: 'none',
          has_stripe: false,
        }
      });
    }

    return res.json({
      success: true,
      data: {
        plan: sub.plan,
        plan_name: sub.plan_name || sub.plan,
        status: sub.status,
        max_users: sub.max_users,
        billing_cycle: sub.billing_cycle,
        current_period_end: sub.current_period_end,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        cancel_at: sub.cancel_at || null,
        has_stripe: !!sub.stripe_subscription_id,
        stripe_subscription_id: sub.stripe_subscription_id || null,
      }
    });
  } catch (err) {
    console.error('[Stripe] Get subscription status error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to get subscription status' });
  }
});

/**
 * POST /api/stripe/create-portal-session
 * Creates a Stripe Customer Portal session so the user can manage billing,
 * update payment method, view invoices, or cancel subscription.
 */
router.post('/create-portal-session', authMiddleware, async (req, res) => {
  try {
    const workshopId = req.workshopId;

    const [sub] = await query(
      "SELECT stripe_customer_id FROM subscriptions WHERE workshop_id = ? AND stripe_customer_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      [workshopId]
    );

    if (!sub?.stripe_customer_id) {
      return res.status(400).json({
        success: false,
        message: 'No billing account found. Please subscribe to a plan first.',
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://dispatch.traseallo.com';

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${frontendUrl}/settings?tab=subscription`,
    });

    return res.json({ success: true, url: portalSession.url });
  } catch (err) {
    console.error('[Stripe] Create portal session error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to open billing portal.' });
  }
});

export default router;
