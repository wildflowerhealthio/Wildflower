# OAuth Router

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs}}

Everything under `/oauth` is reached **before anyone holds a bearer token**. An app's browser arrives at the front door, an app's back end trades a code for tokens, a device asks for a code to show its user, a browser asks to be paired. None of them is the Owner, so none of these routes sits behind the `/authorization` session gate. Each answers its caller from what the request itself proves: a browser session cookie, a client's credentials, a code.

The `oauth` folder holds two route tables, mounted side by side under the same prefix. **The API table is documented; the page table isn't.** An app or a device talks to the API routes, and the OpenAPI spec is collected from them. A browser shows the pages, which are no API surface, so they stay out of the spec.

## `OAUTH_MOUNT`

The prefix both tables are mounted under. A URL built for one of their routes, such as the [device page](<Authorization Pages Explanation.md#device_page_url>) or the limited page's next stop, names the same prefix, so a route and the links to it can't drift apart.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs OAUTH_MOUNT}}

## `openapi_router`

The API routes, as an `OpenApiRouter`, so the spec comes from the very handlers that serve traffic. Each `routes!` reads its handler's `#[utoipa::path]` for the method and the path.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs openapi_router}}

| Route                                         | Handler                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /oauth/authorize`                        | [`handle_authorize_request`](<Authorize Explanation.md#handle_authorize_request>)                                  |
| `GET /oauth/authorize/{id}`                   | [`handle_authorization_status_request`](<Authorization Pages Explanation.md#handle_authorization_status_request>)  |
| `GET /oauth/authorize/{id}/session-shortfall` | [`handle_session_shortfall_read`](<Authorization Pages Explanation.md#handle_session_shortfall_read>)              |
| `POST /oauth/authorize/{id}/continue`         | [`handle_session_shortfall_continue`](<Authorization Pages Explanation.md#handle_session_shortfall_continue>)      |
| `POST /oauth/authorize/{id}/cancel`           | [`handle_session_shortfall_cancel`](<Authorization Pages Explanation.md#handle_session_shortfall_cancel>)          |
| `POST /oauth/token`                           | [`handle_token_request`](<Token Endpoint Explanation.md#handle_token_request>)                                     |
| `POST /oauth/revoke`                          | [`handle_token_revocation_request`](<Token Endpoint Explanation.md#handle_token_revocation_request>)               |
| `POST /oauth/device_authorization`            | [`handle_device_authorization_request`](<Device Authorization Explanation.md#handle_device_authorization_request>) |
| `POST /oauth/pair/start`                      | [`handle_browser_pairing_start`](<Pairing and Sign In Explanation.md#handle_browser_pairing_start>)                |
| `POST /oauth/pair/poll`                       | [`handle_browser_pairing_poll`](<Pairing and Sign In Explanation.md#handle_browser_pairing_poll>)                  |

**Two routes start an authorization request, and only those two are limited.** `limit_authorization_starts` wraps `/authorize` and `/device_authorization`, each named by its `AuthorizationStartRoute`. Anyone who knows the server's domain can start a request, and a request raised for the Owner pops up on the Owner's device; the limit keeps a stranger from flooding it. Wrapping the method router rather than the handler covers every method axum serves the path on, `HEAD /oauth/authorize` included. The serving router passes the real layer, [`limit_authorization_starts`](<../Middleware Explanation.md#limit_authorization_starts>); the spec, which serves nothing, passes the routes through unchanged.

Exercised end to end by [`no_other_route_asks_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#no_other_route_asks_the_gate>) and [`head_authorize_asks_the_gate`](<../../Integration Tests/Authorization Start Limit Explanation.md#head_authorize_asks_the_gate>).

## `page_router`

The browser's pages: the wait page and its two files, the React authorization pages (the consent card, the limited page, the device page, the pairing page) and their assets, the Owner's same-device sign-in, and a browser's sign-out.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/mod.rs page_router}}

`launcher_base` is where a sign-out sends the browser. The authorization pages need it too: their **Sign out** form must be allowed to follow that redirect, so their content security policy names the launcher's origin ([`authorization_pages::router`](<Authorization Pages Explanation.md#authorization_pagesrouter>)).

| Route                                                                                                                                         | Served by                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /oauth/authorize/{id}/wait`, `GET /oauth/authorize/wait.js`, `GET /oauth/authorize/wait.css`                                             | [`wait_page::router`](<Authorization Pages Explanation.md#wait_pagerouter>)                     |
| `GET /oauth/authorize/{id}/consent`, `GET /oauth/authorize/{id}/limited`, `GET /oauth/device`, `GET /oauth/pair`, `GET /oauth/assets/{*file}` | [`authorization_pages::router`](<Authorization Pages Explanation.md#authorization_pagesrouter>) |
| `GET /oauth/sign-in`                                                                                                                          | [`handle_sign_in`](<Pairing and Sign In Explanation.md#handle_sign_in>)                         |
| `POST /oauth/sign-out`                                                                                                                        | [`handle_sign_out`](<Pairing and Sign In Explanation.md#handle_sign_out>)                       |

The HTTP layer's [`router`](<../../HTTP Explanation.md#router>) mounts both tables.

## The spec's request bodies

The token-style handlers parse a body without client credentials: the [`TokenRequest`](<Token Endpoint Explanation.md#tokenrequest>) extractor reads `client_id` and `client_secret` from the same form body, or from `Authorization: Basic`, on its own. What arrives on the wire still carries them, so the spec models each body with the credentials put back. These types are never built; they exist for `#[utoipa::path]` to name.

`POST /oauth/token`'s body is a union tagged by `grant_type`, one variant per grant the endpoint takes:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs TokenRequestBody}}

`POST /oauth/device_authorization` takes an optional `scope` and the non-standard `device_name`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs DeviceAuthorizationRequest}}

`POST /oauth/revoke` takes the token and an optional `token_type_hint`, which the server accepts and never reads:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs TokenRevocationRequestBody}}

The `404` an unknown authorization request gets, from the status poll and from the limited page's calls, is `{ "error": "AuthorizationRequestNotFound", "id": … }`. It has no Rust type of its own, so the spec models it here too:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/openapi.rs AuthorizationRequestNotFound}}

## The pages in this part

- [Authorize](<Authorize Explanation.md>): the front door, `GET /oauth/authorize`.
- [Authorization Pages](<Authorization Pages Explanation.md>): what a browser is shown while its request waits, and the calls those pages make.
- [Pairing and Sign-In](<Pairing and Sign In Explanation.md>): how a browser comes to hold a browser session, and how it gives one up.
- [Device Authorization](<Device Authorization Explanation.md>): a device asking for a code to show its user.
- [Token Endpoint](<Token Endpoint Explanation.md>): an app's back end trading a code, a device code or a refresh token for tokens, and revoking a token.
