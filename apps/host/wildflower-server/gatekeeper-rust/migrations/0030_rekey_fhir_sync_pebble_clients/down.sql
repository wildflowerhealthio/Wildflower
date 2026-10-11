-- Restore FHIR Sync for Pebble's client ids from before `0030` (see up.sql).
UPDATE clients SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE authorization_requests SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE authorization_codes SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE authorization_code_grants SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE device_grants SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE refresh_token_families SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';
UPDATE launch_contexts SET client_id = 'fhir-sync-pebble' WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';

UPDATE clients SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE authorization_requests SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE authorization_codes SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE authorization_code_grants SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE device_grants SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE refresh_token_families SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
UPDATE launch_contexts SET client_id = 'fhir-sync-pebble-dev' WHERE client_id = '61e195d6b08bab6bf2cedb1ef3831fa7';
