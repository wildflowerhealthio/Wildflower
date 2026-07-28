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
--
-- `port` and `subdomain` are both UNIQUE, and both preferred values can already
-- be taken on an install that uploaded apps before upgrading into 0003 — the
-- same collision class the `position` note below covers, and a fatal one: a
-- failed migration aborts the run, so `SqliteAppsStore::open` errors and the
-- whole registry stops opening. Each therefore falls back to a dynamically
-- allocated value rather than aborting:
--
--   * `port` → `MAX(port) + 1`, free by construction (above every allocated
--     port) and still above the upload floor, so it keeps the property the
--     literal was picked for. 8090 is taken once nine apps have been uploaded
--     (8082..8090, lowest-first). Deliberately not lowest-free like the upload
--     allocator: lowest-free exists to keep a delete → same-bundle-reinstall
--     cycle on its original origin, and a once-per-install seed has no such
--     cycle.
--   * `subdomain` → the app id, `wildflower-medication`, free by construction as
--     well: an *uploaded* app's subdomain is its slug, and its slug is also its
--     id, so a taken `wildflower-medication` subdomain implies an app of that id
--     — which the registration INSERT below would already have rejected on the
--     PK. The seeded rows are the only ones whose subdomain differs from their
--     id, and none of them uses this one. `medication` itself is taken by an
--     upload named "Medication" (slugify → `medication`).
--
-- Both fallbacks move the app's origin, not its identity: the id, the
-- `client_id`, and the gatekeeper client are unchanged, and the launch URL is
-- rendered from this row at read time. Note the runner tracks applied
-- migrations by version, not by checksum, so this only protects an install that
-- upgrades into 0003 from here on — one that already ran the literal form keeps
-- whatever it seeded.
--
-- `position` is computed as the current tail (MAX+1), not a hardcoded 6:
-- `position` is UNIQUE and uploads allocate `MAX(position)+1`, so on an install
-- that ran 0002 and then uploaded a self-hosted app before upgrading into 0003,
-- position 6 is already taken — a literal `6` here would abort the migration on
-- the UNIQUE constraint. On a fresh 0001..0003 run MAX+1 is still 6, so the
-- seeded display order is unchanged; on a collision it simply appends at the tail.
INSERT INTO app_registrations (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) VALUES
    ('wildflower-medication', 'self-hosted', (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations), 1, 'Medications', 'View your medications and check on refills', 0, 'wildflower-medication', 0);

INSERT INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path) VALUES
    ('wildflower-medication',
     CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = 8090)
          THEN (SELECT MAX(port) + 1 FROM self_hosted_app_configurations)
          ELSE 8090 END,
     'medication',
     CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = 'medication')
          THEN 'wildflower-medication'
          ELSE 'medication' END,
     1, '/launch.html?launch={launch}&iss={origin}/fhir-r4');
