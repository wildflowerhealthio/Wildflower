-- Re-key the OHIF viewer's OAuth clients to random ids (`openssl rand -hex
-- 16`), as `0025` and `0028` did for the other first-party apps. Until now
-- each client's id was its tile's (apps migration `0007`, gatekeeper `0009`);
-- the tiles keep their ids and point at the new clients (apps migration
-- `0020_rekey_ohif_viewer_clients`). The published path is unchanged, so the
-- redirects stay:
--
--   ohif-viewer     -> 941de68e6b59eb9dcc32df8ede89e636
--   ohif-viewer-dev -> f9866f7b1d0d8505dc65ef4f749664b5
--
-- A debug build's dev client is upserted under its new id by
-- `seed_dev_app_clients` on the next boot.
--
-- Every table that names a client is re-keyed with it, so what was already
-- issued carries over. Nothing references `clients(client_id)` with a foreign
-- key, so each is a plain update.
UPDATE clients SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE authorization_requests SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE authorization_codes SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE authorization_code_grants SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE device_grants SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE refresh_token_families SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';
UPDATE launch_contexts SET client_id = '941de68e6b59eb9dcc32df8ede89e636' WHERE client_id = 'ohif-viewer';

UPDATE clients SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE authorization_requests SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE authorization_codes SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE authorization_code_grants SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE device_grants SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE refresh_token_families SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
UPDATE launch_contexts SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5' WHERE client_id = 'ohif-viewer-dev';
