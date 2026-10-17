-- Restore the Strength tiles' `0023` names where the row still holds the one
-- `up.sql` wrote (see up.sql).
UPDATE app_registrations
   SET name = CASE name WHEN 'Wildflower Strength' THEN 'Strength' ELSE name END
 WHERE id = 'strength';

UPDATE app_registrations
   SET name = CASE name WHEN 'Wildflower Strength (Dev)' THEN 'Strength (Dev)' ELSE name END
 WHERE id = 'strength-dev';
