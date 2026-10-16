-- Reverse of up.sql: restore the column's and the client's names. The Owner
-- sessions up.sql revoked stay revoked; the Owner signs in again either way.
ALTER TABLE authorization_requests
    RENAME COLUMN decidable_in_requesting_browser TO requested_by_owner_browser;

UPDATE clients
   SET client_id = 'wildflower-owner-browser',
       name = 'Wildflower (Owner browsers)'
 WHERE client_id = 'wildflower-browser';
UPDATE authorization_requests SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
UPDATE authorization_codes SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
UPDATE authorization_code_grants SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
UPDATE device_grants SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
UPDATE refresh_token_families SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
UPDATE launch_contexts SET client_id = 'wildflower-owner-browser' WHERE client_id = 'wildflower-browser';
