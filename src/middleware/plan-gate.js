/**
 * plan-gate.js — Subscription Plan Enforcement & Feature Gating Middleware
 *
 * Module D.1 — Reads workshop's active subscription and plan,
 * enforces limits, and gates premium features.
 *
 * Exports:
 *   loadSubscription  — populates req.subscription (auto-runs once per request)
 *   requirePlan(slug)    — 403 if workshop plan is below required level
 *   requireFeature(name) — 403 if workshop plan doesn't include feature
 *   checkLimit(type)     — 403 if limit exceeded (max_mechanics, max_users, max_work_orders_per_month)
 *   checkWorkshopActive()  — 403 if workshop is suspended / cancelled
 *   getUsageStats        — helper that returns current usage numbers
 */

import { query } from '../lib/database.js';

/* ── Plan hierarchy & feature matrix ──────────────────────────── */
const PLAN_LEVEL = {
  trial:        0,
  starter:      1,
  growth:       2,
  professional: 2,
  enterprise:   3,
  self_hosted:  4,
};

/*
 * Feature vocabulary renamed for the car-workshop domain (same flags, same count):
 *   route_optimization      -> job_scheduling_optimization
 *   multi_stop              -> multi_bay_scheduling
 *   branded_tracking        -> branded_service_status_page
 *   custom_stop_properties  -> custom_work_order_fields
 *   proof_of_custody        -> digital_signoff
 *   driver_app              -> mechanic_app
 *   live_tracking           -> live_job_tracking
 *   geofencing              -> unchanged
 */
const PLAN_FEATURES = {
  trial: {
    job_scheduling_optimization: true,
    multi_bay_scheduling: true,
    max_stops_per_order: 50,
    custom_sms_sender: true,
    branded_service_status_page: true,
    custom_work_order_fields: 3,
    photo_capture_limit: 10,
    data_retention_days: 365,
    customizable_manifests: true,
    notification_quiet_hours: true,
    actual_time_at_stop: true,
    digital_signoff: true,
    personalized_onboarding: false,
    geofencing: false,
    api_access: true,
    bulk_import: true,
    advanced_reporting: true,
    mechanic_app: true,
    live_job_tracking: true,
  },
  starter: {
    job_scheduling_optimization: true,
    multi_bay_scheduling: false,
    max_stops_per_order: 1,
    custom_sms_sender: false,
    branded_service_status_page: false,
    custom_work_order_fields: 1,
    photo_capture_limit: 5,
    data_retention_days: 30,
    customizable_manifests: false,
    notification_quiet_hours: false,
    actual_time_at_stop: false,
    digital_signoff: false,
    personalized_onboarding: false,
    geofencing: false,
    api_access: true,
    bulk_import: true,
    advanced_reporting: true,
    mechanic_app: true,
    live_job_tracking: true,
  },
  growth: {
    job_scheduling_optimization: true,
    multi_bay_scheduling: true,
    max_stops_per_order: 50,
    custom_sms_sender: true,
    branded_service_status_page: true,
    custom_work_order_fields: 3,
    photo_capture_limit: 10,
    data_retention_days: 365,
    customizable_manifests: true,
    notification_quiet_hours: true,
    actual_time_at_stop: true,
    digital_signoff: true,
    personalized_onboarding: false,
    geofencing: false,
    api_access: true,
    bulk_import: true,
    advanced_reporting: true,
    mechanic_app: true,
    live_job_tracking: true,
  },
  enterprise: {
    job_scheduling_optimization: true,
    multi_bay_scheduling: true,
    max_stops_per_order: 200,
    custom_sms_sender: true,
    branded_service_status_page: true,
    custom_work_order_fields: 10,
    photo_capture_limit: 10,
    data_retention_days: 1825,
    customizable_manifests: true,
    notification_quiet_hours: true,
    actual_time_at_stop: true,
    digital_signoff: true,
    personalized_onboarding: true,
    geofencing: true,
    api_access: true,
    bulk_import: true,
    advanced_reporting: true,
    mechanic_app: true,
    live_job_tracking: true,
  },
  self_hosted: {
    job_scheduling_optimization: true,
    multi_bay_scheduling: true,
    max_stops_per_order: 999,
    custom_sms_sender: true,
    branded_service_status_page: true,
    custom_work_order_fields: 999,
    photo_capture_limit: 999,
    data_retention_days: 99999,
    customizable_manifests: true,
    notification_quiet_hours: true,
    actual_time_at_stop: true,
    digital_signoff: true,
    personalized_onboarding: true,
    geofencing: true,
    api_access: true,
    bulk_import: true,
    advanced_reporting: true,
    mechanic_app: true,
    live_job_tracking: true,
  },
};

// Backward compatibility: 'professional' is the old slug for 'growth'
PLAN_FEATURES.professional = PLAN_FEATURES.growth;

/* ── Plan-specific limits (used when DB plans table has no row) ── */
const PLAN_LIMITS = {
  trial:        { max_work_orders_per_month: 3000,  max_users: 20,  max_mechanics: 50  },
  starter:      { max_work_orders_per_month: 1000,  max_users: 5,   max_mechanics: 10  },
  growth:       { max_work_orders_per_month: 3000,  max_users: 20,  max_mechanics: 50  },
  professional: { max_work_orders_per_month: 3000,  max_users: 20,  max_mechanics: 50  },
  enterprise:   { max_work_orders_per_month: 12000, max_users: 100, max_mechanics: 999 },
  self_hosted:  { max_work_orders_per_month: 999999, max_users: 999999, max_mechanics: 999999 },
};

/* Human-readable plan names */
const PLAN_DISPLAY = {
  trial: 'Trial',
  starter: 'Starter',
  growth: 'Growth',
  professional: 'Growth',
  enterprise: 'Enterprise',
  self_hosted: 'Self-Hosted',
};

/* ── Load subscription (once per request) ─────────────────────── */

/**
 * Middleware that loads the workshop's active subscription + plan limits.
 * Populates req.subscription with plan info, limits, and features.
 * Skips gracefully for super_admin / platform_owner requests.
 */
export async function loadSubscription(req, _res, next) {
  try {
    // Already loaded this request
    if (req.subscription) return next();

    const workshopId = req.workshopId || req.user?.workshop_id;
    if (!workshopId) return next(); // No workshop context (e.g., public routes)

    // Super admins / platform owners bypass plan checks
    if (req.user?.role === 'super_admin' || req.user?.permissions?.platform_owner) {
      req.subscription = {
        plan: 'self_hosted',
        plan_level: 4,
        status: 'active',
        features: PLAN_FEATURES.self_hosted,
        limits: { max_mechanics: 999999, max_users: 999999, max_work_orders_per_month: 999999 },
        display_name: 'Platform Admin',
        is_trial: false,
        trial_days_remaining: null,
        bypass: true,
      };
      return next();
    }

    // Load workshop + subscription + plan in one query
    const rows = await query(`
      SELECT
        w.status AS workshop_status,
        w.trial_ends_at,
        s.id AS subscription_id,
        s.plan AS subscription_plan,
        s.status AS subscription_status,
        s.max_users AS sub_max_users,
        s.current_users,
        s.features AS sub_features,
        s.current_period_end,
        s.trial_end AS sub_trial_end,
        s.trial_start AS sub_trial_start,
        s.trial_days AS sub_trial_days,
        s.stripe_subscription_id,
        s.cancel_at_period_end,
        s.cancel_at,
        p.id AS plan_id,
        p.name AS plan_name,
        p.slug AS plan_slug,
        p.max_mechanics AS plan_max_mechanics,
        p.max_users AS plan_max_users,
        p.max_work_orders_per_month AS plan_max_work_orders
      FROM workshops w
      LEFT JOIN subscriptions s ON s.workshop_id = w.id AND s.status IN ('active','trialing','trial_expired','past_due','suspended')
      LEFT JOIN plans p ON (p.slug = s.plan OR (s.plan = 'professional' AND p.slug = 'growth')) AND p.is_active = 1
      WHERE w.id = ?
      LIMIT 1
    `, [workshopId]);

    const row = rows[0];
    if (!row) {
      req.subscription = _defaultSubscription('trial');
      return next();
    }

    const planSlug = row.subscription_plan || 'trial';
    const planLevel = PLAN_LEVEL[planSlug] ?? 0;
    const features = PLAN_FEATURES[planSlug] || PLAN_FEATURES.trial;

    // Check if sub_features has an "all" override
    let subFeatures = null;
    try {
      subFeatures = typeof row.sub_features === 'string' ? JSON.parse(row.sub_features) : row.sub_features;
    } catch { subFeatures = null; }
    const hasAllOverride = subFeatures?.all === true;

    // Calculate trial days remaining — prefer subscription.trial_end, fallback to workshop.trial_ends_at
    let trialDaysRemaining = null;
    let isTrialExpired = false;
    const isTrialSub = row.subscription_status === 'trialing' || row.subscription_status === 'trial_expired' || row.workshop_status === 'trial' || row.workshop_status === 'trial_expired';
    const trialEndDate = row.sub_trial_end || row.trial_ends_at;
    if (isTrialSub && trialEndDate) {
      const now = new Date();
      const trialEnd = new Date(trialEndDate);
      trialDaysRemaining = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      isTrialExpired = trialDaysRemaining < 0;
    }

    // Resolve limits — prefer DB plan table → PLAN_LIMITS fallback
    // (subscription.max_users may have stale 999999 from old defaults, so plan table wins)
    const planDefaults = PLAN_LIMITS[planSlug] || PLAN_LIMITS.starter;
    const maxMechanics = row.plan_max_mechanics ?? planDefaults.max_mechanics;
    const maxUsers = row.plan_max_users ?? planDefaults.max_users;
    const maxWorkOrdersPerMonth = row.plan_max_work_orders ?? planDefaults.max_work_orders_per_month;

    req.subscription = {
      subscription_id: row.subscription_id,
      plan: planSlug,
      plan_level: planLevel,
      plan_id: row.plan_id,
      plan_name: row.plan_name || PLAN_DISPLAY[planSlug] || planSlug,
      display_name: PLAN_DISPLAY[planSlug] || planSlug,
      status: row.subscription_status || 'none',
      workshop_status: row.workshop_status,
      is_trial: isTrialSub,
      trial_days_remaining: trialDaysRemaining,
      trial_expired: isTrialExpired,
      trial_end: trialEndDate || null,
      current_period_end: row.current_period_end,
      cancel_at_period_end: !!row.cancel_at_period_end,
      cancel_at: row.cancel_at || null,
      features: hasAllOverride ? PLAN_FEATURES.self_hosted : features,
      has_all_features: hasAllOverride,
      limits: {
        max_mechanics: maxMechanics,
        max_users: maxUsers,
        max_work_orders_per_month: maxWorkOrdersPerMonth,
      },
      has_stripe: !!row.stripe_subscription_id,
      bypass: false,
    };

    next();
  } catch (err) {
    console.error('loadSubscription error:', err.message);
    // Non-blocking — set defaults so the app keeps working
    req.subscription = _defaultSubscription('trial');
    next();
  }
}

function _defaultSubscription(plan = 'trial') {
  const defaults = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
  return {
    plan,
    plan_level: PLAN_LEVEL[plan] ?? 0,
    status: 'none',
    features: PLAN_FEATURES[plan] || PLAN_FEATURES.trial,
    limits: {
      max_mechanics: defaults.max_mechanics,
      max_users: defaults.max_users,
      max_work_orders_per_month: defaults.max_work_orders_per_month,
    },
    display_name: PLAN_DISPLAY[plan] || plan,
    is_trial: true,
    trial_end: null,
    trial_days_remaining: null,
    bypass: false,
  };
}

/* ── checkWorkshopActive — block suspended/cancelled/trial_expired workshops ── */

// Routes that must always pass through (billing, plan info, auth)
const ALWAYS_ALLOW_PATHS = [
  '/api/stripe',
  '/api/plan-usage',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/profile',
];

export function checkWorkshopActive() {
  return async (req, res, next) => {
    // Ensure subscription is loaded
    if (!req.subscription) await _ensureLoaded(req, res);
    if (res.headersSent) return;

    const sub = req.subscription;
    if (sub?.bypass) return next();

    // Always allow billing/auth routes so users can upgrade or logout
    const path = req.originalUrl || req.url || '';
    if (ALWAYS_ALLOW_PATHS.some(p => path.startsWith(p))) return next();

    // ─── Check subscription-level status first ───
    const subStatus = sub?.status;

    // BUG 8 FIX: Check grace period BEFORE hard-blocking trial_expired.
    // If the trial is expired but still within the 7-day grace window, allow
    // access with a warning header instead of blocking outright.
    if (subStatus === 'trial_expired' || (sub?.trial_expired && sub?.is_trial)) {
      // Trial expired — allow access with warning header.
      // Actual resource limits (work order counts, etc.) are enforced by route-level checks.
      const daysOverdue = sub?.trial_days_remaining !== null ? Math.abs(sub.trial_days_remaining) : null;
      if (daysOverdue !== null) {
        res.set('X-Trial-Warning', `Trial expired ${daysOverdue} day(s) ago. Please subscribe to a plan.`);
      }
      // Fall through to next() — don't hard-block
    }

    // Past due — warn but allow limited access (grace period)
    if (subStatus === 'past_due') {
      res.set('X-Subscription-Warning', 'Your payment is past due. Please update your billing information.');
    }

    // Suspended subscription — hard block
    if (subStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        suspended: true,
        message: 'Your subscription has been suspended due to non-payment. Please update your billing to restore access.',
        current_plan: sub.plan,
      });
    }

    // ─── Check workshop-level status ───
    if (sub?.workshop_status === 'suspended') {
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        suspended: true,
        message: 'Your account has been suspended. Please subscribe to a plan to continue.',
        current_plan: sub.plan,
      });
    }
    if (sub?.workshop_status === 'cancelled') {
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        cancelled: true,
        message: 'Your account has been cancelled. Please contact support.',
        current_plan: sub.plan,
      });
    }

    next();
  };
}

/* ── requirePlan — minimum plan level ─────────────────────────── */

export function requirePlan(minPlan) {
  const minLevel = PLAN_LEVEL[minPlan] ?? 0;

  return async (req, res, next) => {
    if (!req.subscription) await _ensureLoaded(req, res);
    if (res.headersSent) return;

    const sub = req.subscription;
    if (sub?.bypass || sub?.has_all_features) return next();

    if ((sub?.plan_level ?? 0) < minLevel) {
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        current_plan: sub?.plan,
        current_plan_name: sub?.display_name,
        required_plan: minPlan,
        required_plan_name: PLAN_DISPLAY[minPlan],
        message: `This feature requires the ${PLAN_DISPLAY[minPlan]} plan or higher. You are currently on the ${sub?.display_name} plan.`,
      });
    }
    next();
  };
}

/* ── requireFeature — specific feature check ──────────────────── */

export function requireFeature(featureName) {
  return async (req, res, next) => {
    if (!req.subscription) await _ensureLoaded(req, res);
    if (res.headersSent) return;

    const sub = req.subscription;
    if (sub?.bypass || sub?.has_all_features) return next();

    const featureValue = sub?.features?.[featureName];

    // Boolean features
    if (featureValue === false || featureValue === undefined) {
      // Find which plan first enables this feature
      const requiredPlan = _findRequiredPlan(featureName);
      return res.status(403).json({
        success: false,
        upgrade_required: true,
        feature: featureName,
        current_plan: sub?.plan,
        current_plan_name: sub?.display_name,
        required_plan: requiredPlan,
        required_plan_name: PLAN_DISPLAY[requiredPlan],
        message: `"${_humanize(featureName)}" requires the ${PLAN_DISPLAY[requiredPlan]} plan. Upgrade to unlock this feature.`,
      });
    }

    // Numeric features (e.g., custom_work_order_fields: 3)
    // Store the allowed value on req so route handlers can use it
    if (typeof featureValue === 'number') {
      req.featureLimit = req.featureLimit || {};
      req.featureLimit[featureName] = featureValue;
    }

    next();
  };
}

/* ── checkLimit — usage limit enforcement ─────────────────────── */

export function checkLimit(limitType) {
  return async (req, res, next) => {
    if (!req.subscription) await _ensureLoaded(req, res);
    if (res.headersSent) return;

    const sub = req.subscription;
    if (sub?.bypass || sub?.has_all_features) return next();

    const workshopId = req.workshopId || req.user?.workshop_id;
    if (!workshopId) return next();

    try {
      const usage = await getUsageStats(workshopId);
      const limits = sub?.limits || {};

      let current, max, label;

      switch (limitType) {
        case 'max_work_orders_per_month': {
          current = usage.work_orders_this_month;
          max = limits.max_work_orders_per_month || 1000;
          label = 'Work orders this month';
          break;
        }
        case 'max_mechanics':
        case 'max_users': {
          // Mechanics and users are unified — both check total users count
          current = usage.active_users;
          max = limits.max_users || 5;
          label = 'Users (including mechanics)';
          break;
        }
        default:
          return next();
      }

      if (current >= max) {
        // Find which plan offers more
        const upgradePlan = _suggestUpgrade(sub?.plan);
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          limit_type: limitType,
          current_usage: current,
          limit: max,
          current_plan: sub?.plan,
          current_plan_name: sub?.display_name,
          suggested_plan: upgradePlan,
          suggested_plan_name: PLAN_DISPLAY[upgradePlan],
          message: `${label} limit reached (${current}/${max}). Upgrade to ${PLAN_DISPLAY[upgradePlan]} for higher limits.`,
        });
      }

      // Store usage on request for frontend badges
      req.planUsage = usage;
      next();
    } catch (err) {
      console.error(`checkLimit(${limitType}) error:`, err.message);
      next(); // Non-blocking on error
    }
  };
}

/* ── getUsageStats — compute current usage for a workshop ───────── */

export async function getUsageStats(workshopId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 19).replace('T', ' ');

  const [[workOrderCount], [userCount], [mechanicRoleCount]] = await Promise.all([
    query(
      'SELECT COUNT(*) AS cnt FROM work_orders WHERE workshop_id = ? AND created_at >= ?',
      [workshopId, monthStart]
    ),
    query(
      'SELECT COUNT(*) AS cnt FROM users WHERE workshop_id = ? AND is_active = 1',
      [workshopId]
    ),
    query(
      "SELECT COUNT(*) AS cnt FROM users WHERE workshop_id = ? AND is_active = 1 AND role = 'mechanic'",
      [workshopId]
    ),
  ]);

  // Mechanics and users are unified — all are "users" in the users table.
  // active_users = total active users (admins + dispatchers + mechanics)
  // active_mechanics = subset of users with role='mechanic' (for display only)
  return {
    work_orders_this_month: workOrderCount?.cnt || 0,
    active_mechanics: mechanicRoleCount?.cnt || 0,
    active_users: userCount?.cnt || 0,
  };
}

/* ── Plan usage endpoint — frontend calls this for badges ─────── */

export async function getPlanUsageHandler(req, res) {
  try {
    const workshopId = req.workshopId || req.user?.workshop_id;
    if (!workshopId) {
      return res.status(400).json({ success: false, message: 'No workshop context' });
    }

    // Ensure subscription is loaded
    if (!req.subscription) {
      await new Promise((resolve) => loadSubscription(req, res, resolve));
    }
    const sub = req.subscription;
    const usage = await getUsageStats(workshopId);

    return res.json({
      success: true,
      data: {
        plan: sub.plan,
        plan_name: sub.display_name,
        plan_level: sub.plan_level,
        status: sub.status,
        workshop_status: sub.workshop_status,
        is_trial: sub.is_trial,
        trial_end: sub.trial_end || null,
        trial_days_remaining: sub.trial_days_remaining,
        trial_expired: sub.trial_expired,
        current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end || false,
        cancel_at: sub.cancel_at || null,
        has_stripe: sub.has_stripe || false,
        features: sub.features,
        limits: sub.limits,
        usage: {
          work_orders_this_month: usage.work_orders_this_month,
          work_orders_limit: sub.limits.max_work_orders_per_month,
          work_orders_pct: Math.round((usage.work_orders_this_month / (sub.limits.max_work_orders_per_month || 1)) * 100),
          // Mechanics are a subset of users — unified under one "Users" limit
          active_mechanics: usage.active_mechanics,
          active_users: usage.active_users,
          users_limit: sub.limits.max_users,
          users_pct: Math.round((usage.active_users / (sub.limits.max_users || 1)) * 100),
        },
      },
    });
  } catch (err) {
    console.error('getPlanUsage error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load plan usage' });
  }
}

/* ── Helpers ──────────────────────────────────────────────────── */

async function _ensureLoaded(req, res) {
  return new Promise((resolve) => loadSubscription(req, res, resolve));
}

function _findRequiredPlan(featureName) {
  const planOrder = ['starter', 'professional', 'enterprise'];
  for (const plan of planOrder) {
    const val = PLAN_FEATURES[plan]?.[featureName];
    if (val === true || (typeof val === 'number' && val > 0)) return plan;
  }
  return 'enterprise';
}

function _suggestUpgrade(currentPlan) {
  const order = ['trial', 'starter', 'growth', 'enterprise'];
  const idx = order.indexOf(currentPlan);
  return order[Math.min(idx + 1, order.length - 1)] || 'growth';
}

function _humanize(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export { PLAN_LEVEL, PLAN_FEATURES, PLAN_DISPLAY, PLAN_LIMITS };
