-- Seed the Lifting SMART app's OAuth client. Same column formats as
-- 0003_seed_sample_clients and the first-party seeds that follow it (see
-- `db/clients.rs`). A public PKCE client — the app is a browser SMART app with
-- no client secret, so `secret_hash` stays NULL. `disabled_at` NULL: the client
-- ships enabled, and only an admin disable ever writes it.
--
-- The gatekeeper half of apps migration `0010_seed_lifting_app`, which seeds the
-- matching `app_registrations` row (id AND `client_id` both `lifting-app`) as a
-- CLOUD row served from <https://wildflowerhealth.io/lifting-app/>. The two ids
-- MUST stay equal: the host's self-hosted redirect resolver looks an app up by
-- `client_id`, so an app-relative redirect entry only ever resolves for a client
-- whose id is also an app id.
--
-- The runner keys applied migrations by the directory prefix before the first
-- `_` (the diesel version), so this one takes `0019`: a prefix no earlier
-- migration uses, sorting after `0018`.
--
-- REDIRECT URIS are the two entries every cloud first-party app carries (see
-- `0006_rename_first_party_app_clients`):
--
--   * `"/"` — the app-relative entry. It resolves only through the self-hosted
--     resolver, so on a production install (where the app is a *cloud* row) it
--     matches nothing. It is kept for a `down`-migrated install and for symmetry
--     with the other first-party app clients.
--   * the absolute Pages URL — `https://wildflowerhealth.io/lifting-app/`. A
--     cloud app's redirect can only be absolute: the app-relative form needs a
--     self-hosted row to resolve against. `launch.html` (and the standalone
--     `ConnectMenu`) computes its redirect URI from `window.location`, so the
--     value it sends is exactly this published directory URL (trailing slash
--     included) — matched here by exact URL equality.
--
-- `allowed_scopes` mirrors what the app requests, and like the Importer's it
-- **carries writes**: the training plan definition is a `PlanDefinition`, each
-- exercise a `ServiceRequest` instantiating it, each workout a `Procedure` and
-- each set an `Observation` `part-of` it — all searched to show the plan and its
-- history, and written when a plan is started or edited or a workout submitted.
-- `system/Patient.rs` reads the launch patient the plan belongs to. SMART v2
-- letters: `.crus` (create + read + update + search) on each written type,
-- because every write is a `PUT /{type}/{client-minted id}` entry in one batch
-- `Bundle` — an update-as-create, and a server that gates update-as-create on
-- `create` needs `.c` too — and the app never deletes; `.rs` on `Patient`,
-- which it never writes. `system/` rather than `patient/`, as the other
-- first-party apps: the FHIR server does not narrow a search by the token's
-- patient-compartment context, so the app scopes each search itself with
-- `patient=<id>`.
--
-- `launch/patient` is here for the same reason it is on `medications-app`
-- (`0004` / `0011`): the standalone connect flow requests it so the server
-- picks a patient, and the requested set must be a subset of the allowed set.
-- The app requests one scope string for both launches.
--
-- This array MUST equal the space-separated `LIFTING_SCOPE` string in
-- `apps/lifting-app/src/config.ts`, element for element and in the same order
-- — a scope the app requests but this client is not allowed fails
-- `/authorize`. A SQL seed and a TS constant share no single source to derive
-- both from, so a test pins them: `seeding.rs`'s
-- `seeds_the_lifting_dev_client_with_the_apps_own_scopes` reads `config.ts`
-- and checks both this client and the debug-only `lifting-app-dev` client
-- (`LIFTING_DEV_SCOPES`, seeded at runtime rather than by a migration) against
-- it. Change all three in step.
--
-- `INSERT OR IGNORE` so an install that somehow already has a client under this
-- id is a no-op rather than a PK conflict that would abort the migration run (and
-- with it the whole gatekeeper store open).
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'lifting-app',
        'Lifting',
        'public',
        '["/","https://wildflowerhealth.io/lifting-app/"]',
        '["launch","launch/patient","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
