# Staging deploy — CRM, KPI reporting, Customer Experience, Complaints (2026-09-09)

Server: ubuntu@130.61.83.110  (workshop.pioneeruae.com)
Backend:  /var/www/car-workshop/backend      pm2 name: car-workshop-backend
Frontend: /var/www/car-workshop/frontend

Deploys: backend b69edc3, frontend 4955152

Staging was last deployed at backend 1607faf / frontend 91548b7
(deploy/DEPLOY-2026-09-02-security.md). That is **26 commits behind** on
each repo — this is not a small delta. It carries, among other things:
CRM phase 1 (Customer 360, Service Reminders, Tasks), the KPI reporting
endpoints (booking funnel, repeat customers, contact-channel volume), the
Customer Experience dashboard (NPS gauge, needs-attention queue), and the
new Complaints feature (`disputes` table wired up end-to-end). Budget
time for a full smoke test after this, not a 5-minute check.

No new npm dependencies on either repo (`package.json` is untouched since
1607faf/91548b7) and no new environment variables — `npm install` below
is just the standard safety net, not expected to change anything.

The nginx security-headers include from the last deploy doc (Step 5
there) was never actually applied — that requires a manual edit of
`/etc/nginx/sites-available/car-workshop`, which only happens during a
deploy, and staging hasn't been deployed since. It is **not** part of
this deploy (unrelated to the work below); do it as its own change if/when
wanted, following that doc's Step 5 verbatim.

---------------------------------------------------------------------------
STEP 0 — Back up first. Migrations touch several tables.
---------------------------------------------------------------------------
  mkdir -p ~/backups
  mysqldump -u root -p car_workshop | gzip > ~/backups/car_workshop-$(date +%F-%H%M).sql.gz
  ls -lh ~/backups | tail -3

---------------------------------------------------------------------------
STEP 1 — Pull code
---------------------------------------------------------------------------
  cd /var/www/car-workshop/backend && git pull origin main
  git log --oneline -1        # expect b69edc3

/var/www/car-workshop/frontend is NOT a git checkout — see Step 4.

---------------------------------------------------------------------------
STEP 2 — Backend dependencies
---------------------------------------------------------------------------
  cd /var/www/car-workshop/backend && npm install --omit=dev

No build step: the backend is plain ESM Node.

---------------------------------------------------------------------------
STEP 3 — Migrations, in this order (all idempotent; safe to re-run even
          if some were already applied — every CREATE TABLE is
          IF NOT EXISTS and every ALTER is guarded by an
          information_schema check, verified across every file below)
---------------------------------------------------------------------------
  cd /var/www/car-workshop/backend

  mysql -u root -p car_workshop < src/migrations/car_workshop.sql
  mysql -u root -p car_workshop < src/migrations/post/00_schema_patches.sql
  mysql -u root -p car_workshop < src/migrations/post/01_seed_countries.sql
  mysql -u root -p car_workshop < src/migrations/post/02_sow_schema.sql
  mysql -u root -p car_workshop < src/migrations/post/03_customer_journey.sql
  mysql -u root -p car_workshop < src/migrations/post/04_enquiry_intake.sql
  mysql -u root -p car_workshop < src/migrations/post/05_customer_survey.sql
  mysql -u root -p car_workshop < src/migrations/20260825_widen_service_status_token.sql
  mysql -u root -p car_workshop < src/migrations/20260825_create_user_notifications.sql
  mysql -u root -p car_workshop < src/migrations/20260825_enquiries_phone_nullable.sql
  mysql -u root -p car_workshop < src/migrations/20260902_crm_phase1.sql
  mysql -u root -p car_workshop < src/migrations/20260903_staff_roles.sql
  mysql -u root -p car_workshop < src/migrations/20260903_survey_external_id.sql
  mysql -u root -p car_workshop < src/migrations/20260904_add_inspection_status.sql
  mysql -u root -p car_workshop < src/migrations/20260904_remove_failed_add_journey_fields.sql
  mysql -u root -p car_workshop < src/migrations/20260904_vehicle_inspections.sql
  mysql -u root -p car_workshop < src/migrations/20260909_contact_channels.sql

Order matters here (car_workshop.sql creates the base tables everything
else ALTERs) but re-running any already-applied file is a no-op — none of
them need to know what staging's current state is.

What the ones relevant to this deploy do, specifically:
  post/03_customer_journey.sql   adds case_number/intake_channel/
                                  acknowledged_at/response_due_at/outcome/
                                  outcome_communicated_at/authority_level/
                                  changes_made to `disputes` — the
                                  Complaints feature's whole schema
  20260902_crm_phase1.sql        crm_tasks, crm_reminders, customer
                                  activity tables — Customer 360, Service
                                  Reminders, Tasks
  20260903_staff_roles.sql       widens users.role — required before
                                  Step 3b (seed-roles.js) below, which
                                  will fail on a truncated-value error
                                  without it
  20260909_contact_channels.sql  widens customer_activities.activity_type
                                  to include mobile_app/web_portal/
                                  social_media — the Contact Volume by
                                  Channel report

---------------------------------------------------------------------------
STEP 3b — Re-grant staff role modules (adds 'complaints' to the roles
           that should see it; also idempotent)
---------------------------------------------------------------------------
  cd /var/www/car-workshop/backend
  node scripts/seed-roles.js --dry-run     # sanity check first
  node scripts/seed-roles.js               # apply

Do NOT pass --reset-passwords — that issues new staff passwords, which is
not what this deploy needs.

---------------------------------------------------------------------------
STEP 4 — Frontend build
---------------------------------------------------------------------------
Get the source checkout up to date (clone it if /tmp was cleared):

  FE=/tmp/car-workshop-frontend-build
  if [ -d "$FE/.git" ]; then cd "$FE" && git fetch origin && git reset --hard origin/main;   else rm -rf "$FE" && git clone https://github.com/osamahkenawy/car-workshop-frontend.git "$FE" && cd "$FE"; fi
  git log --oneline -1        # expect 4955152

Build it (npm install, not npm ci — the lockfile has not been verified in sync):

  cd /tmp/car-workshop-frontend-build && npm install && npm run build

Check the build produced all three entries before replacing anything:

  ls dist/            # must show: assets  fonts  index.html

Only then swap it in:

  sudo rm -rf /var/www/car-workshop/frontend/*
  sudo cp -r /tmp/car-workshop-frontend-build/dist/. /var/www/car-workshop/frontend/
  ls /var/www/car-workshop/frontend/

The rm is safe: everything in that directory is generated by the build.
Do NOT run it unless the preceding build succeeded and dist/ contains all
three entries.

---------------------------------------------------------------------------
STEP 5 — Restart backend
---------------------------------------------------------------------------
  pm2 restart car-workshop-backend --update-env
  pm2 logs car-workshop-backend --lines 30 --nostream

---------------------------------------------------------------------------
STEP 6 — Verify
---------------------------------------------------------------------------
  curl -s -o /dev/null -w "health %{http_code}\n" http://localhost:4000/health

Log in to the staging site and check, at minimum:
  - Sidebar shows Complaints under CRM, and Customer Experience under
    Analytics, for a general_manager / workshop_manager / service_advisor
    login (the roles seed-roles.js just granted them to)
  - Complaints page loads, "New complaint" creates one, the Acknowledge ->
    Start investigating -> Resolve -> Mark communicated -> Close sequence
    of buttons works and the KPI strip updates after each action
  - Customer Experience dashboard loads: NPS gauge renders, the
    Complaints card at the bottom shows real numbers (not "Coming Soon"),
    "View complaints" navigates through
  - Reports > Business KPIs tab loads and its Contact Volume by Channel
    table has data
  - Customer 360, Service Reminders and Tasks & Follow-ups (CRM section)
    all load without a 500

If the notification bell or any existing page breaks, that is a
regression from a commit in the 26-commit range above, not from today's
work specifically — check `pm2 logs` for the actual error before assuming
which change caused it.

---------------------------------------------------------------------------
Rollback
---------------------------------------------------------------------------
  cd /var/www/car-workshop/backend  && git reset --hard 1607faf && npm install --omit=dev
  cd /tmp/car-workshop-frontend-build && git reset --hard 91548b7 && npm install && npm run build
  sudo rm -rf /var/www/car-workshop/frontend/* && sudo cp -r dist/. /var/www/car-workshop/frontend/
  pm2 restart car-workshop-backend --update-env

Every migration above is additive (new tables/columns, widened enums) —
none of it needs reverting for the old code to keep running.
