// Central configuration for the car-workshop-backend platform.
// All values are env-driven with sane local-development defaults.
import 'dotenv/config';

function bool(val, def = false) {
  if (val === undefined || val === null || val === '') return def;
  return String(val).toLowerCase() === 'true' || val === '1';
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 4000,

  // Public URLs
  backendUrl: process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  baseUrl: process.env.BASE_URL || process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`,

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'car_workshop',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Mechanic mobile-app token lifetimes (used by mechanic-app.js)
  mechanicApp: {
    accessTokenTtlShort: process.env.MECHANIC_ACCESS_TTL_SHORT || '12h',
    refreshTokenTtlDays: parseInt(process.env.MECHANIC_REFRESH_TTL_DAYS, 10) || 30,
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'no-reply@car-workshop.local',
    fromName: process.env.SMTP_FROM_NAME || 'Car Workshop Platform',
  },

  sms: {
    provider: process.env.SMS_PROVIDER || '', // '' = stub/log-only, or 'twilio'
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@car-workshop.local',
  },

  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
  },

  s3: {
    bucket: process.env.AWS_S3_BUCKET || '',
    region: process.env.AWS_REGION || 'me-central-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  osrmUrl: process.env.OSRM_URL || 'https://router.project-osrm.org',

  cronTz: process.env.CRON_TZ || 'Asia/Dubai',

  superAdmin: {
    email: process.env.SUPER_ADMIN_EMAIL || '',
    digestSkipEmpty: bool(process.env.SUPER_ADMIN_DIGEST_SKIP_EMPTY, true),
  },

  billing: {
    pastDueSuspendAfterDays: parseInt(process.env.PAST_DUE_SUSPEND_AFTER_DAYS, 10) || 7,
  },

  // Financial defaults (VAT / commission / cash-payment handling fee) — can be
  // overridden per-workshop via the `settings` table; these are platform fallbacks.
  vatEnabled: bool(process.env.VAT_ENABLED, true),
  vatRate: parseFloat(process.env.VAT_RATE) || 5.0,
  applyVatOnServiceFee: bool(process.env.APPLY_VAT_ON_SERVICE_FEE, true),
  applyVatOnCash: bool(process.env.APPLY_VAT_ON_CASH, false),
  commissionPercent: parseFloat(process.env.COMMISSION_PERCENT) || 0,
  paymentGatewayFeePct: parseFloat(process.env.PAYMENT_GATEWAY_FEE_PCT) || 0,
  mechanicEarningType: process.env.MECHANIC_EARNING_TYPE || 'flat', // 'flat' | 'percent'
  mechanicEarningRate: parseFloat(process.env.MECHANIC_EARNING_RATE) || 0,
  mechanicEarningCashPct: parseFloat(process.env.MECHANIC_EARNING_CASH_PCT) || 0,

  logOtpToConsole: bool(process.env.LOG_OTP_SECRET, true),

  apiKeyPrefix: process.env.API_KEY_PREFIX || 'cw_',
};

export default config;
