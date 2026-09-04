-- One-off fix: switch all migration-imported customers from Dubai to Abu Dhabi.
-- Safe to re-run; touches only rows tagged src='oracle' (skips manually created ones).

UPDATE customers
   SET city    = 'Abu Dhabi',
       emirate = 'Abu Dhabi'
 WHERE JSON_VALID(notes) = 1
   AND JSON_EXTRACT(notes, '$.src') = 'oracle'
   AND (city IN ('Dubai', '', NULL) OR emirate IN ('Dubai', '', NULL));

-- How many rows are now labelled Abu Dhabi?
SELECT COUNT(*) AS abu_dhabi_customers
  FROM customers
 WHERE JSON_VALID(notes) = 1
   AND JSON_EXTRACT(notes, '$.src') = 'oracle'
   AND city = 'Abu Dhabi';
