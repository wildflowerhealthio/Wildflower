-- Seed the FHIR Sync for Pebble SMART app's OAuth client. Same column formats as
-- 0003_seed_sample_clients and the first-party seeds that follow it (see
-- `db/clients.rs`). A public PKCE client — the app is a browser SMART app with
-- no client secret, so `secret_hash` stays NULL. `disabled_at` NULL: the client
-- ships enabled, and only an admin disable ever writes it.
--
-- STANDALONE ONLY. The app is the Pebble watchapp's settings page, opened by the
-- Pebble phone app and launched through its own `ConnectMenu`; it is never
-- launched from the homescreen, so there is no matching `app_registrations`
-- row and no apps migration beside this one.
--
-- REDIRECT URIS: only the absolute Pages URL,
-- `https://wildflowerhealth.io/fhir-sync-pebble/`. The `ConnectMenu` computes
-- its redirect URI from `window.location`, so the value it sends is exactly
-- this published directory URL (trailing slash included) — matched by exact URL
-- equality. There is no app-relative `"/"` entry: that form resolves only
-- through the self-hosted resolver, against an app row this client has none of.
--
-- `allowed_scopes` is exactly what the watch needs:
--
--   * `launch/patient` — the server's consent step picks the patient and the
--     token response names it. No bare `launch`: that is EHR-launch-only.
--   * `openid`, `fhirUser` — the same identity pair every first-party app asks
--     for.
--   * `patient/Patient.r` — the settings page reads the picked patient back so
--     the user can confirm who the watch will record for.
--   * `patient/Observation.c` — the watch syncs the steps, sleep and heart rate
--     the Pebble records as Observations for that patient.
--     The settings page hands the access token to the watch, so this is the
--     ceiling on what the watch can do with it.
--
-- This array MUST equal the space-separated `scope` string in
-- `apps/fhir-sync-pebble-web/src/config.ts`, element for element and in the same
-- order — a scope the app requests but this client is not allowed fails
-- `/authorize`. No test spans the TS/Rust boundary here, so the pairing is held
-- by mirrors: that file's doc comment, this comment, the exact vector asserted
-- in `db/clients.rs`'s `migrations_seed_the_smart_app_clients`, and the
-- debug-only `fhir-sync-pebble-dev` client (`seeding.rs`'s
-- `seed_dev_app_clients`) a dev build authorizes against.
--
-- `INSERT OR IGNORE` so an install that somehow already has a client under this
-- id is a no-op rather than a PK conflict that would abort the migration run (and
-- with it the whole gatekeeper store open).
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'fhir-sync-pebble',
        'FHIR Sync for Pebble',
        'public',
        '["https://wildflowerhealth.io/fhir-sync-pebble/"]',
        '["launch/patient","openid","fhirUser","patient/Patient.r","patient/Observation.c"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
