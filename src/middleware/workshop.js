import { query } from '../lib/database.js';

/**
 * Workshop Middleware
 * Extracts workshop context from request and validates access
 */
export const workshopMiddleware = async (req, res, next) => {
  try {
    // Skip workshop check for platform super admins
    if (req.user && req.user.permissions?.platform_owner) {
      req.workshopId = req.query.workshop_id || req.body?.workshop_id || null;
      return next();
    }

    // Get workshop ID from various sources
    let workshopId = null;

    // 1. From authenticated user
    if (req.user?.workshop_id) {
      workshopId = req.user.workshop_id;
    }

    // 2. From subdomain (e.g., company.crm.pioneercarservice.com)
    if (!workshopId) {
      const host = req.get('host');
      const subdomain = extractSubdomain(host);
      if (subdomain && subdomain !== 'api' && subdomain !== 'www') {
        const [workshop] = await query('SELECT id FROM workshops WHERE subdomain = ? AND status = "active"', [subdomain]);
        if (workshop) {
          workshopId = workshop.id;
        }
      }
    }

    // 3. From custom header
    if (!workshopId && req.headers['x-workshop-id']) {
      workshopId = parseInt(req.headers['x-workshop-id']);
    }

    // 4. From query parameter (for API access)
    if (!workshopId && req.query.workshop_id) {
      workshopId = parseInt(req.query.workshop_id);
    }

    // Validate workshop exists and is active
    if (workshopId) {
      const [workshop] = await query(
        'SELECT w.*, s.plan, s.max_users, s.current_users, s.status as subscription_status FROM workshops w LEFT JOIN subscriptions s ON w.id = s.workshop_id WHERE w.id = ?',
        [workshopId]
      );

      if (!workshop) {
        return res.status(404).json({ success: false, message: 'Workshop not found' });
      }

      // Allow billing & plan-info routes through even for suspended/cancelled workshops
      // so they can reactivate via Stripe or check their plan status.
      // Detailed access control for these statuses is enforced by checkWorkshopActive() middleware.
      const reqPath = req.originalUrl || req.url || '';
      const BILLING_PATHS = ['/api/stripe', '/api/plan-usage'];
      const isBillingRoute = BILLING_PATHS.some(p => reqPath.startsWith(p));

      if (!isBillingRoute) {
        if (workshop.status === 'suspended') {
          return res.status(403).json({ success: false, message: 'Account suspended. Please contact support.' });
        }

        if (workshop.status === 'cancelled') {
          return res.status(403).json({ success: false, message: 'Account cancelled.' });
        }
      }

      req.workshopId = workshopId;
      req.workshop = workshop;
    }

    next();
  } catch (error) {
    console.error('Workshop middleware error:', error);
    next(error);
  }
};

/**
 * Require Workshop Middleware
 * Ensures a valid workshop is present in the request
 */
export const requireWorkshop = (req, res, next) => {
  // If no user is authenticated at all, return 401 before checking workshop
  if (!req.user && !req.workshopId) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  if (!req.workshopId && !req.user?.permissions?.platform_owner) {
    return res.status(400).json({ success: false, message: 'Workshop context required' });
  }
  next();
};

/**
 * Check User Limit Middleware
 * Ensures workshop hasn't exceeded user limit
 */
export const checkUserLimit = async (req, res, next) => {
  try {
    if (!req.workshopId) return next();

    const [subscription] = await query(
      'SELECT max_users, current_users FROM subscriptions WHERE workshop_id = ? AND status = "active"',
      [req.workshopId]
    );

    if (subscription && subscription.current_users >= subscription.max_users) {
      return res.status(403).json({
        success: false,
        message: `User limit reached (${subscription.max_users}). Please upgrade your plan.`
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Check Feature Access Middleware
 * Ensures workshop has access to a specific feature
 */
export const checkFeature = (feature) => {
  return async (req, res, next) => {
    try {
      if (req.user?.permissions?.platform_owner) return next();

      if (!req.workshopId) {
        return res.status(400).json({ success: false, message: 'Workshop context required' });
      }

      const [subscription] = await query(
        'SELECT features FROM subscriptions WHERE workshop_id = ? AND status = "active"',
        [req.workshopId]
      );

      if (!subscription) {
        return res.status(403).json({ success: false, message: 'No active subscription' });
      }

      let features = subscription.features;
      if (typeof features === 'string') {
        features = JSON.parse(features);
      }

      // Check if feature is enabled
      if (!features || (!features.all && !features[feature])) {
        return res.status(403).json({
          success: false,
          message: `Feature '${feature}' is not available in your plan. Please upgrade.`
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

// Helper function to extract subdomain
function extractSubdomain(host) {
  if (!host) return null;

  // Remove port if present
  host = host.split(':')[0];

  // Split by dots
  const parts = host.split('.');

  // For localhost, return null
  if (host.includes('localhost')) return null;

  // For domains like company.crm.pioneercarservice.com, return 'company'
  if (parts.length >= 3) {
    return parts[0];
  }

  return null;
}

export default workshopMiddleware;
