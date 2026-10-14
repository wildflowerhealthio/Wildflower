-- Restore the host app's client to `wildflower-host` (see up.sql).
UPDATE clients
   SET client_id = 'wildflower-host',
       name = 'Wildflower (host)'
 WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE authorization_requests SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE authorization_codes SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE authorization_code_grants SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE device_grants SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE refresh_token_families SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
UPDATE launch_contexts SET client_id = 'wildflower-host' WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';
