-- Repoint the OHIF viewer client's absolute redirect URI at the FHIR Viewer mode
-- route, replacing the published directory URL `0009_seed_ohif_viewer_client`
-- shipped. Its apps-side half is `0008_ohif_viewer_fhir_viewer_launch`, which
-- moves the launch onto the same route; the two MUST move together, because OHIF
-- derives its `redirect_uri` from the page it was launched on and `/authorize`
-- matches that by exact URL equality.
--
-- A NEW migration rather than an edit to `0009`, because migrations are run-once
-- and never re-applied: an install that already ran `0009` would never see a
-- changed `0009` and would keep failing at `/authorize`. And an `UPDATE` rather
-- than an `INSERT`, because `0009`'s `INSERT OR IGNORE` would no-op against the
-- row it already wrote.
--
-- The app-relative `"/"` entry is kept unchanged, and `allowed_scopes` is
-- untouched — the viewer requests the same set from either route.
UPDATE clients
SET redirect_uris = '["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]'
WHERE client_id = 'ohif-viewer';
