# Middleware

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/middleware/cache_suppression.rs}}

The middleware are the gates a request passes before a handler sees it. Each enforces one rule:

- **Only a live token of this server's gets past a bearer gate.** Two gates check it, the session gate on `/authorization` and the bearer gate the host layers over its own routes, and both run one pipeline, so they can't disagree about a token.
- **Starting requests that may reach the Owner is rate-limited.** Anyone who knows the server's domain can start an authorization request, and each one raised for the Owner pops up on the Owner's device. The start limit asks the host whether to admit each one.
- **Nothing on `/authorization` is cached.** Every response there is privileged.

Middleware verify tokens only through the [token verifier](<../Capabilities/Session/Token Verifier Explanation.md>), never against a store; the source guard [`middleware_verifies_only_through_the_token_verifier`](<../Capabilities Explanation.md#item-source_guards--middleware_verifies_only_through_the_token_verifier>) holds that. The [Request Caller](<../Integration Tests/Request Caller Explanation.md>), [Authorization Start Limit](<../Integration Tests/Authorization Start Limit Explanation.md>) and [Cache Suppression](<../Integration Tests/Cache Suppression Explanation.md>) integration tests hold these gates end to end.

## `http::middleware`

### `MiddlewareFuture`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/mod.rs MiddlewareFuture}}

## `http::middleware::require_auth`

### `try_bearer_token_from_headers`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs try_bearer_token_from_headers}}

### `verify_request_claims`

**The one pipeline both bearer gates run.** The verifier holds this server's origin as the only `iss` and `aud` it accepts, and a failure renders through [`verify_error_response`](<Errors and Wire Shapes Explanation.md#item-verify_error_response>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs verify_request_claims}}

### `require_valid_session`

**The session gate on `/authorization`.** It stores the [`VerifiedClaims`](<../Domain/Access Token Explanation.md#item-VerifiedClaims>) in the request, so a token is verified once per request, here, and the `Scoped<…>` and `Authenticated<…>` [extractors](<Extractors Explanation.md>) read them.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}}

## `http::middleware::require_valid_bearer_token`

### `authorization_server_auth_middleware`

**The bearer gate the host puts in front of its own routes**: the FHIR server, where the paths a client may read without a token are exempt, and the imaging viewer, where none are. A verified request carries the token's scopes on as `ScopeClaims`, the framework-neutral form the host's own `Scoped<…>` capabilities read.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs authorization_server_auth_middleware}}

### `BearerGate`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs BearerGate}}

### `BearerGateFn`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs BearerGateFn}}

### `AuthorizationServerAuthMiddleware`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs AuthorizationServerAuthMiddleware}}

### `is_exempt`

The tests check paths against [`exempt`](<Test Fixtures Explanation.md#middleware>), two of the FHIR server's exempt paths.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs is_exempt tests="tests::exact_path_is_exempt tests::trailing_slashes_are_trimmed_before_matching tests::near_misses_stay_gated tests::empty_exempt_list_gates_everything"}}

### `ensure_bearer_header`

The host's FHIR web UI keeps its signed-in user's token server-side, so a page's request carries a session cookie and no `Authorization`, and so does a request from the server's own pages on the [browser session cookie](<Browser Session Cookie Explanation.md>). The host's layer calls this to present the session's bearer. The tests read the header back with [`bearer`](<Test Fixtures Explanation.md#middleware>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_valid_bearer_token.rs ensure_bearer_header tests="tests::ensure_bearer_header_injects_when_absent tests::ensure_bearer_header_leaves_an_existing_bearer_untouched"}}

## `http::middleware::authorization_start_limit`

The limit sits on the two routes that start a request, `GET /oauth/authorize` and `POST /oauth/device_authorization`, on every method axum serves them on, and on no other route. **The authorization server doesn't decide who is over the limit**: it knows only the request. The host, which knows the connection a request arrived on, does, through the [`AuthorizationStartGate`](<../Assembly/Ports and Adapters Explanation.md>) port, with an allowance per visitor and one overall.

**What spends from the limit is a request raised for the Owner, and only that.** Most starts ask the gate at once, before the request is even parsed, so every attempt counts, however malformed. Two kinds of start can't yet know whether they will reach the Owner, so the layer defers the question and the route asks once it knows:

- **A browser whose session [can decide consents](<Browser Session Cookie Explanation.md#item-can_decide_consents>)**, the Owner's own browser typically. A request it decides on its own consent card raises nothing for the Owner. One it can't decide, and every device request, does, and asks then.
- **An `/oauth/authorize` request carrying no browser session.** The endpoint sends that browser to pairing and parks nothing, so it costs the Owner no popup, and a flood of them can't spend the allowance a paired browser's requests need.

A session the store can't vouch for, because a store can't be read, doesn't defer; it asks the gate like any other start. A request parked on the browser's limited page has spent by the time it is parked, so going on from that page asks nothing more. Asking the Owner about a request from the consent card raises it without starting one, so it spends from the same limit, when it actually raises one.

### `RATE_LIMITED`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs RATE_LIMITED}}

### `AuthorizationStartRoute`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs AuthorizationStartRoute}}

### `start_limited_response`

The layer, `StartLimitAskedNow`, and the routes asking a deferred limit all answer with it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs start_limited_response}}

### `DeferredStartLimit`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs DeferredStartLimit}}

#### `admits`

`/oauth/authorize` asks it before raising a request for the Owner or parking it for the limited page; the ask-owner route asks it before raising one.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs DeferredStartLimit::admits}}

### `StartLimitAskedNow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs StartLimitAskedNow}}

#### `from_request_parts`

With no deferred limit on the request, the layer has already asked, and it passes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs StartLimitAskedNow::from_request_parts}}

### `defer_authorization_start_limit`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs defer_authorization_start_limit}}

### `limit_authorization_starts`

It reads the request's browser session through [`carried_browser_session`](<Browser Session Cookie Explanation.md#item-carried_browser_session>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs limit_authorization_starts}}

## `http::middleware::cache_suppression`

### `cache_suppress`

**Every `/authorization` response is `no-store`.** Each one carries something privileged: a pending consent, a device prompt, the standing grants, the caller's session, the outcome of an approval. The layer is outermost on the `/authorization` router, so a new route, a `404` and the session gate's own `401` all carry it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/middleware/cache_suppression.rs cache_suppress}}
