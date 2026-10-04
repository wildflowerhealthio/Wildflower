-- Seed the Synthesized Health Viewer SMART app's OAuth client. Same column
-- formats as 0003_seed_sample_clients and the first-party seeds that follow it
-- (see `db/clients.rs`). A public PKCE client — the app is a browser SMART app
-- with no client secret, so `secret_hash` stays NULL. `disabled_at` NULL: the
-- client ships enabled, and only an admin disable ever writes it.
--
-- The gatekeeper half of apps migration `0015_seed_health_viewer_app`, which
-- seeds the matching `app_registrations` row (id AND `client_id` both
-- `health-viewer-app`) served from
-- <https://wildflowerhealth.io/health-viewer-app/>. A launch checks the caller's
-- grant against the scopes of the client its app row names, so the two ids are
-- kept equal, as every first-party app's are.
--
-- The runner keys applied migrations by the directory prefix before the first
-- `_` (the diesel version), so this one takes `0022`: a prefix no earlier
-- migration uses, sorting after `0021`.
--
-- REDIRECT URIS hold only the absolute Pages URL,
-- `https://wildflowerhealth.io/health-viewer-app/`. Every entry is an absolute
-- URL (see `0021_drop_app_relative_redirect_uris`): the `Client` row decodes
-- each as a `url::Url`, so a path entry would leave the row unloadable.
-- `launch.html` (and the standalone `ConnectMenu`) computes its redirect URI
-- from `window.location`, so the value it sends is exactly this published
-- directory URL (trailing slash included) — matched by exact URL equality.
--
-- `allowed_scopes` mirrors what the app requests. The app only reads: the
-- `Observation`s and `MedicationRequest`s it charts, and the `Patient`s its
-- in-app picker lists. `system/` rather than `patient/`, and no
-- `launch/patient`, as for the other first-party apps since
-- `0020_first_party_apps_pick_the_patient`: the reader picks the patient in the
-- app (or "All patients", read unscoped), and the app scopes each search itself
-- with `patient=<id>`.
--
-- This array MUST equal the space-separated `HEALTH_VIEWER_SCOPE` string in
-- `apps/health-viewer/src/config.ts`, element for element and in the same order
-- — a scope the app requests but this client is not allowed fails
-- `/authorize`. A SQL seed and a TS constant share no single source to derive
-- both from, so a test pins them: `seeding.rs`'s
-- `seeds_the_health_viewer_dev_client_with_the_apps_own_scopes` reads
-- `config.ts` and checks both this client and the debug-only
-- `health-viewer-app-dev` client (`HEALTH_VIEWER_DEV_SCOPES`, seeded at runtime
-- rather than by a migration) against it. Change all three in step.
--
-- `INSERT OR IGNORE` so an install that somehow already has a client under this
-- id is a no-op rather than a PK conflict that would abort the migration run (and
-- with it the whole gatekeeper store open).
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'health-viewer-app',
        'Synthesized Health Viewer',
        'public',
        '["https://wildflowerhealth.io/health-viewer-app/"]',
        '["launch","openid","fhirUser","system/Observation.rs","system/MedicationRequest.rs","system/Patient.rs"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
