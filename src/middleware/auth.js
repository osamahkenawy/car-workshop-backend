import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../lib/database.js';

/**
 * Generate JWT token with workshop context
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      workshop_id: user.workshop_id,
      permissions: user.permissions
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}

/**
 * Authentication middleware
 * Validates JWT and loads full user data
 */
export async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    // Load fresh user data from database
    const [user] = await query(
      'SELECT id, workshop_id, username, email, full_name, role, role_id, is_active, is_owner FROM users WHERE id = ?',
      [decoded.id]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    // Parse permissions if it's a string
    if (typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch {
        user.permissions = {};
      }
    }

    // Load role modules for dynamic permission checking
    if (user.role_id) {
      const [roleRow] = await query('SELECT slug, modules FROM roles WHERE id = ?', [user.role_id]);
      if (roleRow) {
        user.role_modules = Array.isArray(roleRow.modules) ? roleRow.modules
          : typeof roleRow.modules === 'string' ? (() => { try { return JSON.parse(roleRow.modules); } catch { return []; } })()
          : [];
      }
    }

    req.user = user;
    req.workshopId = user.workshop_id; // Set workshop ID from user

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
}

/**
 * Admin only middleware
 * Allows admin and super_admin roles
 */
export function adminOnly(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

/**
 * Super admin only middleware
 * Only allows super_admin role
 */
export function superAdminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin access required' });
  }
  next();
}

/**
 * Platform owner only middleware
 * Only allows platform owners (Pioneer staff)
 */
export function platformOwnerOnly(req, res, next) {
  if (!req.user?.permissions?.platform_owner) {
    return res.status(403).json({ success: false, message: 'Platform owner access required' });
  }
  next();
}

/**
 * Workshop owner only middleware
 * Only allows the owner of the current workshop
 */
export function workshopOwnerOnly(req, res, next) {
  if (!req.user?.is_owner && !req.user?.permissions?.platform_owner) {
    return res.status(403).json({ success: false, message: 'Workshop owner access required' });
  }
  next();
}

/**
 * Check specific permission
 */
export function hasPermission(permission) {
  return (req, res, next) => {
    const perms = req.user?.permissions || {};

    // Platform owners and super admins have all permissions
    if (perms.all || perms.super_admin || perms.platform_owner) {
      return next();
    }

    // Check specific permission
    if (!perms[permission]) {
      return res.status(403).json({ success: false, message: `Permission '${permission}' required` });
    }

    next();
  };
}

/**
 * Role-based access control
 * @param {string[]} allowedRoles - Array of allowed roles
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Platform owners can access everything
    if (req.user.permissions?.platform_owner) {
      return next();
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
}
