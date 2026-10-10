-- Reverse of up.sql: restore the `ohif-viewer` cloud launch template to the
-- viewer-root form `0007_seed_ohif_viewer_app` seeded (no `clientId`).
UPDATE cloud_app_configurations
SET url = 'https://wildflowerhealth.io/ohif-viewer/?launch={launch}&iss={origin}/fhir-r4'
WHERE id = 'ohif-viewer';
