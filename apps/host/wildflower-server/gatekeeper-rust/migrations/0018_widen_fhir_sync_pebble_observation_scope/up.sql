-- Widen the `fhir-sync-pebble` client's Observation scope from `.c` to `.cu`.
--
-- The watch syncs through one transaction Bundle whose entries PUT each
-- Observation under an id the watch's records determine (see
-- `apps/fhir-sync-pebble/AGENTS.md`), so a re-sent sync overwrites rather than
-- duplicates. A PUT is an update, and the FHIR server refuses it under
-- `system/Observation.c` alone ("Insufficient scope for update on
-- Observation"). `.c` stays for the create half of the upsert.
--
-- The array MUST equal the `scope` string in
-- `apps/fhir-sync-pebble-web/src/config.ts`; the mirrors are listed in
-- `0017_seed_fhir_sync_pebble_client`'s header.
--
-- IDEMPOTENT. The `UPDATE` only fires while the row still holds the exact set
-- `0017` seeded, so a row whose scopes were deliberately changed since is left
-- alone.
UPDATE clients
   SET allowed_scopes = '["openid","fhirUser","system/Patient.rs","system/Observation.cu"]'
 WHERE client_id = 'fhir-sync-pebble'
   AND allowed_scopes = '["openid","fhirUser","system/Patient.rs","system/Observation.c"]';
