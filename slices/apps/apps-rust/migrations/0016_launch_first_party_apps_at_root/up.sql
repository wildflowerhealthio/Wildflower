-- Launch every first-party SMART app at its root. The apps' `SmartAppRoot`
-- starts the SMART launch the root's URL carries (`iss` and `launch`) and is
-- the OAuth redirect target too, so the published sites no longer serve a
-- separate `launch.html`. A row still naming it reaches the app only by way of
-- GitHub Pages' 404 page and its redirect back to the root.
--
-- A row is rewritten only while its URL still equals the template its seed
-- wrote: `0009` (Medications, Web Trace), `0006` (Importer), `0010` (Lifting)
-- and `0015` (the Health Viewer). A row the user has edited since is theirs,
-- and is left alone. The new template keeps the old one's query and drops
-- `launch.html`, so the root is `<app>/`, with the slash, which GitHub Pages
-- serves as the directory's `index.html`.
--
-- The debug-only `…-dev` rows (`apps-rust`'s `dev_seed.rs`) moved the same
-- way, from `http://localhost:{port}/launch.html?…` to
-- `http://localhost:{port}/?…`. The dev seed only reconciles a row whose URL
-- equals the one it would write now, so a dev row seeded before this change
-- would otherwise be read as a user's app and keep the dead URL. They are
-- rewritten here, by id and only while they carry the old seed's shape; an
-- UPDATE creates nothing, so a release database, which holds no dev rows, is
-- untouched.

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/medications-app/?launch={launch}&iss={origin}/fhir-r4'
 WHERE id = 'medications-app'
   AND url = 'https://wildflowerhealth.io/medications-app/launch.html?launch={launch}&iss={origin}/fhir-r4';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/web-trace-app/?launch={launch}&iss={origin}/fhir-r4'
 WHERE id = 'web-trace-app'
   AND url = 'https://wildflowerhealth.io/web-trace-app/launch.html?launch={launch}&iss={origin}/fhir-r4';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/importer-app/?launch={launch}&iss={origin}/fhir-r4'
 WHERE id = 'importer-app'
   AND url = 'https://wildflowerhealth.io/importer-app/launch.html?launch={launch}&iss={origin}/fhir-r4';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/lifting-app/?launch={launch}&iss={origin}/fhir-r4'
 WHERE id = 'lifting-app'
   AND url = 'https://wildflowerhealth.io/lifting-app/launch.html?launch={launch}&iss={origin}/fhir-r4';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/health-viewer-app/?launch={launch}&iss={origin}/fhir-r4'
 WHERE id = 'health-viewer-app'
   AND url = 'https://wildflowerhealth.io/health-viewer-app/launch.html?launch={launch}&iss={origin}/fhir-r4';

-- `GLOB` is case-sensitive and its only wildcards are `*`, `?` and `[`, so
-- `[?]` matches the query's literal `?` and `*` the port.
UPDATE app_registrations
   SET url = replace(url, '/launch.html?', '/?')
 WHERE id IN ('medications-app-dev',
              'web-trace-app-dev',
              'web-server-docs-dev',
              'importer-app-dev',
              'health-viewer-app-dev',
              'synthetic-data-app-dev',
              'lifting-app-dev')
   AND url GLOB 'http://localhost:*/launch.html[?]launch={launch}&iss={origin}/fhir-r4';
