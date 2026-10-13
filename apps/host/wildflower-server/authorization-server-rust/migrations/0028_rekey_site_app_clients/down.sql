-- Restore the client ids and published paths the site's apps had before
-- `0028`, and remove the Synthetic Data Loader client it seeded (see up.sql).
-- A grant or token issued to that client after `0028` would outlive it, so
-- they go first, as in `0027_remove_web_trace_clients`.
DELETE FROM authorization_requests WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM authorization_codes WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM authorization_code_grants WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM device_grants WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM refresh_tokens
 WHERE family_id IN (SELECT family_id FROM refresh_token_families
                      WHERE client_id = '225ba6af034a3acec6be7ff8010df67f');
DELETE FROM refresh_token_families WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM launch_contexts WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';
DELETE FROM clients WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';

UPDATE clients
   SET client_id = 'medications-app',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/medications/"',
                               '"https://wildflowerhealth.io/medications-app/"')
 WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE authorization_requests SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE authorization_codes SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE authorization_code_grants SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE device_grants SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE refresh_token_families SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';
UPDATE launch_contexts SET client_id = 'medications-app' WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';

UPDATE clients SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE authorization_requests SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE authorization_codes SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE authorization_code_grants SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE device_grants SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE refresh_token_families SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';
UPDATE launch_contexts SET client_id = 'medications-app-dev' WHERE client_id = '4be2ee91360733fdcb99b43a3822de5f';

UPDATE clients
   SET client_id = 'importer-app',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/importer/"',
                               '"https://wildflowerhealth.io/importer-app/"')
 WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE authorization_requests SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE authorization_codes SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE authorization_code_grants SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE device_grants SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE refresh_token_families SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';
UPDATE launch_contexts SET client_id = 'importer-app' WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';

UPDATE clients SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE authorization_requests SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE authorization_codes SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE authorization_code_grants SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE device_grants SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE refresh_token_families SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';
UPDATE launch_contexts SET client_id = 'importer-app-dev' WHERE client_id = '57268ff88aea38d6a22de56ae53e2c28';

UPDATE clients
   SET client_id = 'health-viewer-app',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/health-viewer/"',
                               '"https://wildflowerhealth.io/health-viewer-app/"')
 WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE authorization_requests SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE authorization_codes SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE authorization_code_grants SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE device_grants SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE refresh_token_families SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';
UPDATE launch_contexts SET client_id = 'health-viewer-app' WHERE client_id = '474e103de61f9141c4b640d59bfa130e';

UPDATE clients SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE authorization_requests SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE authorization_codes SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE authorization_code_grants SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE device_grants SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE refresh_token_families SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';
UPDATE launch_contexts SET client_id = 'health-viewer-app-dev' WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';

UPDATE clients SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE authorization_requests SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE authorization_codes SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE authorization_code_grants SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE device_grants SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE refresh_token_families SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';
UPDATE launch_contexts SET client_id = 'synthetic-data-app-dev' WHERE client_id = '07a31e58db3367afda5c6480e03ed993';

UPDATE clients
   SET client_id = 'wildflower-server-docs',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/server-docs/"',
                               '"https://wildflowerhealth.io/wildflower-server-docs/"')
 WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE authorization_requests SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE authorization_codes SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE authorization_code_grants SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE device_grants SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE refresh_token_families SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
UPDATE launch_contexts SET client_id = 'wildflower-server-docs' WHERE client_id = '664a01e8614050cd82ffe90350b81413';
