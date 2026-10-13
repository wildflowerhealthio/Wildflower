-- Re-key the site's first-party OAuth clients to random ids (`openssl rand -hex
-- 16`), as `0025_rekey_lifting_app_clients` did for Lifting. Each app moved
-- into a product folder and is published under that name; its homescreen tile
-- takes the name (apps migration `0019_rekey_site_apps`, which points each tile
-- at its new client), so each production client's published-site redirect
-- moves to the new path:
--
--   medications-app        -> 9769f8b274370708d0d3ebb2e3e59b7c  /medications/
--   importer-app           -> 165cd26573e5ac72378e6ad2d2198330  /importer/
--   health-viewer-app      -> 474e103de61f9141c4b640d59bfa130e  /health-viewer/
--   wildflower-server-docs -> 664a01e8614050cd82ffe90350b81413  /server-docs/
--
-- A debug build's dev clients take random ids too, and `seed_dev_app_clients`
-- upserts each on the next boot:
--
--   medications-app-dev    -> 4be2ee91360733fdcb99b43a3822de5f
--   importer-app-dev       -> 57268ff88aea38d6a22de56ae53e2c28
--   health-viewer-app-dev  -> e7efc7c805f5f8f640bb3b3d48a2d7aa
--   synthetic-data-app-dev -> 07a31e58db3367afda5c6480e03ed993
--
-- Every table that names a client is re-keyed with it, so what was already
-- issued carries over. Nothing references `clients(client_id)` with a foreign
-- key, so each is a plain update.
UPDATE clients
   SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/medications-app/"',
                               '"https://wildflowerhealth.io/medications/"')
 WHERE client_id = 'medications-app';
UPDATE authorization_requests SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';
UPDATE authorization_codes SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';
UPDATE authorization_code_grants SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';
UPDATE device_grants SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';
UPDATE refresh_token_families SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';
UPDATE launch_contexts SET client_id = '9769f8b274370708d0d3ebb2e3e59b7c' WHERE client_id = 'medications-app';

UPDATE clients SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE authorization_requests SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE authorization_codes SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE authorization_code_grants SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE device_grants SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE refresh_token_families SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';
UPDATE launch_contexts SET client_id = '4be2ee91360733fdcb99b43a3822de5f' WHERE client_id = 'medications-app-dev';

UPDATE clients
   SET client_id = '165cd26573e5ac72378e6ad2d2198330',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/importer-app/"',
                               '"https://wildflowerhealth.io/importer/"')
 WHERE client_id = 'importer-app';
UPDATE authorization_requests SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';
UPDATE authorization_codes SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';
UPDATE authorization_code_grants SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';
UPDATE device_grants SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';
UPDATE refresh_token_families SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';
UPDATE launch_contexts SET client_id = '165cd26573e5ac72378e6ad2d2198330' WHERE client_id = 'importer-app';

UPDATE clients SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE authorization_requests SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE authorization_codes SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE authorization_code_grants SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE device_grants SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE refresh_token_families SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';
UPDATE launch_contexts SET client_id = '57268ff88aea38d6a22de56ae53e2c28' WHERE client_id = 'importer-app-dev';

UPDATE clients
   SET client_id = '474e103de61f9141c4b640d59bfa130e',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/health-viewer-app/"',
                               '"https://wildflowerhealth.io/health-viewer/"')
 WHERE client_id = 'health-viewer-app';
UPDATE authorization_requests SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';
UPDATE authorization_codes SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';
UPDATE authorization_code_grants SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';
UPDATE device_grants SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';
UPDATE refresh_token_families SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';
UPDATE launch_contexts SET client_id = '474e103de61f9141c4b640d59bfa130e' WHERE client_id = 'health-viewer-app';

UPDATE clients SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE authorization_requests SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE authorization_codes SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE authorization_code_grants SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE device_grants SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE refresh_token_families SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';
UPDATE launch_contexts SET client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa' WHERE client_id = 'health-viewer-app-dev';

UPDATE clients SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE authorization_requests SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE authorization_codes SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE authorization_code_grants SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE device_grants SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE refresh_token_families SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';
UPDATE launch_contexts SET client_id = '07a31e58db3367afda5c6480e03ed993' WHERE client_id = 'synthetic-data-app-dev';

UPDATE clients
   SET client_id = '664a01e8614050cd82ffe90350b81413',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/wildflower-server-docs/"',
                               '"https://wildflowerhealth.io/server-docs/"')
 WHERE client_id = 'wildflower-server-docs';
UPDATE authorization_requests SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';
UPDATE authorization_codes SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';
UPDATE authorization_code_grants SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';
UPDATE device_grants SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';
UPDATE refresh_token_families SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';
UPDATE launch_contexts SET client_id = '664a01e8614050cd82ffe90350b81413' WHERE client_id = 'wildflower-server-docs';

-- Seed the Synthetic Data Loader's production client, the gatekeeper half of
-- the tile `0019_rekey_site_apps` seeds. Until now only a debug build's dev
-- client existed, so the published loader could not authorize against a host.
-- A public PKCE client with the same column formats as
-- `0022_seed_health_viewer_app_client`, its one redirect the published root.
--
-- `allowed_scopes` MUST equal the `SYNTHETIC_DATA_SCOPE` string in
-- `apps/synthetic-data/synthetic-data-web/src/config.ts`, element for element:
-- `seeding.rs`'s `seeds_the_synthetic_data_dev_client_with_the_apps_own_scopes`
-- pins this client, the dev client and that string together. `INSERT OR
-- IGNORE`, as in `0022`.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        '225ba6af034a3acec6be7ff8010df67f',
        'Synthetic Data Loader',
        'public',
        '["https://wildflowerhealth.io/synthetic-data/"]',
        '["launch","openid","fhirUser","system/Patient.cu","system/Practitioner.cu","system/DocumentReference.cu","system/Observation.cu","system/DiagnosticReport.cu","system/Medication.cu","system/MedicationRequest.cu","system/MedicationDispense.cu","system/ServiceRequest.cu","system/ImagingStudy.cu"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
