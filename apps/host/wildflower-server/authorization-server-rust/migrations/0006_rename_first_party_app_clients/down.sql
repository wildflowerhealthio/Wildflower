-- Reverse of up.sql: restore the original client ids and their single
-- app-relative redirect entry. The grants/codes/token families the up-migration
-- deleted are NOT restored (they were dropped, not moved) — a down-migrated
-- install re-consents on the next launch.
UPDATE clients
   SET client_id = 'wildflower-medication',
       redirect_uris = '["/"]'
 WHERE client_id = 'medications-app'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'wildflower-medication');

UPDATE clients
   SET client_id = 'wildflower-web-trace',
       redirect_uris = '["/"]'
 WHERE client_id = 'web-trace-app'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'wildflower-web-trace');
