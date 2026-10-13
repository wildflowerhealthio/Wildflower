-- Reverse of up.sql: restore the `ohif-viewer` client's `redirect_uris` to the
-- pair `0009_seed_ohif_viewer_client` seeded, whose absolute entry is the
-- published directory URL rather than the FHIR Viewer mode route.
UPDATE clients
SET redirect_uris = '["/","https://wildflowerhealth.io/ohif-viewer/"]'
WHERE client_id = 'ohif-viewer';
