-- Seed the OHIF imaging viewer's OAuth client. Same pattern and column formats as
-- 0003_seed_sample_clients / 0004 / 0005 / 0006 / 0007 / 0008 (see
-- `db/clients.rs`). A public PKCE client — the viewer is a browser SMART app
-- with no client secret, so `secret_hash` stays NULL. `disabled_at` NULL: the
-- client ships enabled, and only an admin disable ever writes it.
--
-- The gatekeeper half of apps migration `0007_seed_ohif_viewer_app`, which
-- seeds the matching `app_registrations` row (id AND `client_id` both
-- `ohif-viewer`) as a CLOUD row served from
-- <https://wildflowerhealth.io/ohif-viewer/>. The two ids MUST stay equal: the
-- host's self-hosted redirect resolver looks an app up by `client_id`, so an
-- app-relative redirect entry only ever resolves for a client whose id is also an
-- app id.
--
-- REDIRECT URIS are the two entries every cloud first-party app carries (see
-- `0006_rename_first_party_app_clients`):
--
--   * `"/"` — the app-relative entry. It resolves only through the self-hosted
--     resolver, so on a production install (where the app is a *cloud* row) it
--     matches nothing. It is kept for a `down`-migrated install and for symmetry
--     with the other first-party app clients, whose debug-only `-dev` siblings
--     are self-hosted rows that do resolve it. (The `ohif-viewer-dev` sibling is
--     not one of those: its app row is a cloud row on the preview origin, so it
--     leans on its own absolute loopback redirect instead — see
--     `seeding.rs`'s `seed_dev_app_clients`.)
--   * the absolute Pages URL —
--     `https://wildflowerhealth.io/ohif-viewer/fhir-viewer`. A cloud app's
--     redirect can only be absolute: the app-relative form needs a self-hosted
--     row to resolve against. The EHR launch targets the viewer's FHIR Viewer
--     mode route, so the value OHIF's FHIR data source sends as
--     `redirect_uri` is this path — matched here by exact URL equality.
--
-- `allowed_scopes` is exactly what the viewer requests — the `smartScope` the
-- data-source configuration in `apps/ohif-viewer/config/app-config.js` sets,
-- which replaces the extension's built-in default (`patient/*.read` plus two
-- `fhircast/` scopes this server does not implement). Read-only: the viewer
-- resolves studies through `ImagingStudy` and `DocumentReference` searches and
-- reads the launch `Patient`, and never writes. `system/` rather than
-- `patient/`, as the other first-party apps: the host's EHR launch carries no
-- patient context, so a `patient/` scope would match nothing. SMART v2 letters,
-- `.rs` (read + search) on each type. `ImagingStudy` is listed even though the
-- FHIR server serves no such endpoint yet: the scope grammar accepts any named
-- type, the viewer asks for it, and a scope the app requests but the client is
-- not allowed fails `/authorize`.
--
-- This array MUST equal the space-separated `smartScope` string in
-- `apps/ohif-viewer/config/app-config.js`, element for element and in the same
-- order. No test spans the TS/Rust boundary here (a SQL seed and a JS config
-- share no single source to derive both from), so the pairing is held by
-- mirrors: that file's comment, this comment, and the exact vector asserted in
-- `db/clients.rs`'s `migrations_seed_the_smart_app_clients`. The debug-only
-- `ohif-viewer-dev` client (`seeding.rs`'s `seed_dev_app_clients`, seeded at
-- runtime rather than by a migration) carries this same set — widen it in step
-- too.
--
-- `INSERT OR IGNORE` so an install that somehow already has a client under this
-- id is a no-op rather than a PK conflict that would abort the migration run (and
-- with it the whole gatekeeper store open).
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'ohif-viewer',
        'Imaging',
        'public',
        '["/","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"]',
        '["launch","openid","fhirUser","system/Patient.rs","system/ImagingStudy.rs","system/DocumentReference.rs"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
