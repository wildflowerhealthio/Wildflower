-- Repoint the OHIF viewer's cloud launch template at the FHIR Viewer mode route
-- and add the `clientId` parameter, replacing the viewer-root template
-- `0007_seed_ohif_viewer_app` shipped. Its gatekeeper half is
-- `0010_ohif_viewer_client_fhir_viewer_redirect` (see that file for why the two
-- move together).
--
-- WHY. OHIF reads `iss`, `launch`, and `clientId` off the URL of whichever route
-- it is opened on. Launching at the root landed on the worklist, which then had
-- to navigate client-side into the mode; `/fhir-viewer` is the route that
-- actually consumes the launch context, reachable through the SPA 404 redirect
-- restoration `apps/ohif-viewer/README.md` describes. `clientId=ohif-viewer`
-- names the OAuth client rather than leaning on a built-in default. `iss` is
-- unchanged.
--
-- A NEW migration rather than an edit to `0007`, because migrations are run-once
-- and never re-applied: an install that already ran `0007` would never see a
-- changed `0007` and would keep launching at the root with no `clientId`. An
-- `UPDATE` rather than `INSERT OR REPLACE`, which would also recreate a row a
-- `down`-migrated install deliberately removed. The `app_registrations` row is
-- unchanged — same id, kind, and hosting flags.
UPDATE cloud_app_configurations
SET url = 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer'
WHERE id = 'ohif-viewer';
