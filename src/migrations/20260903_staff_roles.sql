-- Staff roles: Service Advisor, Part Advisor, Workshop Manager,
-- General Manager, Supervisor, Workshop Foreman.
--
-- The platform already had the machinery for custom roles: `roles.modules` is a
-- JSON list of sidebar module keys, and on login auth.js turns it into
-- `permitted_modules`, which the frontend uses to filter the nav. What it did
-- not have was any way to *reach* it. Login looks the role up with
--
--     SELECT ... FROM roles WHERE workshop_id = ? AND slug = users.role
--
-- and `users.role` was an ENUM of five values, so a row with slug
-- 'service_advisor' could never be matched — the column would not accept that
-- value in the first place. This widens the enum so the existing lookup works.
--
-- Safe to run on a populated table: every current value is kept, and widening
-- an ENUM does not rewrite or reinterpret existing rows.
--
-- Nothing gates on role = 'admin' server-side (`adminOnly` in
-- middleware/auth.js is defined but never mounted, and App.jsx has no
-- role-based route guards), so the new values do not silently lose access to
-- anything. Access is granted per role by `roles.modules`.
--
-- Idempotent: only alters while the new values are absent.

SET @needs_widening := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'users'
     AND column_name  = 'role'
     AND COLUMN_TYPE NOT LIKE '%service_advisor%'
);

SET @sql := IF(@needs_widening > 0,
  "ALTER TABLE users MODIFY role ENUM(
     'super_admin','admin','dispatcher','mechanic','customer',
     'general_manager','workshop_manager','service_advisor',
     'part_advisor','supervisor','workshop_foreman'
   ) NOT NULL DEFAULT 'admin'",
  'SELECT "users.role enum already includes the staff roles" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- A role is scoped to one workshop, and its slug identifies it within that
-- workshop. Without this, a re-run of the seeder would insert duplicates and
-- the login lookup would pick an arbitrary one of them.
SET @has_unique := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name   = 'roles'
     AND index_name   = 'uniq_roles_workshop_slug'
);
SET @sql := IF(@has_unique = 0,
  'ALTER TABLE roles ADD UNIQUE KEY uniq_roles_workshop_slug (workshop_id, slug)',
  'SELECT "roles unique key already present" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
