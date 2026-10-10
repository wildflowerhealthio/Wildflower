-- Re-key Lifting to its folder's name. The app moved to `apps/lifting/` and is
-- published at <https://wildflowerhealth.io/lifting/>, so its tile id is
-- `lifting` (was `lifting-app`) and a debug build's dev tile `lifting-dev` (was
-- `lifting-app-dev`). Its OAuth clients get random ids (`openssl rand -hex 16`)
-- rather than the tile id: a registration's `client_id` is a soft reference to
-- gatekeeper's `clients`, whose matching re-key is gatekeeper migration
-- `0025_rekey_lifting_app_clients`.
--
-- In place, so a user's placement (`position`, `on_homescreen`) is kept. Nothing
-- references `app_registrations(id)` since `0012` collapsed the configuration
-- tables into it.
--
-- The launch URL moves only when it is still the published one: a URL the user
-- edited stays as they left it, as in `0016`. The dev row's URL names a loopback
-- port, not the published path, so it stays and the dev seed
-- (`apps-rust/src/dev_seed.rs`) recognizes the row as its own under the new id.
UPDATE app_registrations
   SET id = 'lifting',
       client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75',
       url = replace(url,
                     'https://wildflowerhealth.io/lifting-app/',
                     'https://wildflowerhealth.io/lifting/')
 WHERE id = 'lifting-app';

UPDATE app_registrations
   SET id = 'lifting-dev',
       client_id = '8467e680a05f1e92e22864e923144e5a'
 WHERE id = 'lifting-app-dev';
