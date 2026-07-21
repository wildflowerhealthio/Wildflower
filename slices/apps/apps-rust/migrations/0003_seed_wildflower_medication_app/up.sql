-- Seed the Medications self-hosted SMART app. Schema comes from
-- 0001_app_registrations; the baseline seed set from 0002_seed_default_apps. A
-- separate migration so the shipped set versions on its own (a new app is a new
-- migration, never an edit to 0002).
--
-- Unlike patient-browser (client_id NULL, reads the open on-device FHIR
-- endpoint), this is a real SMART app: it carries a `client_id` (registered in
-- gatekeeper migration 0004_seed_wildflower_medication_client) so `is_smart`
-- is true, and a `launch_path` that starts the SMART EHR launch off its own
-- origin. Its build is vendored under
-- `slices/apps/self-hosted-apps/medication/` and synced into
-- app-data on startup (see self-hosted-apps README).
--
-- `local_only = 0`: the sponsor cards load remote logo images, so it is not a
-- no-egress app. Port 8090 sits above the upload-allocation floor
-- (`MIN_UPLOAD_PORT = 8082`) so shipping it does not consume the low upload
-- ports — uploaded apps still fill 8082+ lowest-first and simply skip 8090.
INSERT INTO app_registrations (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) VALUES
    ('wildflower-medication', 'self-hosted', 6, 1, 'Medications', 'View your medications and check on refills', 0, 'wildflower-medication', 0);

INSERT INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path) VALUES
    ('wildflower-medication', 8090, 'medication', 'medication', 1, '/launch.html?launch={launch}&iss={origin}/fhir-r4');
