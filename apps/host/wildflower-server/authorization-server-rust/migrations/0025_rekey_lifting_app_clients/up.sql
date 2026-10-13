-- Re-key Lifting's OAuth clients to random ids (`openssl rand -hex 16`). The
-- app moved to `apps/lifting/` and is published at
-- <https://wildflowerhealth.io/lifting/>; its homescreen tile is now `lifting`
-- (apps migration `0017_rekey_lifting_app`, which points the tile at the new
-- client). A client id need not equal the tile id: nothing resolves an app by
-- its `client_id` since `0021` dropped the app-relative redirect entries.
--
-- The production client `lifting-app` becomes
-- `bdf9fc5cb5a28c6683b49896b0ef8a75`, and its published-site redirect moves to
-- the new path. A debug build's `lifting-app-dev` client becomes
-- `8467e680a05f1e92e22864e923144e5a`; `seed_dev_app_clients` upserts it on the
-- next boot.
--
-- Every table that names a client is re-keyed with it, so the grants, refresh
-- token families and launches already issued to Lifting carry over. Nothing
-- references `clients(client_id)` with a foreign key, so each is a plain update.
UPDATE clients
   SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/lifting-app/"',
                               '"https://wildflowerhealth.io/lifting/"')
 WHERE client_id = 'lifting-app';
UPDATE authorization_requests SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';
UPDATE authorization_codes SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';
UPDATE authorization_code_grants SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';
UPDATE device_grants SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';
UPDATE refresh_token_families SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';
UPDATE launch_contexts SET client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75' WHERE client_id = 'lifting-app';

UPDATE clients SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE authorization_requests SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE authorization_codes SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE authorization_code_grants SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE device_grants SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE refresh_token_families SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
UPDATE launch_contexts SET client_id = '8467e680a05f1e92e22864e923144e5a' WHERE client_id = 'lifting-app-dev';
