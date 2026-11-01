# HTTP

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/state.rs}}

The HTTP layer is how the server's callers reach the [capabilities](<Capabilities Explanation.md>): a browser at the front door, an app's back end at the token endpoint, the Owner's pages at `/authorization`, and the host, which layers this crate's bearer gate over its own routes. **Everything axum-shaped lives under `src/http/`, and it decides nothing about access on its own.** A handler parses the request, acquires one capability through an extractor, calls it, and renders the outcome. The rules live in the capabilities and the [domain](<Domain Explanation.md>) below them.

## Three surfaces

The server answers on three groups of paths, each behind a different gate.

| Paths                                    | Who calls it                                                     | What stands in front                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/.well-known/jwks.json`, `/oauth/*` API | Anyone: a browser starting a request, an app's back end, devices | No bearer. The authorization start limit on the two routes that start a request; client authentication where it's due. |
| `/oauth/*` pages                         | The person at the browser                                        | No bearer. The wait page, consent card, limited page, device and pairing pages, sign-in and sign-out.                  |
| `/authorization/*`                       | The Owner's pages, and any app holding `wildflower/*` scopes     | The session gate (a valid, unrevoked bearer), then a scope gate per route, all cache-suppressed.                       |

Three gates stand between a request and a capability, each on the [Middleware](<HTTP/Middleware Explanation.md>) page. The **session gate**, [`require_valid_session`](<HTTP/Middleware Explanation.md#item-require_valid_session>), wraps all of `/authorization` and proves who the caller is. The **bearer gate**, [`authorization_server_auth_middleware`](<HTTP/Middleware Explanation.md#item-authorization_server_auth_middleware>), is the same check, packaged for the host to put over its FHIR server and other routes. The **authorization start limit**, [`limit_authorization_starts`](<HTTP/Middleware Explanation.md#item-limit_authorization_starts>), sits on the two routes anyone can call to start a request that may raise the Owner's approval popup.

Past the session gate, **what** the caller may do is decided per route, by the extractor the handler takes. A handler never names the router state. `Scoped<F>` builds a capability only when the caller's claims cover its scopes; `Authenticated<F>` builds one from the claims whole, for a caller acting on its own session; and [`Live<F>`](<HTTP/Extractors Explanation.md#item-Live>) builds one from the state alone, for the front door, whose capabilities are gated by the proofs their methods take. A failure comes back as a domain error, and [Errors and Wire Shapes](<HTTP/Errors and Wire Shapes Explanation.md>) renders it.

## `http`

The middleware, the extractors and the routes are private to this module. What the crate exports from it is the router, the state, the bearer gate and its `ensure_bearer_header` helper, and the browser-session cookie functions the host's cookie-to-bearer layer calls (see [Browser Session Cookie](<HTTP/Browser Session Cookie Explanation.md>)). Every [integration test](<Integration Tests Explanation.md>) spins the router up over an in-memory store.

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs router}}

### `documented_public_router`

The router passes a closure that layers the start limit; the spec passes one that leaves the routes as they are. So the spec the tests snapshot and the routes that serve traffic are the same routes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs documented_public_router}}

### `ApiDoc`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs ApiDoc}}

### `documented_authorization_router`

The router passes a closure that layers the deferred start limit on the ask-owner route; the spec passes one that leaves it as it is.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs documented_authorization_router}}

### `documented_router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs documented_router}}

### `openapi_spec`

A change to a wire type fails the snapshot test until the snapshot is regenerated, so the TypeScript client and the server-docs console never read a stale spec.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/mod.rs openapi_spec tests="openapi_tests::openapi_spec_snapshot_is_up_to_date"}}

## `http::state`

`AuthorizationServerState` is defined with the [live bindings](<Assembly/Live Bindings Explanation.md>), not here, so that the capabilities in `domain/` can be built from it without `domain/` depending on `http`. `state.rs` re-exports it as `crate::http::state::AuthorizationServerState`.

## Pages

- [Browser Session Cookie](<HTTP/Browser Session Cookie Explanation.md>): the `__Host-browser_session` cookie, how it is set and cleared, and how a request's cookie becomes a standing session.
- [Errors and Wire Shapes](<HTTP/Errors and Wire Shapes Explanation.md>): how failures render, and the JSON bodies shared across routes.
- [Extractors](<HTTP/Extractors Explanation.md>): `Live<F>` and the launcher's pages.
- [Middleware](<HTTP/Middleware Explanation.md>): the session gate, the bearer gate, the start limit, cache suppression.
- [Routes](<HTTP/Routes Explanation.md>): every handler, by path.
- [Test Fixtures](<HTTP/Test Fixtures Explanation.md>): the helpers the HTTP unit tests share.
