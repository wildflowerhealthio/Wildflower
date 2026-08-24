-- Move the two first-party apps (Medications, Web Trace) from self-hosted rows
-- to CLOUD rows served from the deployed GitHub Pages site, and rename their
-- identifiers to match the published URLs.
--
-- WHY CLOUD. Both apps are now built and published by `apps/github-pages` to
-- <https://wildflowerhealth.io/medications-app/> and
-- <https://wildflowerhealth.io/web-trace-app/>. Serving the deployed copy means
-- a shipped app updates when the site deploys, not when the user installs a new
-- desktop build, so the bundled-and-synced copy is no longer the launch target.
-- (The vendored builds under `slices/apps/self-hosted-apps/{medication,web-trace}`
-- stay: they are the *source* the Pages assembly copies from, and the fallback
-- content for the debug-only `…-dev` rows — see `apps-rust/src/dev_seed.rs`.)
--
-- RENAMES (approved with the product owner). The app id and the OAuth
-- `client_id` become the published path segment:
--
--   wildflower-medication -> medications-app
--   wildflower-web-trace  -> web-trace-app
--
-- `client_id` is renamed in lockstep with `id` because the two MUST stay equal:
-- the host's self-hosted redirect resolver
-- (`apps/wildflower-tauri/src-tauri/src/self_hosted_redirect_resolver.rs`) looks
-- an app up by `client_id`, so an app-relative redirect entry only resolves when
-- `client_id == id`. The debug-only `…-dev` rows keep that invariant too. The
-- gatekeeper half of the rename (the `clients` rows, plus the new absolute Pages
-- redirect URI) is gatekeeper migration `0006_rename_first_party_app_clients`;
-- the TS side is each app's `src/config.ts`.
--
-- `requires_tunnel = 1` for both. `requires_tunnel` only decides how the cloud
-- launch resolves `{origin}` (see `resolve_origin` in
-- `http/routes/apps/launch.rs`): with it set the launch forces the tunnel up and
-- substitutes the tunnel's verified HTTPS origin; without it `{origin}` is the
-- *served* origin — loopback (`http://127.0.0.1:…`) for an on-device launch, the
-- forwarded public origin for a remote one. The tunnel is required here because
-- the assets are now served from the HTTPS page at wildflowerhealth.io, and that
-- page's `iss={origin}` FHIR fetch has to reach an HTTPS origin from an HTTPS
-- document:
--   * Remotely, a loopback `{origin}` isn't reachable from the visitor's browser
--     at all (it's this device's localhost), and a mixed-content/private-network
--     fetch would be blocked regardless.
--   * On-device, WebKit (macOS + iOS Safari) still refuses an HTTPS page → HTTP
--     loopback request — a long-standing, much-debated WebKit limitation — so
--     even the local launch can't use the served loopback origin.
-- Substituting the tunnel's verified HTTPS origin satisfies both. (Contrast the
-- third-party cloud apps — Growth Chart et al. — which run in someone else's
-- browser and could only ever reach this device through the tunnel anyway.)
--
-- `local_only` for Web Trace drops from 1 to 0: the badge claims "runs entirely
-- on this device", and an app whose assets are fetched from wildflowerhealth.io
-- cannot claim it. (Its data still never leaves the device — the app reads the
-- local FHIR endpoint — but the assets are remote. Accepted trade-off.)
--
-- DEFENSIVE SQL, as in 0003/0004: every statement is written so an install where
-- the rows are missing or a target id is somehow taken is a no-op rather than a
-- failed migration (a failed migration aborts `SqliteAppsStore::open`, and the
-- whole registry stops opening).

-- The self-hosted payloads go first: `self_hosted_app_configurations.id` is a FK
-- onto `app_registrations(id)` with ON DELETE CASCADE but *no* ON UPDATE action,
-- so renaming the registration while a payload row still points at the old id
-- would violate the constraint (foreign keys are ON for every pooled connection).
DELETE FROM self_hosted_app_configurations
 WHERE id IN ('wildflower-medication', 'wildflower-web-trace');

UPDATE app_registrations
   SET id = 'medications-app',
       client_id = 'medications-app',
       kind = 'cloud',
       requires_tunnel = 1
 WHERE id = 'wildflower-medication'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'medications-app');

UPDATE app_registrations
   SET id = 'web-trace-app',
       client_id = 'web-trace-app',
       kind = 'cloud',
       local_only = 0,
       requires_tunnel = 1
 WHERE id = 'wildflower-web-trace'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-trace-app');


INSERT OR REPLACE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, kind, local_only, requires_tunnel, position)
   VALUES ('web-server-docs',
           'web-server-docs',
           'Server Docs (web)',
           'View the server documentation in your browser.',
           1,
           'cloud',
           0,
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations));

-- The cloud launch templates. The two first-party apps' `launch.html` is the
-- SMART EHR-launch endpoint (`{launch}` + `iss` are read off the URL by
-- fhirclient), the same shape their former
-- `self_hosted_app_configurations.launch_path` carried — absolute now instead of
-- relative to the app's own on-device origin.
-- `INSERT OR REPLACE` + the `EXISTS` guard keep this idempotent and FK-safe: it
-- writes only when the registration it references is actually there.
INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'medications-app',
       'https://wildflowerhealth.io/medications-app/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'medications-app' AND kind = 'cloud');

INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'web-trace-app',
       'https://wildflowerhealth.io/web-trace-app/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-trace-app' AND kind = 'cloud');

-- The server-docs console is NOT a SMART EHR-launch app: it is a static Scalar
-- reference that targets whichever running server the reader points it at via its
-- own `?server=` contract (`apps/wildflower-server-docs/src/server-target.ts`),
-- and it signs in standalone as the `wildflower-server-docs` PKCE client (seeded
-- by gatekeeper `0007`) rather than being handed a host-minted `{launch}` nonce.
-- So it takes `{origin}` alone, as `?server={origin}` — no `{launch}`, no `iss`.
-- The console appends `/fhir-r4` itself, so `{origin}` here is the bare origin.
-- `requires_tunnel = 1` still applies: `{origin}` must be an HTTPS origin the
-- reader's browser can reach (see the WHY CLOUD note above). The path carries the
-- trailing slash so it matches the client's one registered redirect URI exactly.
INSERT OR REPLACE INTO cloud_app_configurations (id, url)
SELECT 'web-server-docs',
       'https://wildflowerhealth.io/wildflower-server-docs/?server={origin}'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'web-server-docs' AND kind = 'cloud');
