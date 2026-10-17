-- Restore Strength's clients' `0035` names where the client still holds the
-- one `up.sql` wrote (see up.sql).
UPDATE clients
   SET name = CASE name WHEN 'Wildflower Strength' THEN 'Strength' ELSE name END
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET name = CASE name WHEN 'Wildflower Strength (Dev)' THEN 'Strength (Dev)' ELSE name END
 WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
