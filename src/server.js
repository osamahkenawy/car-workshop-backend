/**
 * Car Workshop Platform — API server entrypoint.
 *
 * Express app + Socket.IO, all routers mounted under /api/...
 */
import express from 'express';
import http from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { readFileSync } from 'fs';
import { load as yamlLoad } from 'js-yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';
import { ensurePushTable } from './lib/push.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const swaggerDocument = yamlLoad(readFileSync(join(__dirname, 'swagger.yaml'), 'utf8'));
import { initSocket } from './lib/socket.js';

// ── Cron / background jobs ────────────────────────────────────────────────
import { startAcceptanceTimeout } from './lib/acceptance-timeout.js';
import { startJobDelayChecker } from './lib/job-delay-checker.js';
import { startDocExpiryCron } from './lib/doc-expiry-cron.js';
import { startDataRetention } from './lib/data-retention.js';
import { startTrialEnforcer } from './lib/trial-enforcer.js';
import { startScheduledReports } from './lib/scheduled-reports.js';

// ── Routers ────────────────────────────────────────────────────────────────
import authRouter from './routes/auth.js';
import workshopsRouter from './routes/workshops.js';
import mechanicsRouter from './routes/mechanics.js';
import customersRouter from './routes/customers.js';
import enquiriesRouter from './routes/enquiries.js';
import serviceBaysRouter from './routes/service-bays.js';
import vehiclesRouter from './routes/vehicles.js';
import workOrdersRouter from './routes/work-orders.js';
import partsRouter from './routes/parts.js';
import jobAssignmentRouter from './routes/job-assignment.js';
import servicePricingRouter from './routes/service-pricing.js';
import serviceStatusRouter from './routes/service-status.js';
import cashPaymentRouter from './routes/cash-payment.js';
import warrantyClaimsRouter from './routes/warranty-claims.js';
import mechanicEarningsRouter from './routes/mechanic-earnings.js';
import mechanicDocumentsRouter from './routes/mechanic-documents.js';
import mechanicAppRouter from './routes/mechanic-app.js';
import customerAuthRouter from './routes/customer-auth.js';
import customerPortalRouter from './routes/customer-portal.js';
import walletRouter from './routes/wallet.js';
import invoicesRouter from './routes/invoices.js';
import financialAdvancedRouter from './routes/financial-advanced.js';
import stripeRouter from './routes/stripe.js';
import webhooksRouter from './routes/webhooks.js';
import reportsRouter from './routes/reports.js';
import statsRouter from './routes/stats.js';
import settingsRouter from './routes/settings.js';
import notificationsRouter from './routes/notifications.js';
import userNotificationsRouter from './routes/user-notifications.js';
import integrationsRouter from './routes/integrations.js';
import uploadsRouter from './routes/uploads.js';
import apiV1Router from './routes/api-v1.js';
import { apiKeyAuth } from './middleware/api-key-auth.js';
import publicApiRouter from './routes/public-api.js';
import { publicSurveyRouter, adminSurveyRouter } from './routes/customer-survey.js';
import { publicCareersRouter, adminCareersRouter } from './routes/careers.js';
import { legalPublicRouter, legalAdminRouter } from './routes/legal-pages.js';
// CRM phase 1
import crmCustomersRouter from './routes/crm-customers.js';
import crmTasksRouter from './routes/crm-tasks.js';
import crmRemindersRouter from './routes/crm-reminders.js';
import { startReminderCron } from './lib/reminder-cron.js';
import superAdminRouter from './routes/super-admin.js';
import superAdminEnhancedRouter from './routes/super-admin-enhanced.js';

// ── SOW: New modules ──────────────────────────────────────────────────────
import appointmentsRouter from './routes/appointments.js';
import vehicleReceivingRouter from './routes/vehicle-receiving.js';
import estimatesRouter from './routes/estimates.js';
import jobCardsRouter from './routes/job-cards.js';
import inventoryRouter from './routes/inventory.js';
import subletRouter, { proformaRouter, gatePassRouter } from './routes/sublet.js';
import { vatRouter, evhcRouter, groupIntegrationRouter } from './routes/vat-evhc-integration.js';
import helmet from 'helmet';

const app = express();
const httpServer = http.createServer(app);

app.set('trust proxy', 1);

// ── Security headers ─────────────────────────────────────────────────────
// The app previously sent none of these; nginx supplied only X-Frame-Options
// and nosniff.
//
// script-src is enforced at 'self' — that is the header that actually blunts
// injected <script>, which is the payload that matters for stored XSS. Styles
// keep 'unsafe-inline' because the UI is built almost entirely with React
// inline style props, and CSP governs style attributes; enforcing style-src
// would blank the product. img-src allows data: and https: for map tiles and
// avatars, and connect-src covers the API plus the websocket.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src':     ["'self'"],
      'script-src':      ["'self'"],
      'style-src':       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
      'font-src':        ["'self'", 'data:', 'https://fonts.gstatic.com'],
      'img-src':         ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src':     ["'self'", 'https:', 'wss:'],
      'frame-ancestors': ["'none'"],
      'object-src':      ["'none'"],
      'base-uri':        ["'self'"],
      'form-action':     ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  // Six months, subdomains included. Only meaningful over TLS, which the
  // production hostname already serves.
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Uploaded images are served from this origin and embedded by the SPA.
  crossOriginResourcePolicy: { policy: 'same-site' },
  // Would break the Stripe redirect flow and popup-based auth.
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Not covered by helmet's defaults.
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  next();
});
// Dev origins are allowed only outside production; shipping localhost in the
// production allow-list lets a developer's machine drive authenticated,
// credentialed requests against live data.
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];
const corsOrigins = config.env === 'production'
  ? [config.frontendUrl]
  : [config.frontendUrl, ...DEV_ORIGINS];
// The marketing site posts the public enquiry form straight from a browser, so
// that one path needs its own origin allow-list. It MUST be mounted before the
// global cors() below: that middleware answers preflight requests itself and
// ends them, so anything mounted later never sees an OPTIONS and the browser
// gets no Access-Control-Allow-Origin.
app.use('/api/public/enquiries', cors({
  origin: (origin, cb) => cb(null, !origin || config.publicWebOrigins.includes(origin)),
  methods: ['POST', 'OPTIONS'],
  credentials: false,
}));

app.use(cors({ origin: config.frontendUrl === '*' ? true : corsOrigins, credentials: true }));

// ── Stripe webhook MUST be mounted before the global JSON body parser,
//    because it needs the raw request body (express.raw()) to verify the
//    Stripe signature. It's registered here first so its raw-body route
//    matches before express.json() would otherwise consume the stream. ──
app.use('/api/stripe', stripeRouter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static file serving for uploaded content (proofs, avatars, documents, etc.)
app.use('/uploads', express.static(new URL('../uploads', import.meta.url).pathname));

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'car-workshop-backend', status: 'ok', time: new Date().toISOString() });
});

// ── Swagger UI ───────────────────────────────────────────────────────────
// Interactive documentation of every endpoint is a reconnaissance aid; it is
// off in production unless deliberately enabled.
const docsEnabled = config.env !== 'production' || process.env.ENABLE_API_DOCS === 'true';
if (docsEnabled) {
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: 'Car Workshop API Docs',
  swaggerOptions: { persistAuthorization: true },
}));
} else {
  app.use('/api/docs', (_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
}

// ── Core platform ───────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/workshops', workshopsRouter);
app.use('/api/mechanics', mechanicsRouter);
app.use('/api/customers', customersRouter);
// Journey stages 01-02: enquiry capture and channel attribution
app.use('/api/enquiries', enquiriesRouter);
app.use('/api/service-bays', serviceBaysRouter);
app.use('/api/vehicles', vehiclesRouter);

// ── Work order lifecycle ────────────────────────────────────────────────
app.use('/api/work-orders', workOrdersRouter);
app.use('/api/parts', partsRouter);
app.use('/api/job-assignment', jobAssignmentRouter);
app.use('/api/service-pricing', servicePricingRouter);
app.use('/api/service-status', serviceStatusRouter);
app.use('/api/cash-payment', cashPaymentRouter);
app.use('/api/warranty-claims', warrantyClaimsRouter);

// ── Mechanic-facing ──────────────────────────────────────────────────────
app.use('/api/mechanic-earnings', mechanicEarningsRouter);
app.use('/api/mechanic-documents', mechanicDocumentsRouter);
app.use('/api/mechanic-app', mechanicAppRouter);

// ── Customer-facing ──────────────────────────────────────────────────────
app.use('/api/customer-auth', customerAuthRouter);
app.use('/api/customer-portal', customerPortalRouter);

// ── Billing / finance ────────────────────────────────────────────────────
app.use('/api/wallet', walletRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/financial-advanced', financialAdvancedRouter);
app.use('/api/webhooks', webhooksRouter);

// ── Reporting / platform admin ──────────────────────────────────────────
app.use('/api/reports', reportsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/user-notifications', userNotificationsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/uploads', uploadsRouter);

// ── External-facing API ─────────────────────────────────────────────────
// apiKeyAuth must run here: /api/v1 was mounted without it, and
// requireApiPermission() inside the router no-ops when req.isApiKey is falsy,
// so every v1 route was reachable with no credential at all.
app.use('/api/v1', apiKeyAuth, apiV1Router);
app.use('/api/public', publicApiRouter);
// Customer feedback survey (CES / NPS / CSAT): public form + dashboard analysis
app.use('/api/public/survey', publicSurveyRouter);
app.use('/api/customer-survey', adminSurveyRouter);

// ── Marketing / content pages (each file exposes a public + admin router) ─
app.use('/api/careers', publicCareersRouter);
app.use('/api/admin/careers', adminCareersRouter);
// ── CRM phase 1 ──────────────────────────────────────────────
// Mounted under /api/crm so the module namespace matches the sidebar group and
// the per-tenant module keys.
app.use('/api/crm/customers', crmCustomersRouter);
app.use('/api/crm/tasks', crmTasksRouter);
app.use('/api/crm/reminders', crmRemindersRouter);

app.use('/api/legal-pages', legalPublicRouter);
app.use('/api/admin/legal-pages', legalAdminRouter);

// ── Super admin (platform owner) ────────────────────────────────────────
app.use('/api/super-admin', superAdminRouter);
app.use('/api/super-admin', superAdminEnhancedRouter);

// ── SOW: Aftersales workshop operations ──────────────────────────────────
// B1: Service reception & appointment management
app.use('/api/appointments', appointmentsRouter);
app.use('/api/vehicle-receiving', vehicleReceivingRouter);
// B3: Service estimates & operations master
app.use('/api/estimates', estimatesRouter);
// B5: Job cards, technician time capture, QC, loaner vehicles
app.use('/api/job-cards', jobCardsRouter);
// B6: Inventory — requisitions, issues, returns, stock, reservations
app.use('/api/inventory', inventoryRouter);
// B8: Sublet management
app.use('/api/sublet', subletRouter);
// B9: Proforma invoices, gate passes
app.use('/api/proforma', proformaRouter);
app.use('/api/gate-pass', gatePassRouter);
// B9: UAE VAT & FTA e-invoicing
app.use('/api/vat', vatRouter);
// B3 req 74: Electronic Vehicle Health Check
app.use('/api/evhc', evhcRouter);
// Section C: Group integration (Autostrad)
app.use('/api/group-integration', groupIntegrationRouter);

// ── 404 handler ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    success: false,
    message: config.env === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Socket.IO ────────────────────────────────────────────────────────────
initSocket(httpServer);

// ── Background jobs (cron) ──────────────────────────────────────────────
// These are resilient to a missing/unreachable DB — each wraps its own
// interval in try/catch so a DB hiccup doesn't crash the process.
if (process.env.DISABLE_CRON_JOBS !== 'true') {
  try { startAcceptanceTimeout(); } catch (e) { console.error('startAcceptanceTimeout failed:', e.message); }
  try { startJobDelayChecker(); } catch (e) { console.error('startJobDelayChecker failed:', e.message); }
  try { startDocExpiryCron(); } catch (e) { console.error('startDocExpiryCron failed:', e.message); }
  try { startDataRetention(); } catch (e) { console.error('startDataRetention failed:', e.message); }
  try { startTrialEnforcer(); } catch (e) { console.error('startTrialEnforcer failed:', e.message); }
  try { startScheduledReports(); } catch (e) { console.error('startScheduledReports failed:', e.message); }
  try { startReminderCron(); } catch (e) { console.error('startReminderCron failed:', e.message); }

  // ensurePushTable() creates push_subscriptions and user_notifications. It was
  // exported but never called, so on every deployment the in-app notification
  // table simply did not exist and all seven notification routes returned 500.
  ensurePushTable()
    .then(() => console.log('✅ Notification tables ensured'))
    .catch(e => console.error('ensurePushTable failed:', e.message));
}

httpServer.listen(config.port, () => {
  console.log(`Car Workshop Platform API listening on port ${config.port} (${config.env})`);
});

export default app;
