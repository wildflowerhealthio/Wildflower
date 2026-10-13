-- Re-key the launcher's OAuth client. The hosted launcher (the web build of
-- `apps/launcher/launcher-web`, `0012`'s `wildflower-react` client) is published
-- at <https://wildflowerhealth.io/launcher/>, so its redirect moves there, and
-- its client takes a random id (`openssl rand -hex 16`) rather than a name. The
-- host's loopback consent dialog names the app by the client's `name`, so that
-- becomes `Wildflower Launcher`.
--
-- Every table that names a client is re-keyed with it, as in
-- `0025_rekey_lifting_app_clients`. Nothing references `clients(client_id)`
-- with a foreign key, so each is a plain update.
UPDATE clients
   SET client_id = '03a513940b52f8c2649a5366d1a26d19',
       name = 'Wildflower Launcher',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/app/"',
                               '"https://wildflowerhealth.io/launcher/"')
 WHERE client_id = 'wildflower-react';
UPDATE authorization_requests SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
UPDATE authorization_codes SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
UPDATE authorization_code_grants SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
UPDATE device_grants SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
UPDATE refresh_token_families SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
UPDATE launch_contexts SET client_id = '03a513940b52f8c2649a5366d1a26d19' WHERE client_id = 'wildflower-react';
