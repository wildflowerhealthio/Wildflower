-- Re-key the site's first-party apps to their folders' names, as `0017` did for
-- Lifting. Each app moved into a product folder (`apps/medications/`,
-- `apps/importer/`, `apps/health-viewer/`, `apps/synthetic-data/`,
-- `apps/server-docs-web`) and is published under that name, so its tile id is
-- the product (`medications`, was `medications-app`) and a debug build's dev
-- tile `<product>-dev` (was `medications-app-dev`). Their OAuth clients get
-- random ids (`openssl rand -hex 16`) rather than the tile id: a registration's
-- `client_id` is a soft reference to gatekeeper's `clients`, whose matching
-- re-key is gatekeeper migration `0028_rekey_site_app_clients`.
--
-- The server-docs tile's `client_id` was `web-server-docs`, which named no
-- gatekeeper client (the console signs in as `wildflower-server-docs`); it now
-- names the console's re-keyed client.
--
-- In place, so a user's placement (`position`, `on_homescreen`) is kept, and the
-- launch URL moves only when it is still the published one, as in `0017`. The
-- dev rows' URLs name a loopback port, so they stay, and the dev seed
-- (`apps-rust/src/dev_seed.rs`) recognizes each row as its own under the new id.
UPDATE app_registrations
   SET id = 'medications',
       client_id = '9769f8b274370708d0d3ebb2e3e59b7c',
       url = replace(url,
                     'https://wildflowerhealth.io/medications-app/',
                     'https://wildflowerhealth.io/medications/')
 WHERE id = 'medications-app';

UPDATE app_registrations
   SET id = 'medications-dev',
       client_id = '4be2ee91360733fdcb99b43a3822de5f'
 WHERE id = 'medications-app-dev';

UPDATE app_registrations
   SET id = 'importer',
       client_id = '165cd26573e5ac72378e6ad2d2198330',
       url = replace(url,
                     'https://wildflowerhealth.io/importer-app/',
                     'https://wildflowerhealth.io/importer/')
 WHERE id = 'importer-app';

UPDATE app_registrations
   SET id = 'importer-dev',
       client_id = '57268ff88aea38d6a22de56ae53e2c28'
 WHERE id = 'importer-app-dev';

UPDATE app_registrations
   SET id = 'health-viewer',
       client_id = '474e103de61f9141c4b640d59bfa130e',
       url = replace(url,
                     'https://wildflowerhealth.io/health-viewer-app/',
                     'https://wildflowerhealth.io/health-viewer/')
 WHERE id = 'health-viewer-app';

UPDATE app_registrations
   SET id = 'health-viewer-dev',
       client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa'
 WHERE id = 'health-viewer-app-dev';

UPDATE app_registrations
   SET id = 'synthetic-data-dev',
       client_id = '07a31e58db3367afda5c6480e03ed993'
 WHERE id = 'synthetic-data-app-dev';

UPDATE app_registrations
   SET id = 'server-docs',
       client_id = '664a01e8614050cd82ffe90350b81413',
       url = replace(url,
                     'https://wildflowerhealth.io/wildflower-server-docs/',
                     'https://wildflowerhealth.io/server-docs/')
 WHERE id = 'web-server-docs';

UPDATE app_registrations
   SET id = 'server-docs-dev',
       client_id = '022dcbd37461a19669e24caf6345e8bb'
 WHERE id = 'web-server-docs-dev';

-- Seed the Synthetic Data Loader, which until now shipped only as a debug
-- build's dev tile: published at <https://wildflowerhealth.io/synthetic-data/>,
-- launched at its root like every first-party SMART app since `0016`, and
-- `requires_tunnel = 1` for the reason `0015` gives. Its client is seeded by the
-- same gatekeeper migration. `INSERT OR IGNORE` and a tail `position`, as in
-- `0015`, so an install that already holds the id or uploaded an app keeps both.
INSERT OR IGNORE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, requires_tunnel, position, url)
   VALUES ('synthetic-data',
           '225ba6af034a3acec6be7ff8010df67f',
           'Synthetic Data Loader',
           'Load fictional patients into a demo or test server',
           1,
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations),
           'https://wildflowerhealth.io/synthetic-data/?launch={launch}&iss={origin}/fhir-r4');
