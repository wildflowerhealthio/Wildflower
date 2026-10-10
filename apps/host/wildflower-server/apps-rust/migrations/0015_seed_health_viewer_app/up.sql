-- Seed the Synthesized Health Viewer SMART app, served from the deployed
-- GitHub Pages site. Schema comes from 0001_app_registrations as collapsed by
-- 0012_collapse_app_registrations (one `app_registrations` table, the launch
-- template inline as `url`) and 0013_drop_app_local_only. A separate migration
-- so the shipped set versions on its own (a new app is a new migration, never
-- an edit to an earlier seed).
--
-- The Health Viewer is built and published by `apps/github-pages` to
-- <https://wildflowerhealth.io/health-viewer-app/>, as the other first-party
-- SMART apps are, so a shipped app updates when the site deploys rather than
-- when the user installs a new desktop build. The debug-only
-- `health-viewer-app-dev` row (`apps-rust/src/dev_seed.rs`) points at the local
-- vite dev server instead.
--
-- The id and the OAuth `client_id` are both the published path segment,
-- `health-viewer-app`, matching the convention 0005 established. The gatekeeper
-- half (the `clients` row + its absolute Pages redirect URI) is gatekeeper
-- migration `0022_seed_health_viewer_app_client`; the TS side is
-- `apps/health-viewer/src/config.ts`. The app only reads (Patients,
-- Observations and MedicationRequests) from the FHIR base the SMART handshake
-- named.
--
-- `url` is the SMART EHR-launch endpoint, `launch.html` (`{launch}` + `iss` are
-- read off the URL by fhirclient) — absolute against the published origin, with
-- no slash between `launch.html` and the query (GitHub Pages serves no file for
-- `launch.html/`; see 0009's note).
--
-- `requires_tunnel = 1`, as for every published app: it decides how the launch
-- resolves `{origin}` (see `resolve_origin` in `http/routes/apps/launch.rs`).
-- With it set the launch forces the tunnel up and substitutes the tunnel's
-- verified HTTPS origin, which the HTTPS Pages document's `iss={origin}` FHIR
-- fetch requires (a loopback `{origin}` is unreachable remotely and refused by
-- WebKit even on device — see 0005's WHY CLOUD note).
--
-- `INSERT OR REPLACE` keeps this idempotent, so an install where the
-- registration is somehow already present is a no-op rather than a failed
-- migration (a failed migration aborts `SqliteAppsStore::open`, and the whole
-- registry stops opening).
--
-- `position` is computed as the current tail (`MAX(position) + 1`), not a
-- hardcoded literal: `position` is UNIQUE and uploads allocate `MAX(position)+1`,
-- so a literal could collide on an install that uploaded an app before upgrading
-- into 0015. Appending at the tail is collision-free and keeps the seeded display
-- order stable on a fresh run.
INSERT OR REPLACE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, requires_tunnel, position, url)
   VALUES ('health-viewer-app',
           'health-viewer-app',
           'Synthesized Health Viewer',
           'Plot labs, vitals and doses on one chart',
           1,
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations),
           'https://wildflowerhealth.io/health-viewer-app/launch.html?launch={launch}&iss={origin}/fhir-r4');
