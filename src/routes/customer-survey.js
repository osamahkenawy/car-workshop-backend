/**
 * Customer Feedback Survey — CES / NPS / CSAT
 *
 * Two routers:
 *   publicSurveyRouter — mounted at /api/public/survey, no auth. The page the
 *                        customer actually fills in.
 *   adminSurveyRouter  — mounted at /api/customer-survey, JWT. The dashboard
 *                        analysis, the response list, and issuing invites.
 *
 * Question set matches the approved Google Form exactly (see
 * migrations/post/05_customer_survey.sql for the full list), so scores are
 * comparable with anything already collected there.
 */

import express from 'express';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const publicSurveyRouter = express.Router();
const adminSurveyRouter  = express.Router();

// ── Question metadata ──────────────────────────────────────────────────────
// Single source of truth for the scored items, shared by validation, scoring
// and the per-question breakdown so the three can never disagree.
const CES_ITEMS  = ['ces_find_channel', 'ces_easy_handle'];
const CSAT_ITEMS = [
  'csat_overall', 'csat_as_advertised', 'csat_expectations',
  'csat_rep_knowledge', 'csat_communication', 'csat_response_time',
];
const SCALE_1_5   = [...CES_ITEMS, ...CSAT_ITEMS];
const RESOLUTIONS = ['yes', 'partially', 'no'];

const QUESTION_LABELS = {
  ces_find_channel:   'How easy was it to find our customer service channel?',
  ces_easy_handle:    'Pioneer made it easy for me to handle my request.',
  resolution:         'Was your inquiry fully resolved / request handled?',
  nps_score:          'How likely are you to recommend Pioneer to your friends / relatives / colleagues?',
  nps_reason:         'What is the primary reason for your score?',
  csat_overall:       'Are you satisfied with your overall experience?',
  csat_as_advertised: 'I found the service exactly as advertised.',
  csat_expectations:  'The service received meets my expectations.',
  csat_rep_knowledge: 'How satisfied are you with our customer service representative knowledge?',
  csat_communication: 'How clear was the communication and information?',
  csat_response_time: 'How do you rate our response or processing time?',
};

// ── Scoring ────────────────────────────────────────────────────────────────

/** Standard NPS banding: 9-10 promoter, 7-8 passive, 0-6 detractor. */
function npsCategory(score) {
  if (score === null || score === undefined) return null;
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

/** Mean of the answered items, to 2dp. Null when nothing was answered. */
function meanOf(body, keys) {
  const vals = keys.map(k => Number(body[k])).filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/**
 * Net Promoter Score as the industry-standard percentage:
 *   %promoters - %detractors, over the responses that answered the question.
 * Returns null rather than 0 when nobody has answered, so "no data" and
 * "genuinely neutral" do not look the same on the dashboard.
 */
function computeNps({ promoters, detractors, scored }) {
  if (!scored) return null;
  return Math.round(((promoters - detractors) / scored) * 100);
}

const isBlank = v => v === undefined || v === null || String(v).trim() === '';

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC — the survey the customer fills in
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve which workshop a public submission belongs to.
 *   - an invite token is authoritative
 *   - otherwise a ?workshop=<slug> for anonymous / QR-code links
 *   - otherwise, if the deployment has exactly one active workshop, use it
 */
async function resolveWorkshop(req) {
  const slug = req.body?.workshop || req.query?.workshop;
  if (!isBlank(slug)) {
    const [w] = await query(
      "SELECT id FROM workshops WHERE slug = ? AND status IN ('active','trial')",
      [String(slug).trim()]
    );
    return w ? w.id : null;
  }
  const rows = await query("SELECT id FROM workshops WHERE status IN ('active','trial') LIMIT 2");
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * GET /api/public/survey/:token
 * Context for a personalised link: who it is for and whether it is already
 * used, so the page can greet them and avoid a duplicate submission.
 */
publicSurveyRouter.get('/:token', async (req, res) => {
  try {
    const [inv] = await query(
      `SELECT i.id, i.contact_name, i.branch, i.service_requested, i.responded_at, i.expires_at,
              wo.work_order_number
       FROM survey_invites i
       LEFT JOIN work_orders wo ON i.work_order_id = wo.id
       WHERE i.token = ?`,
      [req.params.token]
    );
    if (!inv) return res.status(404).json({ success: false, message: 'This survey link is not valid.' });

    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'This survey link has expired.', expired: true });
    }

    return res.json({
      success: true,
      data: {
        contactName: inv.contact_name,
        branch: inv.branch,
        service: inv.service_requested,
        workOrderNumber: inv.work_order_number,
        alreadyAnswered: !!inv.responded_at,
      },
    });
  } catch (err) {
    console.error('[public/survey/:token GET]', err.message);
    return res.status(500).json({ success: false, message: 'Could not load the survey.' });
  }
});

/**
 * POST /api/public/survey
 * Record a completed survey. Accepts an optional `token` from a personalised
 * link, which attaches the response to that job, branch and customer.
 */
publicSurveyRouter.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    // ── Resolve the invite first: it decides the workshop and the context ──
    let invite = null;
    if (!isBlank(body.token)) {
      const [row] = await query(
        `SELECT id, workshop_id, work_order_id, customer_id, contact_name, contact_phone,
                contact_email, branch, service_requested, responded_at, expires_at
         FROM survey_invites WHERE token = ?`,
        [String(body.token).trim()]
      );
      if (!row) return res.status(404).json({ success: false, message: 'This survey link is not valid.' });
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return res.status(410).json({ success: false, message: 'This survey link has expired.' });
      }
      if (row.responded_at) {
        return res.status(409).json({
          success: false, alreadyAnswered: true,
          message: 'Thank you — we have already received your response for this visit.',
        });
      }
      invite = row;
    }

    const workshopId = invite ? invite.workshop_id : await resolveWorkshop(req);
    if (!workshopId) {
      return res.status(400).json({ success: false, message: 'Could not determine which branch this survey is for.' });
    }

    // ── Validation ────────────────────────────────────────────────────────
    const errors = [];
    for (const key of SCALE_1_5) {
      if (isBlank(body[key])) {
        errors.push({ field: key, message: `Please answer: ${QUESTION_LABELS[key]}` });
        continue;
      }
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        errors.push({ field: key, message: 'Answer must be a whole number from 1 to 5' });
      }
    }
    if (isBlank(body.resolution)) {
      errors.push({ field: 'resolution', message: `Please answer: ${QUESTION_LABELS.resolution}` });
    } else if (!RESOLUTIONS.includes(String(body.resolution).toLowerCase())) {
      errors.push({ field: 'resolution', message: `Answer must be one of: ${RESOLUTIONS.join(', ')}` });
    }
    if (isBlank(body.nps_score)) {
      errors.push({ field: 'nps_score', message: `Please answer: ${QUESTION_LABELS.nps_score}` });
    } else {
      const n = Number(body.nps_score);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        errors.push({ field: 'nps_score', message: 'Answer must be a whole number from 0 to 10' });
      }
    }
    if (errors.length) {
      return res.status(422).json({ success: false, message: 'Some answers are missing or invalid', errors });
    }

    // ── Derive the scores ─────────────────────────────────────────────────
    const npsScore   = Number(body.nps_score);
    const resolution = String(body.resolution).toLowerCase();
    const category   = npsCategory(npsScore);

    // Anything a detractor said, or any job that was not fully resolved, is
    // surfaced for follow-up rather than left to be noticed by chance.
    const isFlagged = (category === 'detractor' || resolution !== 'yes') ? 1 : 0;

    const lang   = body.language === 'ar' ? 'ar' : 'en';
    const source = ['link', 'qr', 'portal', 'staff'].includes(body.source) ? body.source : 'link';
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;

    const pick = (fromBody, fromInvite) =>
      !isBlank(fromBody) ? String(fromBody).trim() : (fromInvite || null);

    const result = await execute(
      `INSERT INTO survey_responses
         (workshop_id, invite_id, work_order_id, customer_id,
          ces_find_channel, ces_easy_handle, resolution,
          nps_score, nps_reason,
          csat_overall, csat_as_advertised, csat_expectations,
          csat_rep_knowledge, csat_communication, csat_response_time,
          ces_avg, csat_avg, nps_category,
          contact_name, contact_phone, contact_email, branch, service_requested,
          language, source, is_flagged, ip_address, user_agent, submitted_at)
       VALUES (?,?,?,?, ?,?,?, ?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, NOW())`,
      [
        workshopId,
        invite ? invite.id : null,
        invite ? invite.work_order_id : null,
        invite ? invite.customer_id : null,

        Number(body.ces_find_channel), Number(body.ces_easy_handle), resolution,
        npsScore, isBlank(body.nps_reason) ? null : String(body.nps_reason).trim(),

        Number(body.csat_overall), Number(body.csat_as_advertised), Number(body.csat_expectations),
        Number(body.csat_rep_knowledge), Number(body.csat_communication), Number(body.csat_response_time),

        meanOf(body, CES_ITEMS), meanOf(body, CSAT_ITEMS), category,

        pick(body.contact_name, invite?.contact_name),
        pick(body.contact_phone, invite?.contact_phone),
        pick(body.contact_email, invite?.contact_email),
        pick(body.branch, invite?.branch),
        pick(body.service, invite?.service_requested),

        lang, source, isFlagged, clientIp,
        (req.headers['user-agent'] || '').slice(0, 255) || null,
      ]
    );

    if (invite) {
      await execute('UPDATE survey_invites SET responded_at = NOW() WHERE id = ?', [invite.id]);
    }

    return res.status(201).json({
      success: true,
      message: 'Thank you — your feedback has been recorded.',
      data: { id: result.insertId, npsCategory: category },
    });
  } catch (err) {
    console.error('[public/survey POST]', err.message);
    return res.status(500).json({ success: false, message: 'Could not record your feedback. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  STAFF — dashboard analysis, response list, invites
// ═══════════════════════════════════════════════════════════════════════════

adminSurveyRouter.use(authMiddleware);

/** Shared date/branch filter so the list and the stats always agree. */
function buildFilter(req) {
  const where = ['r.workshop_id = ?'];
  const params = [req.user.workshop_id];

  if (req.query.from) { where.push('r.submitted_at >= ?'); params.push(`${req.query.from} 00:00:00`); }
  if (req.query.to)   { where.push('r.submitted_at <= ?'); params.push(`${req.query.to} 23:59:59`); }
  if (req.query.branch)   { where.push('r.branch = ?');       params.push(req.query.branch); }
  if (req.query.category) { where.push('r.nps_category = ?'); params.push(req.query.category); }
  if (req.query.flagged === '1') where.push('r.is_flagged = 1 AND r.followed_up_at IS NULL');

  return { clause: where.join(' AND '), params };
}

/**
 * GET /api/customer-survey/stats
 * Everything the dashboard needs: the three headline scores, the NPS split,
 * per-question averages, a 12-month trend, and branch / service breakdowns.
 */
adminSurveyRouter.get('/stats', async (req, res) => {
  try {
    const { clause, params } = buildFilter(req);

    const perQuestionAvg = SCALE_1_5.map(k => `ROUND(AVG(r.${k}), 2) AS ${k}`).join(', ');

    const [head] = await query(
      `SELECT
         COUNT(*) AS responses,
         SUM(r.nps_score IS NOT NULL)              AS nps_scored,
         SUM(r.nps_category = 'promoter')          AS promoters,
         SUM(r.nps_category = 'passive')           AS passives,
         SUM(r.nps_category = 'detractor')         AS detractors,
         ROUND(AVG(r.ces_avg), 2)                  AS ces_avg,
         ROUND(AVG(r.csat_avg), 2)                 AS csat_avg,
         SUM(r.csat_avg >= 4)                      AS csat_satisfied,
         SUM(r.ces_avg  >= 4)                      AS ces_easy,
         SUM(r.resolution = 'yes')                 AS resolved_yes,
         SUM(r.resolution = 'partially')           AS resolved_partially,
         SUM(r.resolution = 'no')                  AS resolved_no,
         SUM(r.is_flagged = 1 AND r.followed_up_at IS NULL) AS needs_follow_up,
         ${perQuestionAvg}
       FROM survey_responses r WHERE ${clause}`,
      params
    );

    const responses = Number(head.responses) || 0;
    const scored    = Number(head.nps_scored) || 0;
    const pct = (n) => (responses ? Math.round((Number(n) / responses) * 100) : 0);

    // 12-month trend. Bucketed in SQL so a long history stays cheap.
    const trend = await query(
      `SELECT DATE_FORMAT(r.submitted_at, '%Y-%m') AS month,
              COUNT(*) AS responses,
              ROUND(AVG(r.csat_avg), 2) AS csat_avg,
              ROUND(AVG(r.ces_avg), 2)  AS ces_avg,
              SUM(r.nps_category = 'promoter')  AS promoters,
              SUM(r.nps_category = 'detractor') AS detractors,
              SUM(r.nps_score IS NOT NULL)      AS scored
       FROM survey_responses r
       WHERE ${clause} AND r.submitted_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month ASC`,
      params
    );

    const byBranch = await query(
      `SELECT COALESCE(NULLIF(r.branch, ''), 'Unspecified') AS branch,
              COUNT(*) AS responses,
              ROUND(AVG(r.csat_avg), 2) AS csat_avg,
              ROUND(AVG(r.ces_avg), 2)  AS ces_avg,
              SUM(r.nps_category = 'promoter')  AS promoters,
              SUM(r.nps_category = 'detractor') AS detractors,
              SUM(r.nps_score IS NOT NULL)      AS scored
       FROM survey_responses r WHERE ${clause}
       GROUP BY branch ORDER BY responses DESC`,
      params
    );

    const byService = await query(
      `SELECT COALESCE(NULLIF(r.service_requested, ''), 'Unspecified') AS service,
              COUNT(*) AS responses,
              ROUND(AVG(r.csat_avg), 2) AS csat_avg,
              SUM(r.nps_category = 'promoter')  AS promoters,
              SUM(r.nps_category = 'detractor') AS detractors,
              SUM(r.nps_score IS NOT NULL)      AS scored
       FROM survey_responses r WHERE ${clause}
       GROUP BY service ORDER BY responses DESC LIMIT 10`,
      params
    );

    // Verbatims are the most actionable part of the survey, so detractors
    // come first regardless of recency.
    const verbatims = await query(
      `SELECT r.id, r.nps_score, r.nps_category, r.nps_reason, r.branch,
              r.service_requested, r.contact_name, r.submitted_at
       FROM survey_responses r
       WHERE ${clause} AND r.nps_reason IS NOT NULL AND TRIM(r.nps_reason) <> ''
       ORDER BY (r.nps_category = 'detractor') DESC, r.submitted_at DESC
       LIMIT 25`,
      params
    );

    const withNps = (row) => ({
      ...row,
      nps: computeNps({
        promoters: Number(row.promoters) || 0,
        detractors: Number(row.detractors) || 0,
        scored: Number(row.scored) || 0,
      }),
    });

    return res.json({
      success: true,
      data: {
        headline: {
          responses,
          nps: computeNps({
            promoters: Number(head.promoters) || 0,
            detractors: Number(head.detractors) || 0,
            scored,
          }),
          npsScored: scored,
          cesAvg:  head.ces_avg  === null ? null : Number(head.ces_avg),
          csatAvg: head.csat_avg === null ? null : Number(head.csat_avg),
          csatPercent: pct(head.csat_satisfied),
          cesEasyPercent: pct(head.ces_easy),
          needsFollowUp: Number(head.needs_follow_up) || 0,
        },
        npsBreakdown: {
          promoters:  Number(head.promoters)  || 0,
          passives:   Number(head.passives)   || 0,
          detractors: Number(head.detractors) || 0,
          promoterPct:  scored ? Math.round((Number(head.promoters)  / scored) * 100) : 0,
          passivePct:   scored ? Math.round((Number(head.passives)   / scored) * 100) : 0,
          detractorPct: scored ? Math.round((Number(head.detractors) / scored) * 100) : 0,
        },
        resolution: {
          yes:       Number(head.resolved_yes)       || 0,
          partially: Number(head.resolved_partially) || 0,
          no:        Number(head.resolved_no)        || 0,
          resolvedPercent: pct(head.resolved_yes),
        },
        questions: SCALE_1_5.map(k => ({
          key: k,
          label: QUESTION_LABELS[k],
          section: CES_ITEMS.includes(k) ? 'CES' : 'CSAT',
          avg: head[k] === null ? null : Number(head[k]),
        })),
        trend: trend.map(withNps),
        byBranch: byBranch.map(withNps),
        byService: byService.map(withNps),
        verbatims,
      },
    });
  } catch (err) {
    console.error('[customer-survey/stats]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to load survey analysis' });
  }
});

/**
 * GET /api/customer-survey
 * The response list — all responses in one place, with the same filters as
 * the analysis so the numbers and the rows always match.
 */
adminSurveyRouter.get('/', async (req, res) => {
  try {
    const { clause, params } = buildFilter(req);
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM survey_responses r WHERE ${clause}`, params
    );

    const rows = await query(
      `SELECT r.id, r.contact_name, r.contact_phone, r.branch, r.service_requested,
              r.ces_avg, r.csat_avg, r.nps_score, r.nps_category, r.nps_reason,
              r.resolution, r.language, r.source, r.is_flagged, r.followed_up_at,
              r.submitted_at, r.work_order_id, wo.work_order_number
       FROM survey_responses r
       LEFT JOIN work_orders wo ON r.work_order_id = wo.id
       WHERE ${clause}
       ORDER BY r.submitted_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return res.json({
      success: true,
      data: rows,
      pagination: { page, limit, total: Number(total), pages: Math.ceil(Number(total) / limit) },
    });
  } catch (err) {
    console.error('[customer-survey GET]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch survey responses' });
  }
});

/** GET /api/customer-survey/:id — one full response, every answer. */
adminSurveyRouter.get('/:id', async (req, res) => {
  try {
    const [row] = await query(
      `SELECT r.*, wo.work_order_number
       FROM survey_responses r
       LEFT JOIN work_orders wo ON r.work_order_id = wo.id
       WHERE r.id = ? AND r.workshop_id = ?`,
      [req.params.id, req.user.workshop_id]
    );
    if (!row) return res.status(404).json({ success: false, message: 'Response not found' });

    return res.json({
      success: true,
      data: {
        ...row,
        answers: [
          ...CES_ITEMS.map(k => ({ key: k, section: 'CES', label: QUESTION_LABELS[k], value: row[k], max: 5 })),
          { key: 'resolution', section: 'CES', label: QUESTION_LABELS.resolution, value: row.resolution },
          { key: 'nps_score', section: 'NPS', label: QUESTION_LABELS.nps_score, value: row.nps_score, max: 10 },
          { key: 'nps_reason', section: 'NPS', label: QUESTION_LABELS.nps_reason, value: row.nps_reason },
          ...CSAT_ITEMS.map(k => ({ key: k, section: 'CSAT', label: QUESTION_LABELS[k], value: row[k], max: 5 })),
        ],
      },
    });
  } catch (err) {
    console.error('[customer-survey/:id GET]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch response' });
  }
});

/**
 * POST /api/customer-survey/invites
 * Mint a personalised survey link, optionally tied to a completed job so the
 * response arrives already attributed to that customer, branch and service.
 */
adminSurveyRouter.post('/invites', async (req, res) => {
  try {
    const { work_order_id, customer_id, contact_name, contact_phone, contact_email,
            branch, service, channel, expires_in_days } = req.body || {};

    let ctx = {
      work_order_id: work_order_id || null,
      customer_id: customer_id || null,
      contact_name: contact_name || null,
      contact_phone: contact_phone || null,
      contact_email: contact_email || null,
      branch: branch || null,
      service: service || null,
    };

    // Pull the details off the work order so staff do not retype them.
    if (ctx.work_order_id) {
      const [wo] = await query(
        `SELECT id, customer_id, customer_name, customer_phone, service_category
         FROM work_orders WHERE id = ? AND workshop_id = ?`,
        [ctx.work_order_id, req.user.workshop_id]
      );
      if (!wo) return res.status(404).json({ success: false, message: 'Work order not found' });
      ctx = {
        ...ctx,
        customer_id:   ctx.customer_id   || wo.customer_id,
        contact_name:  ctx.contact_name  || wo.customer_name,
        contact_phone: ctx.contact_phone || wo.customer_phone,
        service:       ctx.service       || wo.service_category,
      };
    }

    if (isBlank(ctx.contact_name) && isBlank(ctx.contact_phone) && !ctx.work_order_id) {
      return res.status(422).json({
        success: false,
        message: 'Provide a work order, or at least a contact name or phone, so the response can be attributed.',
      });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const days  = Number.isFinite(Number(expires_in_days)) ? Number(expires_in_days) : 30;

    const result = await execute(
      `INSERT INTO survey_invites
         (workshop_id, token, work_order_id, customer_id, contact_name, contact_phone,
          contact_email, branch, service_requested, channel, sent_at, sent_by, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, NOW(), ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        req.user.workshop_id, token, ctx.work_order_id, ctx.customer_id,
        ctx.contact_name, ctx.contact_phone, ctx.contact_email,
        ctx.branch, ctx.service,
        ['whatsapp', 'sms', 'email', 'qr', 'link'].includes(channel) ? channel : 'link',
        req.user.id, days,
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Survey link created',
      data: { id: result.insertId, token, path: `/survey/${token}`, expiresInDays: days },
    });
  } catch (err) {
    console.error('[customer-survey/invites POST]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create survey link' });
  }
});

/** PATCH /api/customer-survey/:id/follow-up — close the loop on a flagged response. */
adminSurveyRouter.patch('/:id/follow-up', async (req, res) => {
  try {
    const result = await execute(
      `UPDATE survey_responses
       SET followed_up_at = NOW(), followed_up_by = ?, follow_up_notes = ?
       WHERE id = ? AND workshop_id = ?`,
      [req.user.id, req.body?.notes || null, req.params.id, req.user.workshop_id]
    );
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Response not found' });
    return res.json({ success: true, message: 'Follow-up recorded' });
  } catch (err) {
    console.error('[customer-survey/:id/follow-up PATCH]', err.message);
    return res.status(500).json({ success: false, message: 'Failed to record follow-up' });
  }
});

export { publicSurveyRouter, adminSurveyRouter };
