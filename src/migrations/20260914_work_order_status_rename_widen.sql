-- ═══════════════════════════════════════════════════════════════════════
-- work_orders.status — WIDEN ONLY (step 1 of an expand/contract rename)
--
-- The workshop wants the status vocabulary renamed in place:
--   pending    -> estimate_approved   (a job card now comes into being BY an
--                                      estimate being approved — see
--                                      routes/estimates.js applyLineDecision)
--   confirmed  -> pending             (what used to mean "confirmed" is now
--                                      called "pending" — the plain,
--                                      no-estimate creation path's new home)
--   assigned   -> auto_assign         (assignment is becoming automatic —
--                                      see the job-card-categories phase)
--   accepted   -> REMOVED             (the manual "Accepted" step goes away
--                                      entirely; existing rows move forward
--                                      to in_progress — accepting a job
--                                      always meant work was starting, never
--                                      that it was still waiting)
--   in_progress / inspection / ready_for_pickup / completed / cancelled
--              -> unchanged
--
-- Why this migration does NOT also move the data or drop the old values:
-- this column is read and written from roughly 30 backend files (crons,
-- the mechanic mobile app, webhooks, reports, the public API) and a
-- comparable frontend surface, many of which reuse the words 'pending' /
-- 'confirmed' / 'assigned' for OTHER, unrelated enums (payment_status,
-- dispute status, invoice status, document status) — so this cannot be a
-- mechanical find-and-replace across the codebase.
--
-- Renaming the stored values before every one of those ~190 call sites is
-- updated to match would not fail loudly — it would fail SILENTLY: a cron
-- filtering `WHERE status = 'pending'` would simply stop finding the 174
-- real orders sitting there (now called something else) and quietly do
-- nothing, while a filter checking the new name would start matching
-- orders that are actually one stage further along than intended. On a
-- table with 17,000+ real rows and crons running against it every few
-- minutes, that is a production incident with no error message attached.
--
-- So the column is WIDENED here (a strict superset of old ∪ new values —
-- nothing currently written or read stops working) and nothing else
-- changes yet. The data UPDATE and every application-code reference move
-- together in a second migration + a single coordinated deploy, once the
-- full reference sweep is complete and reviewed. Only after that has run
-- and been confirmed stable should a third migration narrow the enum back
-- down to just the new values and drop this safety net.
-- ═══════════════════════════════════════════════════════════════════════
SET @def := (SELECT COLUMN_TYPE FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'status');
SET @sql := IF(@def NOT LIKE '%estimate_approved%',
  "ALTER TABLE work_orders MODIFY COLUMN status ENUM(
     'pending','confirmed','assigned','accepted',
     'estimate_approved','auto_assign',
     'in_progress','inspection','ready_for_pickup','completed','cancelled'
   ) DEFAULT 'pending'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
