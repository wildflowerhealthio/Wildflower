# Session Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs}}

Four routes about tokens themselves rather than what they unlock. A caller **reads back its own session** and **ends it**; the Owner **revokes tokens** by id or by app; and anyone **fetches the public keys** that verify every token this server signs.

The first three live under `/authorization`, behind {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}} (a `401` without a valid, unrevoked bearer token), and are uncached. The session read and logout are **self-service**: a caller acting on its own session needs no scope, so they acquire their capability through `Authenticated<…>`, which hands over the caller's verified claims and nothing else. Revoking other tokens is an Owner's power and takes `wildflower/Token.d` through `Scoped<…>`. The key set is public and sits outside `/authorization`.

## `session::router`

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs router}}

## `handle_get_session`

`GET /authorization/session`. **A caller reads what its own token carries**: its scopes, and when the browser session it was minted under expires. The device-login screen seeds its scope picker from the scopes, and the server's own pages show the expiry as "Signed in until".

Everything comes from the presented token, or the session its `sid` names, so the answer can't tell the caller anything about anyone else. That is why it takes no scope, and it matters: the callers who most need to read their scopes are the under-scoped ones, just turned away with a `403`. Through `Authenticated<LiveSessionReader>` ([`scopes`](<../../Capabilities/Session/Session Reader Explanation.md#scopes>), [`browser_session_expires_at`](<../../Capabilities/Session/Session Reader Explanation.md#browser_session_expires_at>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs handle_get_session}}

`scopes` is empty for a token with no `scope` claim. `browserSessionExpiresAt` is `null` for a token under no browser session, or one whose `sid` names no session row. The rest of the claims are left off, so this doesn't grow into a general introspection endpoint.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs SessionResponse}}

Exercised end to end by [`access_session_reports_the_callers_own_scopes_without_an_admin_scope`](<../../Integration Tests/Scope Gating Explanation.md#access_session_reports_the_callers_own_scopes_without_an_admin_scope>), [`access_session_without_a_token_is_401_not_an_empty_scope_list`](<../../Integration Tests/Scope Gating Explanation.md#access_session_without_a_token_is_401_not_an_empty_scope_list>) and [`the_session_read_answers_the_browser_session_s_expiry`](<../../Integration Tests/Browser Sessions Explanation.md#the_session_read_answers_the_browser_session_s_expiry>).

## `logout::router`

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs router}}

## `handle_logout`

`POST /authorization/logout`. **A caller ends its own session.** The access token is a JWT that lives out its own short lifetime, so forgetting it only ends the session in that client; logout also **denylists the presented token's `jti`** until its expiry, so a leaked copy dies with it. Through `Authenticated<LiveSessionEnder>` ([`end`](<../../Capabilities/Session/Session Ender Explanation.md#end>)), built from the already-verified claims.

The denylisting is best-effort: a token with no `jti` or expiry has nothing to denylist, and a store failure is logged, never answered. Either way the browser is sent with a `303 See Other` to the hosted launcher's root, since this server serves no UI of its own, and the `303` turns the `POST` into a `GET`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs handle_logout}}

Exercised end to end by [`logout_revokes_the_presented_jti`](<../../Integration Tests/Revocation Explanation.md#logout_revokes_the_presented_jti>), [`access_logout_is_self_service_any_valid_bearer`](<../../Integration Tests/Scope Gating Explanation.md#access_logout_is_self_service_any_valid_bearer>) and [`logout_redirects_to_the_launcher_without_cookies`](<../../Integration Tests/Bearer Only Explanation.md#logout_redirects_to_the_launcher_without_cookies>).

## `revocations::router`

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs router}}

## `handle_create_revocation`

`POST /authorization/revocations`. **The Owner revokes issued tokens**, in one of two modes per request:

- **One token**: `{ "jti": "…", "expiresAt": "<RFC 3339>" }` denylists that token until its own expiry. The expiry lets the daily sweep drop the row once the token would have expired anyway; the sweep also keeps every row until the longest token this server mints, issued at the moment of revocation, would have expired (see [`setup_authorization_server`](<../../Assembly/Setup Explanation.md#setup_authorization_server>)), so an `expiresAt` that is too early can't free a live token.
- **Every token of a subject**: `{ "subject": "<client_id>" }` moves the subject's revocation epoch to now, so every token issued to it up to now is revoked. The subject is a token's `sub`, the app's `client_id`.

It takes `wildflower/Token.d`, through `Scoped<LiveTokenRevoker>` ([`revoke_jti`](<../../Capabilities/Access/Tokens Explanation.md#revoke_jti>), [`revoke_subject`](<../../Capabilities/Access/Tokens Explanation.md#revoke_subject>)). The answer is `204 No Content`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs handle_create_revocation}}

The body's fields are all optional on the wire, so a body naming neither mode, both, or a `jti` without its expiry gets a `400` that says which, rather than a generic parse error:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRequest::into_revocation}}

A `jti` whose `expiresAt` has already passed is refused too (`ExpiresAtInPast`): the token is expired already, and denylisting it would only leave a dead row. The `400` is this route's own shape, `{ "error": …, "detail": … }`; a store failure renders as every other `/authorization` failure does:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationError::into_response}}

Exercised end to end by [`revocations_endpoint_revokes_by_jti`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_revokes_by_jti>), [`revocations_endpoint_bulk_revokes_by_subject`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_bulk_revokes_by_subject>), [`revocations_endpoint_rejects_invalid_bodies`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_rejects_invalid_bodies>), [`revocations_endpoint_requires_owner_auth`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_requires_owner_auth>) and [`access_revocations_requires_token_delete_scope`](<../../Integration Tests/Scope Gating Explanation.md#access_revocations_requires_token_delete_scope>).

## `Jwks`

The RFC 7517 key set: one [public JWK](<../../Utilities Explanation.md#publicjwk>) per signing key.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs Jwks}}

## `handle_jwks_request`

`GET /.well-known/jwks.json`. **Anyone may fetch the public half of every signing key the server holds**, the active one and any kept only to verify, so a resource server can check this server's tokens on its own. No token is asked for. Through `Live<LivePublicKeysReader>` ([`public_jwks`](<../../Capabilities/OAuth/Public Keys Reader Explanation.md#public_jwks>)), built from the router state alone. It is part of the documented surface, served beside `/oauth`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs handle_jwks_request}}

Exercised end to end by [`jwks_endpoint_returns_seeded_key`](<../../Integration Tests/Smoke Explanation.md#jwks_endpoint_returns_seeded_key>).
