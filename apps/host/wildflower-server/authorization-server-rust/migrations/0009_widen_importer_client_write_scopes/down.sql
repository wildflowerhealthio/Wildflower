-- Reverse of up.sql: restore the `importer-app` client's `allowed_scopes` to the
-- set `0008_seed_wildflower_importer_client` seeded (before `Practitioner` and
-- `DiagnosticReport` writes were added).
UPDATE clients
SET allowed_scopes = '["launch","openid","fhirUser","system/DocumentReference.rs","system/DocumentReference.u","system/Patient.u","system/Observation.u"]'
WHERE client_id = 'importer-app';
