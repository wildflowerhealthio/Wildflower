-- Re-key FHIR Sync for Pebble's OAuth clients to random ids (`openssl rand
-- -hex 16`), as `0025`, `0028` and `0029` did for the other first-party apps.
-- Until now the production client's id was the app's (gatekeeper `0017`).
-- FHIR Sync has no homescreen tile, so there is no apps-side row to repoint.
-- The published path is unchanged, so the redirects stay:
--
--   fhir-sync-pebble     -> 6847df97d54c31936d54ca1b36b3bb09
--   fhir-sync-pebble-dev -> 61e195d6b08bab6bf2cedb1ef3831fa7
--
-- A debug build's dev client is upserted under its new id by
-- `seed_dev_app_clients` on the next boot.
--
-- Every table that names a client is re-keyed with it, so what was already
-- issued carries over. Nothing references `clients(client_id)` with a foreign
-- key, so each is a plain update.
UPDATE clients SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE authorization_requests SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE authorization_codes SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE authorization_code_grants SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE device_grants SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE refresh_token_families SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';
UPDATE launch_contexts SET client_id = '6847df97d54c31936d54ca1b36b3bb09' WHERE client_id = 'fhir-sync-pebble';

UPDATE clients SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE authorization_requests SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE authorization_codes SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE authorization_code_grants SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE device_grants SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE refresh_token_families SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
UPDATE launch_contexts SET client_id = '61e195d6b08bab6bf2cedb1ef3831fa7' WHERE client_id = 'fhir-sync-pebble-dev';
