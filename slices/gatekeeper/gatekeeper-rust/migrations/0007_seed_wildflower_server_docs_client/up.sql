-- Seed the OAuth client for the server-docs API console — the Scalar-based
-- console published at <https://wildflower-health.io/wildflower-server-docs>
-- (`apps/wildflower-server-docs`, assembled by `apps/github-pages`). A public
-- PKCE client: it is a static browser page, so it can keep no secret and
-- `secret_hash` stays NULL. Same pattern and column formats as
-- 0003_seed_sample_clients / 0004 / 0005 (see `db/clients.rs`).
--
-- REDIRECT URI is the single absolute published directory URL. The console is
-- not an app row at all (it never appears on the homescreen), so the app-relative
-- form has nothing to resolve against; the absolute entry is matched by exact URL
-- equality at `/authorize`.
--
-- The console performs a SMART **standalone launch** against whichever server the
-- user points it at, so it may ask for anything the server exposes — hence the
-- MAXIMAL known scope set below. That is deliberate and safe: `allowed_scopes` is
-- only the ceiling on what may be *requested*; the authorize consent step is the
-- narrowing point, and `grantable_scopes` (scopes-rust) clamps an approval to the
-- intersection of requested ∧ allowed, so the user decides per launch what the
-- console actually gets.
--
-- Each entry, with where the vocabulary comes from (`slices/scopes/scopes-rust`):
--
--   * `openid`, `profile`, `fhirUser`, `launch`, `launch/patient`,
--     `offline_access`, `wildflower/launch` — the complete closed set of
--     non-resource scopes, `scope/known.rs` (`KnownScope::parse`). These match
--     EXACTLY: no wildcard covers them, so each must be listed. In particular
--     `wildflower/launch` is a known scope, NOT a `wildflower/` resource scope,
--     so `wildflower/*.cruds` does not cover it.
--   * `system/*.cruds` — the widest FHIR resource scope, `scope/resource/fhir.rs`
--     + `scope/resource/permission.rs`: `system` context covers `user` and
--     `patient` too (`ContextLevel::covers`), `*` covers every resource type, and
--     the `cruds` letter bag is every interaction — and a v2 letter grant also
--     covers the SMART v1 word forms (`.read`/`.write`/`.*`), while the reverse
--     is not true, so the letter form is the one to register.
--   * `wildflower/*.cruds` — the widest Wildflower resource scope,
--     `scope/resource/wildflower.rs`: the `*` wildcard over the closed resource
--     set (AuthorizationRequest, Grant, Client, Token, Apps, Accounts,
--     TunnelSettings) with every interaction.
--
-- Anything outside that vocabulary parses as an `UnknownScope` and matches only
-- itself, so there is nothing further a wildcard could add.
--
-- `allowed_grant_types` is `authorization_code` + `refresh_token`: the console
-- runs the PKCE code flow and may request `offline_access`. No device-code flow —
-- there is no second-screen pairing story for a page the user is already looking
-- at.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'wildflower-server-docs',
        'Wildflower Server API Console',
        'public',
        '["https://wildflower-health.io/wildflower-server-docs/"]',
        '["openid","profile","fhirUser","launch","launch/patient","offline_access","wildflower/launch","system/*.cruds","wildflower/*.cruds"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
