-- Seed the Importer SMART app as a CLOUD row served from the deployed GitHub
-- Pages site. Schema comes from 0001_app_registrations; the baseline seed set
-- from 0002_seed_default_apps; the two original first-party apps from 0003/0004,
-- moved to cloud rows (and joined by the server-docs console) in
-- 0005_first_party_apps_to_cloud. A separate migration so the shipped set
-- versions on its own (a new app is a new migration, never an edit to an earlier
-- seed).
--
-- WHY CLOUD (see 0005's fuller note). The Importer is built and published by
-- `apps/github-pages` to <https://wildflowerhealth.io/importer-app/>, exactly as
-- Medications and Web Trace are. Serving the deployed copy means a shipped app
-- updates when the site deploys, not when the user installs a new desktop build,
-- so a bundled-and-synced self-hosted row is no longer the launch target. (The
-- vendored build under `slices/apps/self-hosted-apps/importer` stays: it is the
-- *source* the Pages assembly copies from, and the fallback content for the
-- debug-only `importer-app-dev` row — see `apps-rust/src/dev_seed.rs`.)
--
-- The id and the OAuth `client_id` are both the published path segment,
-- `importer-app`, matching the Medications/Web Trace convention 0005 established.
-- The two MUST stay equal: the host's self-hosted redirect resolver
-- (`apps/wildflower-tauri/src-tauri/src/self_hosted_redirect_resolver.rs`) looks
-- an app up by `client_id`, so an app-relative redirect entry only resolves when
-- `client_id == id`. The debug-only `importer-app-dev` row keeps that invariant
-- too. The gatekeeper half (the `clients` row + its absolute Pages redirect URI)
-- is gatekeeper migration `0008_seed_wildflower_importer_client`; the TS side is
-- `apps/importer-web/src/config.ts`.
--
-- UNLIKE Medications and Web Trace, this app **writes** — it persists a Patient,
-- its Observations, and the HAR archive they were replayed from, to the FHIR base
-- the SMART handshake named. `local_only = 0` (its assets are fetched from
-- wildflowerhealth.io, and it writes to whatever base the launch issued), same as
-- the other two cloud apps.
--
-- `requires_tunnel = 1`, as for every cloud app: it only decides how the cloud
-- launch resolves `{origin}` (see `resolve_origin` in
-- `http/routes/apps/launch.rs`). With it set the launch forces the tunnel up and
-- substitutes the tunnel's verified HTTPS origin, which the HTTPS Pages document's
-- `iss={origin}` FHIR fetch requires (a loopback `{origin}` is unreachable
-- remotely and refused by WebKit even on device — see 0005's WHY CLOUD note).
--
-- DEFENSIVE SQL, as in 0003/0004/0005: `INSERT OR REPLACE` + the `EXISTS` guard
-- on the cloud payload keep this idempotent and FK-safe, so an install where the
-- registration is somehow already present is a no-op rather than a failed
-- migration (a failed migration aborts `SqliteAppsStore::open`, and the whole
-- registry stops opening).
--
-- `position` is computed as the current tail (`MAX(position) + 1`), not a
-- hardcoded literal: `position` is UNIQUE and uploads allocate `MAX(position)+1`,
-- so a literal could collide on an install that uploaded an app before upgrading
-- into 0006. Appending at the tail is collision-free and keeps the seeded display
-- order stable on a fresh run.
INSERT OR REPLACE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, kind, local_only, requires_tunnel, position)
   VALUES ('importer-app',
           'importer-app',
           'Importer',
           'Import FHIR records from a captured browsing session',
           1,
           'cloud',
           0,
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations));

-- The cloud launch template: `launch.html` is the SMART EHR-launch endpoint
-- (`{launch}` + `iss` are read off the URL by fhirclient), the same shape the
-- Medications/Web Trace cloud rows carry — absolute against the published origin.
-- `INSERT OR REPLACE` + the `EXISTS` guard keep it idempotent and FK-safe: it
-- writes only when the registration it references is actually there and cloud.
INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'importer-app',
       'https://wildflowerhealth.io/importer-app/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'importer-app' AND kind = 'cloud');
