-- Seed the OHIF imaging viewer as a CLOUD row served from the deployed GitHub
-- Pages site. Schema comes from 0001_app_registrations; the baseline seed set
-- from 0002_seed_default_apps; the earlier first-party apps from 0003/0004,
-- moved to cloud rows (and joined by the server-docs console) in
-- 0005_first_party_apps_to_cloud, and the Importer from 0006. A separate
-- migration so the shipped set versions on its own (a new app is a new
-- migration, never an edit to an earlier seed).
--
-- WHY CLOUD (see 0005's fuller note). The viewer is published by
-- `apps/github-pages` to <https://wildflowerhealth.io/ohif-viewer/>: a prebuilt
-- OHIF Viewer with the FHIR Viewer mode, pinned from a release of
-- `wildflowerhealthio/ohif-viewer-dist` (see `apps/ohif-viewer/README.md`).
-- Serving the deployed copy means the viewer updates when the site deploys, not
-- when the user installs a new desktop build. Unlike the other first-party apps
-- nothing is vendored under `slices/apps/self-hosted-apps/` for it: the
-- debug-only `ohif-viewer-dev` row (`apps-rust/src/dev_seed.rs`) is served by
-- `vp run -F ohif-viewer dev` (a preview of the downloaded build) and has no
-- fallback content.
--
-- The id and the OAuth `client_id` are both the published path segment,
-- `ohif-viewer`, matching the convention 0005 established. The two MUST stay
-- equal: the host's self-hosted redirect resolver
-- (`apps/wildflower-tauri/src-tauri/src/self_hosted_redirect_resolver.rs`) looks
-- an app up by `client_id`, so an app-relative redirect entry only resolves when
-- `client_id == id`. The gatekeeper half (the `clients` row + its absolute Pages
-- redirect URI) is gatekeeper migration `0009_seed_ohif_viewer_client`; the
-- runtime side is `apps/ohif-viewer/config/app-config.js`.
--
-- THE LAUNCH URL HAS NO `launch.html`. OHIF is a single-page app whose FHIR data
-- source reads `iss` + `launch` off the URL of whichever route it is opened on,
-- and GitHub Pages serves real files only, so the EHR launch targets the
-- viewer's root (its worklist) — the one route that is a real `index.html`. The
-- OAuth redirect lands back on that same root. `iss` is `{origin}/fhir-r4`, the
-- same FHIR base every other cloud row hands its app.
--
-- `local_only = 0` (its assets are fetched from wildflowerhealth.io) and
-- `requires_tunnel = 1`, as for every cloud app: the HTTPS Pages document's
-- `iss={origin}` FHIR fetch needs the tunnel's verified HTTPS origin (a loopback
-- `{origin}` is unreachable remotely and refused by WebKit even on device — see
-- 0005's WHY CLOUD note).
--
-- DEFENSIVE SQL, as in 0003..0006: `INSERT OR REPLACE` + the `EXISTS` guard on
-- the cloud payload keep this idempotent and FK-safe, so an install where the
-- registration is somehow already present is a no-op rather than a failed
-- migration (a failed migration aborts `SqliteAppsStore::open`, and the whole
-- registry stops opening).
--
-- `position` is computed as the current tail (`MAX(position) + 1`), not a
-- hardcoded literal: `position` is UNIQUE and uploads allocate `MAX(position)+1`,
-- so a literal could collide on an install that uploaded an app before upgrading
-- into 0007. Appending at the tail is collision-free and keeps the seeded display
-- order stable on a fresh run.
INSERT OR REPLACE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, kind, local_only, requires_tunnel, position)
   VALUES ('ohif-viewer',
           'ohif-viewer',
           'Imaging',
           'View imaging studies in the OHIF viewer',
           1,
           'cloud',
           0,
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations));

-- The cloud launch template: the viewer's root, with the SMART EHR-launch
-- parameters the FHIR data source reads off the URL (see the note above on why
-- there is no `launch.html`). `INSERT OR REPLACE` + the `EXISTS` guard keep it
-- idempotent and FK-safe: it writes only when the registration it references is
-- actually there and cloud.
INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'ohif-viewer',
       'https://wildflowerhealth.io/ohif-viewer/?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'ohif-viewer' AND kind = 'cloud');
