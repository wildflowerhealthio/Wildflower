-- Restore Lifting's `0019` client ids and published path (see up.sql).
UPDATE clients
   SET client_id = 'lifting-app',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/lifting/"',
                               '"https://wildflowerhealth.io/lifting-app/"')
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE authorization_requests SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE authorization_codes SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE authorization_code_grants SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE device_grants SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE refresh_token_families SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';
UPDATE launch_contexts SET client_id = 'lifting-app' WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE authorization_requests SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE authorization_codes SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE authorization_code_grants SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE device_grants SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE refresh_token_families SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
UPDATE launch_contexts SET client_id = 'lifting-app-dev' WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
