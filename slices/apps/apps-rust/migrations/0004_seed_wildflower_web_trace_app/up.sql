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
-- `port` and `subdomain` are both UNIQUE, and both preferred values can already
-- be taken on an install that uploaded apps before upgrading into 0004 — the
-- same collision class the `position` note below covers, and a fatal one: a
-- failed migration aborts the run, so `SqliteAppsStore::open` errors and the
-- whole registry stops opening. Each therefore falls back to a dynamically
-- allocated value rather than aborting:
--
--   * `port` → `MAX(port) + 1`, which is free by construction (above every
--     allocated port) and keeps the "does not consume a low upload port"
--     property the literal was picked for. 8091 is taken once ten apps have been
--     uploaded (8082..8091, lowest-first). Deliberately not lowest-free like the
--     upload allocator: lowest-free exists to keep a delete → same-bundle-
--     reinstall cycle on its original origin, and a once-per-install seed has no
--     such cycle.
--   * `subdomain` → the app id, `wildflower-web-trace`, free by construction as
--     well: an *uploaded* app's subdomain is its slug, and its slug is also its
--     id, so a taken `wildflower-web-trace` subdomain implies an app of that id
--     — which the registration INSERT below would already have rejected on the
--     PK. The seeded rows are the only ones whose subdomain differs from their
--     id, and none of them uses this one. `web-trace` itself is taken by an
--     upload named "Web Trace" (slugify → `web-trace`).
--
-- Both fallbacks move the app's origin, not its identity: the id, the
-- `client_id`, and the gatekeeper client are unchanged, and the launch URL is
-- rendered from this row at read time.
--
-- Two collisions remain fatal, both beyond what a seed can allocate around: an
-- upload named "Wildflower Web Trace" already holds the id this row must have
-- (that id is what the gatekeeper client and the vendored bundle are keyed on),
-- and `MAX(port) + 1` past 65535 violates the port CHECK. Neither is reachable
-- on a plausible install.
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
    ('wildflower-web-trace',
     CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = 8091)
          THEN (SELECT MAX(port) + 1 FROM self_hosted_app_configurations)
          ELSE 8091 END,
     'web-trace',
     CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = 'web-trace')
          THEN 'wildflower-web-trace'
          ELSE 'web-trace' END,
     1, '/launch.html?launch={launch}&iss={origin}/fhir-r4');
