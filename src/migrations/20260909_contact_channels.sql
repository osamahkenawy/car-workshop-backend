-- KPI matrix row 9: "Contact volume by channel, split by phone, email,
-- WhatsApp, mobile app, web portal, social media."
--
-- customer_activities.activity_type already covers phone (as call_in/call_out),
-- whatsapp and email, but has no value for the other three the row names.
-- Unlike the complaint rows (7/8/10/11), this one needs no decision from
-- anyone: the channel list is already fully specified in the KPI's own
-- definition, so there is nothing to wait on GM Pioneer for here.
--
-- Idempotent: only alters while the three values are absent.

SET @needs_widening := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name   = 'customer_activities'
     AND column_name  = 'activity_type'
     AND COLUMN_TYPE NOT LIKE '%mobile_app%'
);

SET @sql := IF(@needs_widening > 0,
  "ALTER TABLE customer_activities MODIFY activity_type ENUM(
     'call_in','call_out','whatsapp','email','visit','note','complaint','other',
     'mobile_app','web_portal','social_media'
   ) NOT NULL",
  'SELECT "customer_activities.activity_type already includes the contact channels" AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
