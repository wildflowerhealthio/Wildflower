-- Seed the Importer SMART app's OAuth client. Same pattern and column formats as
-- 0003_seed_sample_clients / 0004 / 0005 / 0006 / 0007 (see `db/clients.rs`). A
-- public PKCE client — the app is a browser SMART app with no client secret, so
-- `secret_hash` stays NULL. `disabled_at` NULL: the client ships enabled, and
-- only an admin disable ever writes it.
--
-- The gatekeeper half of apps migration `0006_seed_wildflower_importer_app`,
-- which seeds the matching `app_registrations` row (id AND `client_id` both
-- `importer-app`) as a CLOUD row served from
-- <https://wildflowerhealth.io/importer-app/>. The two ids MUST stay equal: the
-- host's self-hosted redirect resolver looks an app up by `client_id`, so an
-- app-relative redirect entry only ever resolves for a client whose id is also an
-- app id.
--
-- REDIRECT URIS are the two entries every cloud first-party app carries (see
-- `0006_rename_first_party_app_clients`):
--
--   * `"/"` — the app-relative entry. It resolves only through the self-hosted
--     resolver, so on a production install (where the app is a *cloud* row) it
--     matches nothing. It is kept for the debug-only `importer-app-dev`
--     self-hosted row's sibling client and for a `down`-migrated install.
--   * the absolute Pages URL — `https://wildflowerhealth.io/importer-app/`. A
--     cloud app's redirect can only be absolute: the app-relative form needs a
--     self-hosted row to resolve against. `launch.html` (and the standalone
--     `ConnectMenu`) computes its redirect URI from `window.location`, so the
--     value it sends is exactly this published directory URL (trailing slash
--     included) — matched here by exact URL equality.
--
-- `allowed_scopes` mirrors what the app requests, and unlike the Medications and
-- Web Trace viewers' it **carries writes**: importing means persisting what a
-- captured session contained. The set is exactly what the flow produces today —
-- the HAR archive `DocumentReference` the confirm step uploads (read back to list
-- previously uploaded archives, written to create a new one), plus the `Patient`
-- and `Observation` resources the registered `fhir-r4` collector replays out of a
-- capture. `system/` rather than `patient/` because a HAR archive carries no
-- `subject`: it records a browsing session, not a clinical fact about a person,
-- so it is unreachable through patient context and a `patient/` scope would match
-- nothing.
--
-- This array MUST equal the space-separated `scope` string in
-- `apps/importer-web/src/config.ts`, element for element and in the same order —
-- a scope the app requests but this client is not allowed fails `/authorize`. No
-- test spans the TS/Rust boundary here (a SQL seed and a TS constant share no
-- single source to derive both from), so the pairing is held by mirrors: that
-- file's doc comment, this comment, `apps/importer-web/AGENTS.md`, and the exact
-- vector asserted in `db/clients.rs`'s `migrations_seed_the_smart_app_clients`.
--
-- `INSERT OR IGNORE` so an install that somehow already has a client under this
-- id is a no-op rather than a PK conflict that would abort the migration run (and
-- with it the whole gatekeeper store open).
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'importer-app',
        'Importer',
        'public',
        '["/","https://wildflowerhealth.io/importer-app/"]',
        '["launch","openid","fhirUser","system/DocumentReference.read","system/DocumentReference.write","system/Patient.write","system/Observation.write"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
