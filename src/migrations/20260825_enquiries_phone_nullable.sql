-- The website's "Send Message" contact form collects name, email, service and
-- message — there is no phone field on it. enquiries.contact_phone was NOT NULL,
-- so an email-only enquiry could not be stored at all.
--
-- The API now requires name plus at least one of phone/email, so a row still
-- always has a way to reach the customer; it just may be an email address.
--
-- Idempotent: only alters while the column is still NOT NULL.
SET @is_not_null := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'enquiries'
     AND column_name  = 'contact_phone'
     AND IS_NULLABLE  = 'NO'
);
SET @sql := IF(@is_not_null > 0,
  'ALTER TABLE enquiries MODIFY contact_phone VARCHAR(50) NULL',
  'SELECT "enquiries.contact_phone already nullable" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
