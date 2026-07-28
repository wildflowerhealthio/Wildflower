-- Seed the Web Trace self-hosted SMART app — the on-device viewer for recorded
-- browsing sessions. Schema comes from 0001_app_registrations; the baseline seed
-- set from 0002_seed_default_apps; the Medications app from 0003. A separate
-- migration so the shipped set versions on its own (a new app is a new
-- migration, never an edit to an earlier seed).
--
-- Like wildflower-medication and unlike patient-browser (client_id NULL, reads
-- the open on-device FHIR endpoint), this is a real SMART app: it carries a
-- `client_id` (registered in gatekeeper migration
-- 0005_seed_wildflower_web_trace_client) so `is_smart` is true, and a
-- `launch_path` that starts the SMART EHR launch off its own origin. Its build
-- is vendored under `slices/apps/self-hosted-apps/web-trace/` and synced into
-- app-data on startup (see self-hosted-apps README).
--
-- `local_only = 1`: the viewer ships every asset in its own bundle and makes no
-- outbound requests — the recordings it reads come from the on-device FHIR
-- endpoint. Note this column is currently a **badge**, not enforcement: it drives
-- the catalogue's "runs entirely on this device" presentation, and nothing in the
-- host blocks egress from an app whose row claims it.
--
-- Port 8091 sits above the upload-allocation floor (`MIN_UPLOAD_PORT = 8082`),
-- one past the Medications app at 8090, so shipping it does not consume the low
-- upload ports — uploaded apps still fill 8082+ lowest-first and simply skip the
-- seeded 8081/8090/8091.
--
-- `position` is computed as the current tail (MAX+1), not a hardcoded 7:
-- `position` is UNIQUE and uploads allocate `MAX(position)+1`, so on an install
-- that ran 0003 and then uploaded a self-hosted app before upgrading into 0004,
-- position 7 is already taken — a literal `7` here would abort the migration on
-- the UNIQUE constraint. On a fresh 0001..0004 run MAX+1 is still 7, so the
-- seeded display order is unchanged; on a collision it simply appends at the tail.
INSERT INTO app_registrations (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) VALUES
    ('wildflower-web-trace', 'self-hosted', (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), 1, 'Web Trace', 'Review and export recorded browsing sessions', 1, 'wildflower-web-trace', 0);

INSERT INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path) VALUES
    ('wildflower-web-trace', 8091, 'web-trace', 'web-trace', 1, '/launch.html?launch={launch}&iss={origin}/fhir-r4');
