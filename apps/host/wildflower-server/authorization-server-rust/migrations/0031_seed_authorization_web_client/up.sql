-- Seed the OAuth client of Wildflower Authorization, the hosted app
-- (`apps/authorization/authorization-web`) where the Owner manages what a
-- server has authorized: the grants it holds, the apps it trusts and the
-- devices it has paired. Every Wildflower server advertises the app, pointed
-- at itself, as its SMART `management_endpoint`, and the app signs in to the
-- server it names like any SMART client. Its first sign-in is approved at the
-- consent prompt, as any app's is.
--
-- A public PKCE client: a static browser page keeps no secret, so
-- `secret_hash` stays NULL. `disabled_at` NULL: the client ships enabled. Same
-- column formats as `0022_seed_health_viewer_app_client` (see `db/clients.rs`).
-- Its id is random (`openssl rand -hex 16`), and its name is the one the
-- consent prompt shows.
--
-- REDIRECT URI is the published app root,
-- `https://wildflowerhealth.io/authorization/`, the one route a sign-in
-- returns to (the app's `sign-in.ts`). A copy served anywhere else (a PR
-- preview, the dev server) presents an unregistered redirect, which the
-- consent prompt carries as a warning.
--
-- `allowed_scopes` is exactly what the app asks for (`AUTHORIZATION_SCOPE` in
-- the app's `src/config.ts`; `db/clients.rs` reads that file and pins this row
-- to it):
--
--   wildflower/Grant.rd                list the grants, revoke one
--   wildflower/Client.ru               list the trusted apps, disable or enable one
--   wildflower/Token.d                 revoke every token a revoked grant's client holds
--   wildflower/AuthorizationRequest.r  read pending authorization requests
--
-- `INSERT OR IGNORE`, as in `0022`, so an install that already has a client
-- under this id is a no-op rather than a PK conflict that aborts the run.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        '7277e898bee8ac81ea44788236e619a5',
        'Wildflower Authorization',
        'public',
        '["https://wildflowerhealth.io/authorization/"]',
        '["openid","wildflower/Grant.rd","wildflower/Client.ru","wildflower/Token.d","wildflower/AuthorizationRequest.r"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
