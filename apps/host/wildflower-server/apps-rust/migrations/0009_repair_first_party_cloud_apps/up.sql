-- Bring the Medications and Web Trace registrations to their intended end state
-- on any install, however they got here. The apps-side counterpart to gatekeeper
-- migration `0011_repair_first_party_app_clients`; the two halves must both hold
-- for a launch to complete, so they are repaired together.
--
-- WHY THIS EXISTS. `0005_first_party_apps_to_cloud` moves both apps to cloud
-- rows and renames them (`wildflower-medication` -> `medications-app`,
-- `wildflower-web-trace` -> `web-trace-app`) with defensive SQL: `UPDATE ...
-- WHERE id = '<old>' AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id =
-- '<new>')`. That defensiveness is deliberate — a failed migration aborts
-- `SqliteAppsStore::open` and the whole registry stops opening — but it means an
-- install whose rows were not in the exact expected shape gets a silent no-op.
-- The `cloud_app_configurations` insert below it is then gated on `EXISTS (...
-- AND kind = 'cloud')`, so it skips too, and the app has **no launch URL at
-- all**.
--
-- Contrast `0006_seed_wildflower_importer_app`, which seeds `importer-app` and
-- its cloud payload unconditionally and is therefore correct on every install —
-- which is why the Importer launches where Medications does not.
--
-- The launch templates are byte-identical to the ones 0005 intends, trailing
-- `launch.html` with **no** trailing slash before the query: GitHub Pages serves
-- no file for `launch.html/`, so a slash there falls through to
-- `apps/github-pages/404.html`, which redirects to the app root and drops the
-- launch entirely.
--
-- Every statement is individually guarded and a no-op on an install that is
-- already correct, so this migration is idempotent and safe on a healthy
-- database. `position` is never rewritten (it is UNIQUE, and a healthy row's
-- ordering is the user's), and new rows take the tail.

-- === Medications ===

-- 1. The intended path, retried.
UPDATE app_registrations
   SET id = 'medications-app',
       client_id = 'medications-app',
       kind = 'cloud',
       requires_tunnel = 1
 WHERE id = 'wildflower-medication'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'medications-app');

-- 2. Neither id present: create the registration at the tail.
INSERT INTO app_registrations
    (id, client_id, name, subtitle, on_homescreen, kind, local_only, requires_tunnel, position)
SELECT 'medications-app',
       'medications-app',
       'Medications',
       'Review your prescriptions, interactions and savings programs.',
       1,
       'cloud',
       0,
       1,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations)
 WHERE NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'medications-app');

-- 3. The registration exists but is not a launchable cloud row (0005's UPDATE
--    skipped while something else created it): correct the launch-relevant
--    columns only.
UPDATE app_registrations
   SET client_id = 'medications-app',
       kind = 'cloud',
       requires_tunnel = 1
 WHERE id = 'medications-app'
   AND (kind <> 'cloud' OR requires_tunnel <> 1 OR client_id IS NOT 'medications-app');

-- 4. The cloud payload, now that the registration is guaranteed to be there.
INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'medications-app',
       'https://wildflowerhealth.io/medications-app/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'medications-app' AND kind = 'cloud');

-- === Web Trace ===
-- The same four steps; renamed by the same migration, same latent gap.

UPDATE app_registrations
   SET id = 'web-trace-app',
       client_id = 'web-trace-app',
       kind = 'cloud',
       local_only = 0,
       requires_tunnel = 1
 WHERE id = 'wildflower-web-trace'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-trace-app');

INSERT INTO app_registrations
    (id, client_id, name, subtitle, on_homescreen, kind, local_only, requires_tunnel, position)
SELECT 'web-trace-app',
       'web-trace-app',
       'Web Trace',
       'Review the records captured from a browsing session.',
       1,
       'cloud',
       0,
       1,
       (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations)
 WHERE NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-trace-app');

UPDATE app_registrations
   SET client_id = 'web-trace-app',
       kind = 'cloud',
       local_only = 0,
       requires_tunnel = 1
 WHERE id = 'web-trace-app'
   AND (kind <> 'cloud' OR requires_tunnel <> 1 OR client_id IS NOT 'web-trace-app');

INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'web-trace-app',
       'https://wildflowerhealth.io/web-trace-app/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-trace-app' AND kind = 'cloud');
