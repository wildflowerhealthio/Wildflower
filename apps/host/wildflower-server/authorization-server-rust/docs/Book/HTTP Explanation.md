# HTTP

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/state.rs}}

The HTTP layer is how the server's callers reach the capabilities: a browser at the front door, an app's back end at the token endpoint, the Owner's pages at `/authorization`, and the host, which layers this crate's bearer gate over its own routes. **Everything axum-shaped lives under `src/http/`, and it decides nothing about access on its own.** A handler parses the request, acquires one capability through an extractor, calls it, and renders the outcome. The rules live in the capabilities and the domain below them.

## Three surfaces

The server answers on three groups of paths, each behind a different gate.

| Paths                                    | Who calls it                                                     | What stands in front                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/.well-known/jwks.json`, `/oauth/*` API | Anyone: a browser starting a request, an app's back end, devices | No bearer. The authorization start limit on the two routes that start a request; client authentication where it's due. |
| `/oauth/*` pages                         | The person at the browser                                        | No bearer. The wait page, consent card, limited page, device and pairing pages, sign-in and sign-out.                  |
| `/authorization/*`                       | The Owner's pages, and any app holding `wildflower/*` scopes     | The session gate (a valid, unrevoked bearer), then a scope gate per route, all cache-suppressed.                       |

The `/oauth` API routes are the documented ones: an `OpenApiRouter` collects the `OpenAPI` spec from the very handlers that serve them, beside the JWKS route. The pages are kept out of the spec. Of `/authorization`, only the `/clients` routes are documented.

## The gates

Three gates stand between a request and a capability, each on the [Middleware](<HTTP/Middleware Explanation.md>) page.

1. **The session gate**, [`require_valid_session`](<HTTP/Middleware Explanation.md#require_valid_session>), wraps all of `/authorization`. It proves who the caller is: no valid bearer, no entry, a `401`. It hands the verified claims to the route.
2. **The bearer gate**, [`authorization_server_auth_middleware`](<HTTP/Middleware Explanation.md#authorization_server_auth_middleware>), is the same check, packaged as a layer for the host to put over its FHIR server and other routes, with paths it may exempt.
3. **The authorization start limit**, [`limit_authorization_starts`](<HTTP/Middleware Explanation.md#limit_authorization_starts>), sits on `GET /oauth/authorize` and `POST /oauth/device_authorization`, the two routes anyone can call to start a request that may raise the Owner's approval popup. It asks the host whether to admit the start, and answers `429` when it doesn't.

Past the session gate, **what** the caller may do is decided per route, by the extractor the handler takes.

## How a request reaches a capability

A handler never names the router state. It takes one of three extractors, and the extractor builds the capability:

| Extractor                                          | Builds the capability from                       | Gate                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `Scoped<F>`                                        | the state and the claims the session gate stored | The claims must cover `F`'s required scopes, or the request is `403` with the missing scopes.                 |
| `Authenticated<F>`                                 | the state and the claims, whole                  | None beyond the session gate: for a caller acting on its own session (logout, reading its own scopes).        |
| [`Live<F>`](<HTTP/Extractors Explanation.md#live>) | the state alone                                  | None at extraction. The front door's capabilities are gated by the proofs their methods take, not by a scope. |

`Scoped` and `Authenticated` come from the shared `scope-capabilities-rust` crate; both fail closed with a `500` if they find no claims, since that means a route was mounted without its gate. The rule that handlers reach the state only this way is held by a source guard, [`handlers_reach_the_state_only_through_capabilities`](<Capabilities Explanation.md#handlers_reach_the_state_only_through_capabilities>).

A failure comes back as a domain error, and the [Errors and Wire Shapes](<HTTP/Errors and Wire Shapes Explanation.md>) page renders it: a typed `404` or `409`, the `403` for a missing scope, an opaque `500` for an infrastructure failure.

## `router`

**The whole public surface, mounted.** The host merges it into its own router; the module owns its mount paths. It builds three pieces and joins them over the shared state:

- the documented pre-auth routes, JWKS and the `/oauth` API, with the start limit layered on the two starting routes;
- the `/oauth` pages, which need the launcher base for where sign-out sends a browser;
- the `/authorization` routes, merged from each resource's router, with the deferred start limit on the ask-owner route, then the session gate, then cache suppression outermost, so the session gate's own `401`s carry `no-store` too.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs router}}

The documented half is built by one private function, so the spec the tests snapshot and the routes that serve traffic are the same routes. The router passes a closure that layers the start limit; the spec passes one that leaves the routes as they are.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs documented_public_router}}

The middleware, the extractors and the routes are private to this module. What the crate exports from it is the router, the state, the bearer gate and its `ensure_bearer_header` helper, and the browser-session cookie functions the host's cookie-to-bearer layer calls (see [Browser Session Cookie](<HTTP/Browser Session Cookie Explanation.md>)).

Exercised end to end by every integration test: each spins the router up over an in-memory store (see [`spin_up`](<Integration Tests Explanation.md#spin_up>)).

## `openapi_spec_snapshot_is_up_to_date`

**The published `OpenAPI` document is the one the routes generate.** The spec is collected from the documented routes, with the `/authorization` `/clients` routes added, a fixed title and version so the crate's version doesn't churn it, and the `403` insufficient-scope response added to every documented `/authorization` path. The committed snapshot is what the TypeScript spec-drift test and the server-docs console read, so a change to a wire type fails here until the snapshot is regenerated.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs openapi_spec}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs openapi_tests::openapi_spec_snapshot_is_up_to_date}}

## The state

`AuthorizationServerState` is defined with the live bindings, not here, so that the capabilities in `domain/` can be built from it without `domain/` depending on `http`. `state.rs` re-exports it under `crate::http::state`. Its fields are on the [Live Bindings](<Assembly/Live Bindings Explanation.md>) page.

## Pages

- [Browser Session Cookie](<HTTP/Browser Session Cookie Explanation.md>): the `__Host-browser_session` cookie, how it is set and cleared, and how a request's cookie becomes a standing session.
- [Errors and Wire Shapes](<HTTP/Errors and Wire Shapes Explanation.md>): how failures render, and the JSON bodies shared across routes.
- [Extractors](<HTTP/Extractors Explanation.md>): `Live<F>` and the launcher's pages.
- [Middleware](<HTTP/Middleware Explanation.md>): the session gate, the bearer gate, the start limit, cache suppression.
- [Routes](<HTTP/Routes Explanation.md>): every handler, by path.
