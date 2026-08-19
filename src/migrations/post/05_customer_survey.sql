-- ═══════════════════════════════════════════════════════════════════════════
--  Customer Feedback Survey — CES / NPS / CSAT
--
--  Backs the public survey page and the in-dashboard analysis. The question
--  set mirrors the approved Google Form "Customer Feedback Survey (Pioneer)"
--  exactly, so responses collected here are directly comparable with any
--  already gathered there:
--
--    Customer Effort Score (CES)
--      1. How easy was it to find our customer service channel?      1-5
--      2. Pioneer made it easy for me to handle my request.           1-5
--      3. Was your inquiry fully resolved / request handled?      yes/part/no
--    Net Promoter Score (NPS)
--      4. How likely are you to recommend Pioneer to your
--         friends / relatives / colleagues?                           0-10
--      5. What's the primary reason for your score?                   text
--    Customer Satisfaction (CSAT)
--      6. Are you satisfied with your overall experience?             1-5
--      7. I found the service exactly as advertised.                  1-5
--      8. The service received meets my expectations.                 1-5
--      9. Rep's knowledge                                             1-5
--     10. Clarity of communication and information                    1-5
--     11. Response / processing time                                   1-5
--
--  This is separate from `customer_feedback`, which models the outbound
--  48-hour follow-up *call* (scheduled/attempted/completed, phone channel,
--  work_order_id NOT NULL). A survey response is inbound, self-service, may
--  arrive with no work order attached, and carries 11 scored answers — a
--  different lifecycle, so it gets its own table and can be cross-referenced
--  by work_order_id when a link exists.
--
--  Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Invites ────────────────────────────────────────────────────────────────
-- One row per personalised survey link. Sending a survey after handover mints
-- a token so the response attributes itself to that job, branch and customer
-- without asking the customer to identify themselves again. Fully optional:
-- an anonymous link or QR code can be answered with no invite at all.
CREATE TABLE IF NOT EXISTS survey_invites (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id       INT NOT NULL,
  token             VARCHAR(64) NOT NULL,
  work_order_id     INT NULL,
  customer_id       INT NULL,

  contact_name      VARCHAR(160) NULL,
  contact_phone     VARCHAR(30) NULL,
  contact_email     VARCHAR(190) NULL,
  branch            VARCHAR(120) NULL,
  service_requested VARCHAR(200) NULL,

  channel           ENUM('whatsapp','sms','email','qr','link') DEFAULT 'link',
  sent_at           DATETIME NULL,
  sent_by           INT NULL,
  expires_at        DATETIME NULL,
  responded_at      DATETIME NULL,

  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_survey_invite_token (token),
  INDEX idx_survey_invite_workshop (workshop_id),
  INDEX idx_survey_invite_work_order (work_order_id),
  INDEX idx_survey_invite_responded (responded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Responses ──────────────────────────────────────────────────────────────
-- ces_avg / csat_avg / nps_category are derived on insert and stored so the
-- dashboard aggregates stay simple and indexable. They are always written
-- together with the answers they summarise.
CREATE TABLE IF NOT EXISTS survey_responses (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  workshop_id           INT NOT NULL,
  invite_id             INT NULL,
  work_order_id         INT NULL,
  customer_id           INT NULL,

  -- Customer Effort Score
  ces_find_channel      TINYINT NULL COMMENT '1-5: extremely difficult -> extremely easy',
  ces_easy_handle       TINYINT NULL COMMENT '1-5: strongly disagree -> strongly agree',
  resolution            ENUM('yes','partially','no') NULL COMMENT 'inquiry fully resolved?',

  -- Net Promoter Score
  nps_score             TINYINT NULL COMMENT '0-10: very unlikely -> extremely likely',
  nps_reason            TEXT NULL COMMENT 'primary reason for the score',

  -- Customer Satisfaction
  csat_overall          TINYINT NULL COMMENT '1-5 overall experience',
  csat_as_advertised    TINYINT NULL COMMENT '1-5 service as advertised',
  csat_expectations     TINYINT NULL COMMENT '1-5 meets expectations',
  csat_rep_knowledge    TINYINT NULL COMMENT '1-5 representative knowledge',
  csat_communication    TINYINT NULL COMMENT '1-5 clarity of communication',
  csat_response_time    TINYINT NULL COMMENT '1-5 response / processing time',

  -- Derived
  ces_avg               DECIMAL(4,2) NULL COMMENT 'mean of the two CES items',
  csat_avg              DECIMAL(4,2) NULL COMMENT 'mean of the six CSAT items',
  nps_category          ENUM('promoter','passive','detractor') NULL,

  -- Context
  contact_name          VARCHAR(160) NULL,
  contact_phone         VARCHAR(30) NULL,
  contact_email         VARCHAR(190) NULL,
  branch                VARCHAR(120) NULL,
  service_requested     VARCHAR(200) NULL,
  language              ENUM('en','ar') DEFAULT 'en',
  source                ENUM('link','qr','portal','staff','google_form') DEFAULT 'link',

  is_flagged            TINYINT(1) DEFAULT 0 COMMENT 'needs follow-up (detractor or unresolved)',
  followed_up_at        DATETIME NULL,
  followed_up_by        INT NULL,
  follow_up_notes       TEXT NULL,

  ip_address            VARCHAR(45) NULL,
  user_agent            VARCHAR(255) NULL,
  submitted_at          DATETIME NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_survey_resp_workshop (workshop_id),
  INDEX idx_survey_resp_submitted (submitted_at),
  INDEX idx_survey_resp_nps (nps_category),
  INDEX idx_survey_resp_branch (branch),
  INDEX idx_survey_resp_work_order (work_order_id),
  INDEX idx_survey_resp_flagged (is_flagged),
  INDEX idx_survey_resp_invite (invite_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
