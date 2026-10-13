-- Seed the OHIF viewer's OAuth client on any install that never ran
-- `0009_seed_ohif_viewer_client`.
--
-- WHY THIS EXISTS. `0009_seed_ohif_viewer_client` shares the version `0009`
-- with `0009_widen_importer_client_write_scopes` — see
-- `0015_repair_importer_client_write_scopes` for how the runner collapses the
-- two. An install that recorded `0009` without the OHIF seed has no
-- `ohif-viewer` row, `0010_ohif_viewer_client_fhir_viewer_redirect` then
-- updated nothing, and every viewer launch is refused at `/authorize` as an
-- unknown client.
--
-- The row is inserted in the END state `0009` + `0010` produce — the
-- app-relative `"/"` plus the FHIR Viewer mode route as its redirect URIs —
-- rather than `0009`'s original directory URL, because `0010` will never run
-- again to repoint it. The scope set and every other column are `0009`'s
-- verbatim; that migration's header explains each value and the
-- `apps/ohif-viewer/config/app-config.js` mirror the scopes MUST equal.
--
-- IDEMPOTENT. `INSERT ... WHERE NOT EXISTS` (the `0011` form) is a no-op on an
-- install that already has the row, whatever path wrote it, so an existing
-- client, and anything that references it, is never disturbed.
INSERT INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
SELECT
    'ohif-viewer',
    'Imaging',
    'public',
    '["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]',
    '["launch","openid","fhirUser","system/Patient.rs","system/ImagingStudy.rs","system/DocumentReference.rs"]',
    '["authorization_code","refresh_token"]',
    NULL,
    '2024-01-01 00:00:00+00:00',
    NULL
 WHERE NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'ohif-viewer');
