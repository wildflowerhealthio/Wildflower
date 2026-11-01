# Session Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs}}

Four routes are about tokens themselves rather than what they unlock. A caller **reads back its own session** and **ends it**. The Owner **revokes tokens**, by id or by app. Anyone **fetches the public keys** that verify every token this server signs.

The first three live under `/authorization`, behind [`require_valid_session`](<../Middleware Explanation.md#item-require_valid_session>): no valid, unrevoked bearer token, no answer but a `401`. The session read and logout are **self-service**: a caller acting on its own session needs no scope, so they take their capability through `Authenticated<…>`, which hands over the caller's verified claims and nothing else. Revoking other tokens is an Owner's power, and takes `wildflower/Token.d` through `Scoped<…>`. The key set is public, and sits outside `/authorization`.

## `http::routes::session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs self}}

### `openapi_router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs openapi_router}}

### `handle_get_session`

The answer comes through the [session reader](<../../Capabilities/Session/Session Reader Explanation.md>): [`scopes`](<../../Capabilities/Session/Session Reader Explanation.md#item-SessionReader--scopes>) from the claims, and [`browser_session_expires_at`](<../../Capabilities/Session/Session Reader Explanation.md#item-SessionReader--browser_session_expires_at>) from the session the token's `sid` names.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs handle_get_session}}

### `SessionResponse`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/session.rs SessionResponse}}

The [Scope Gating](<../../Integration Tests/Scope Gating Explanation.md>) tests hold the route to answering an under-scoped caller and refusing one with no token, and [Browser Sessions](<../../Integration Tests/Browser Sessions Explanation.md>) holds it to the session's expiry.

## `http::routes::logout`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs self}}

### `openapi_router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs openapi_router}}

### `handle_logout`

The [session ender](<../../Capabilities/Session/Session Ender Explanation.md>) is built from the claims [`require_valid_session`](<../Middleware Explanation.md#item-require_valid_session>) already verified, and [`end`](<../../Capabilities/Session/Session Ender Explanation.md#item-SessionEnder--end>) denylists the token's `jti`. **Denylisting is best-effort**: a token with no `jti` or expiry has nothing to denylist, and a store failure is logged, never answered. Either way the browser goes to the hosted launcher with a `303 See Other`, which turns the `POST` into a `GET`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/logout.rs handle_logout}}

The [Revocation](<../../Integration Tests/Revocation Explanation.md>), [Scope Gating](<../../Integration Tests/Scope Gating Explanation.md>) and [Bearer Only](<../../Integration Tests/Bearer Only Explanation.md>) tests hold logout to revoking the presented `jti`, to taking any valid bearer, and to redirecting without setting cookies.

## `http::routes::revocations`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs self}}

The daily sweep keeps a denylisted `jti` until the longest token this server mints, issued at the moment of revocation, would have expired (see [`setup_authorization_server`](<../../Assembly/Setup Explanation.md#item-setup_authorization_server>)). So an `expiresAt` that is too early can't free a live token.

### `openapi_router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs openapi_router}}

### `RevocationRequest`

**The body's fields are all optional on the wire**, so a body naming neither mode, both, or a `jti` without its expiry gets a `400` saying which, rather than a generic parse error.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRequest}}

### `RevocationRequestBody`

The spec describes the body as the client sends it, one mode or the other.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRequestBody}}

#### `into_revocation`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRequest::into_revocation}}

### `Revocation`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs Revocation}}

### `handle_create_revocation`

Each mode goes through the [token revoker](<../../Capabilities/Access/Tokens Explanation.md>): [`revoke_jti`](<../../Capabilities/Access/Tokens Explanation.md#item-TokenRevoker--revoke_jti>) or [`revoke_subject`](<../../Capabilities/Access/Tokens Explanation.md#item-TokenRevoker--revoke_subject>). A `jti` whose `expiresAt` has already passed is refused too: the token is already dead, and denylisting it would only leave a dead row.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs handle_create_revocation}}

### `RevocationError`

The `400` is this route's own shape, `{ "error": …, "detail": … }`. A store failure renders as every other `/authorization` failure does.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationError}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationRefusedBody}}

#### `bad_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationError::bad_request}}

#### `from`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationError::from}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/revocations.rs RevocationError::into_response}}

The [Revocation](<../../Integration Tests/Revocation Explanation.md>) tests hold the route to both modes, to refusing each bad body, and to the Owner's scope. [Scope Gating](<../../Integration Tests/Scope Gating Explanation.md>) holds it to `wildflower/Token.d` exactly.

## `http::routes::well_known_jwks`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs self}}

### `Jwks`

Each key is a [public JWK](<../../Utilities Explanation.md#item-PublicJwk>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs Jwks}}

### `handle_jwks_request`

**Anyone may fetch the public half of every signing key the server holds**: the active one, and any kept only to verify. No token is asked for. The [public keys reader](<../../Capabilities/OAuth/Public Keys Reader Explanation.md>) is built from the router state alone, through [`public_jwks`](<../../Capabilities/OAuth/Public Keys Reader Explanation.md#item-PublicKeysReader--public_jwks>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs handle_jwks_request}}

The [Smoke](<../../Integration Tests/Smoke Explanation.md>) tests hold it to serving the seeded key.
