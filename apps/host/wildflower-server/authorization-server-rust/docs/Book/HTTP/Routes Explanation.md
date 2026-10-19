# Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/mod.rs}}

The routes are where a caller meets the server. **Each handler is thin**: it reads the request, takes the capability its extractor grants ([`Live`](<Extractors Explanation.md#live>) for an operation anyone may ask for, `Scoped` or `Authenticated` for one that wants a bearer), calls one operation, and renders the outcome. The rules live below it, in the capabilities and the domain; what a route adds is who may call it and what each outcome looks like on the wire.

The folder tree mirrors the URL tree. A path with one route is a file named for its operation (`well_known_jwks`, `logout`, `revocations`, `session`). A segment with several routes is a folder whose `mod.rs` is its route table (`oauth`, `oauth_consents`, `devices`, `grants`, `clients`, `browser_sessions`), with one file per handler.

## Two surfaces

The HTTP layer's [`router`](<../HTTP Explanation.md#router>) mounts the routes in two groups, and **the group decides the gate**.

- **`/.well-known/jwks.json` and `/oauth/*` are reached before anyone holds a token.** They answer what the request itself proves: a browser session cookie, a client's credentials, a code. The [OAuth router](<Routes/OAuth Router Explanation.md>) splits them into documented API routes and a browser's pages. The two routes that start an authorization request are wrapped in the [start limit](<Middleware Explanation.md#limit_authorization_starts>).
- **`/authorization/*` is the Owner's surface.** Every route sits behind [`require_valid_session`](<Middleware Explanation.md#require_valid_session>), which wants a valid, unrevoked bearer, and [`cache_suppress`](<Middleware Explanation.md#cache_suppress>), so no answer is cached, the gate's `401`s included. Most routes then demand a scope through their `Scoped<…>` capability, a `403` naming what is missing when the bearer lacks it. Two are self-service, `Authenticated<…>`, and need only the valid bearer.

Who calls `/authorization/*`: the Owner's UI on its bearer, and the server's own consent card and device page on the browser session's bearer, which the host's cookie-to-bearer layer presents for them.

## Before a token

| Method | Path                                      | Who calls it                               | Handler                                                                                                                   | Through                                                      |
| ------ | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/.well-known/jwks.json`                  | anyone checking a token this server signed | [`handle_jwks_request`](<Routes/Session Routes Explanation.md#handle_jwks_request>)                                       | `LivePublicKeysReader`                                       |
| GET    | `/oauth/authorize`                        | an app, sending the person's browser       | [`handle_authorize_request`](<Routes/Authorize Explanation.md#handle_authorize_request>)                                  | `LiveCodeAuthorizationStarter`, the start limit              |
| GET    | `/oauth/authorize/{id}`                   | the wait page                              | [`handle_authorization_status_request`](<Routes/Authorization Pages Explanation.md#handle_authorization_status_request>)  | `LiveAuthorizationStatusReader`, the browser session cookie  |
| GET    | `/oauth/authorize/{id}/session-shortfall` | the limited page                           | [`handle_session_shortfall_read`](<Routes/Authorization Pages Explanation.md#handle_session_shortfall_read>)              | `LiveSessionShortfall`, the browser session cookie           |
| POST   | `/oauth/authorize/{id}/continue`          | the limited page                           | [`handle_session_shortfall_continue`](<Routes/Authorization Pages Explanation.md#handle_session_shortfall_continue>)      | `LiveCodeAuthorizationStarter`, the browser session cookie   |
| POST   | `/oauth/authorize/{id}/cancel`            | the limited page                           | [`handle_session_shortfall_cancel`](<Routes/Authorization Pages Explanation.md#handle_session_shortfall_cancel>)          | `LiveSessionShortfall`, the browser session cookie           |
| POST   | `/oauth/token`                            | an app's back end, a device                | [`handle_token_request`](<Routes/Token Endpoint Explanation.md#handle_token_request>)                                     | `TokenRequest` (client authentication), `LiveTokenExchanger` |
| POST   | `/oauth/revoke`                           | an app's back end                          | [`handle_token_revocation_request`](<Routes/Token Endpoint Explanation.md#handle_token_revocation_request>)               | `TokenRequest`, `LiveClientTokenRevoker`                     |
| POST   | `/oauth/device_authorization`             | a device                                   | [`handle_device_authorization_request`](<Routes/Device Authorization Explanation.md#handle_device_authorization_request>) | the start limit, `TokenRequest`, `LiveDeviceAuthorizer`      |
| POST   | `/oauth/pair/start`                       | the pairing page                           | [`handle_browser_pairing_start`](<Routes/Pairing and Sign In Explanation.md#handle_browser_pairing_start>)                | `LiveBrowserPairing`                                         |
| POST   | `/oauth/pair/poll`                        | the pairing page                           | [`handle_browser_pairing_poll`](<Routes/Pairing and Sign In Explanation.md#handle_browser_pairing_poll>)                  | `LiveBrowserPairing`                                         |

The browser's pages, kept out of the OpenAPI spec:

| Method | Path                                                                                  | Who calls it                                | Served by                                                                                              | Through                                               |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| GET    | `/oauth/authorize/{id}/wait`, `/oauth/authorize/wait.js`, `/oauth/authorize/wait.css` | a browser parked while the Owner decides    | [`wait_page::router`](<Routes/Authorization Pages Explanation.md#wait_pagerouter>)                     | static files                                          |
| GET    | `/oauth/authorize/{id}/consent`, `/oauth/authorize/{id}/limited`                      | a browser `/oauth/authorize` sent there     | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#authorization_pagesrouter>) | static files                                          |
| GET    | `/oauth/device`                                                                       | the Owner, from a device's code             | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#authorization_pagesrouter>) | static files                                          |
| GET    | `/oauth/pair`                                                                         | a browser without a session                 | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#authorization_pagesrouter>) | static files                                          |
| GET    | `/oauth/assets/{*file}`                                                               | the pages above                             | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#authorization_pagesrouter>) | static files                                          |
| GET    | `/oauth/sign-in`                                                                      | the base app, opening the Owner's browser   | [`handle_sign_in`](<Routes/Pairing and Sign In Explanation.md#handle_sign_in>)                         | `LiveSameDeviceSignIn`                                |
| POST   | `/oauth/sign-out`                                                                     | the **Sign out** form on the server's pages | [`handle_sign_out`](<Routes/Pairing and Sign In Explanation.md#handle_sign_out>)                       | `LiveBrowserSessionEnder`, the browser session cookie |

## The Owner's surface

Every path here is under `/authorization`.

| Method | Path                             | Who calls it                      | Handler                                                                                                        | Capability (scope)                                                                  |
| ------ | -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/oauth-consents/{id}`           | the consent card, the Owner's UI  | [`handle_get_oauth_consent`](<Routes/Consent Routes Explanation.md#handle_get_oauth_consent>)                  | `LiveConsentReader` (`wildflower/AuthorizationRequest.r`)                           |
| POST   | `/oauth-consents/{id}/approve`   | the consent card, the Owner's UI  | [`handle_approve_oauth_consent`](<Routes/Consent Routes Explanation.md#handle_approve_oauth_consent>)          | `LiveConsentDecider` (`wildflower/AuthorizationRequest.u`)                          |
| POST   | `/oauth-consents/{id}/deny`      | the consent card, the Owner's UI  | [`handle_deny_oauth_consent`](<Routes/Consent Routes Explanation.md#handle_deny_oauth_consent>)                | `LiveConsentDecider` (`wildflower/AuthorizationRequest.u`)                          |
| POST   | `/oauth-consents/{id}/ask-owner` | the consent card                  | [`handle_ask_owner`](<Routes/Consent Routes Explanation.md#handle_ask_owner>)                                  | `LiveConsentRaiser` (`wildflower/AuthorizationRequest.r`), the deferred start limit |
| GET    | `/devices/{userCode}`            | the device page                   | [`handle_get_device_consent`](<Routes/Consent Routes Explanation.md#handle_get_device_consent>)                | `LiveConsentReader` (`wildflower/AuthorizationRequest.r`)                           |
| POST   | `/devices/{userCode}/approve`    | the device page                   | [`handle_approve_device_consent`](<Routes/Consent Routes Explanation.md#handle_approve_device_consent>)        | `LiveConsentDecider` (`wildflower/AuthorizationRequest.u`)                          |
| POST   | `/devices/{userCode}/deny`       | the device page                   | [`handle_deny_device_consent`](<Routes/Consent Routes Explanation.md#handle_deny_device_consent>)              | `LiveConsentDecider` (`wildflower/AuthorizationRequest.u`)                          |
| GET    | `/grants`                        | the Owner's UI                    | [`handle_list_grants`](<Routes/Owner Resource Routes Explanation.md#handle_list_grants>)                       | `LiveGrantsReader` (`wildflower/Grant.r`)                                           |
| GET    | `/grants/{id}`                   | the Owner's UI                    | [`handle_get_grant`](<Routes/Owner Resource Routes Explanation.md#handle_get_grant>)                           | `LiveGrantsReader` (`wildflower/Grant.r`)                                           |
| DELETE | `/grants/{id}`                   | the Owner's UI                    | [`handle_revoke_grant`](<Routes/Owner Resource Routes Explanation.md#handle_revoke_grant>)                     | `LiveGrantsRevoker` (`wildflower/Grant.d`)                                          |
| GET    | `/clients`                       | the Owner's UI                    | [`handle_list_clients`](<Routes/Owner Resource Routes Explanation.md#handle_list_clients>)                     | `LiveClientsReader` (`wildflower/Client.r`)                                         |
| PATCH  | `/clients/{clientId}`            | the Owner's UI                    | [`handle_update_client`](<Routes/Owner Resource Routes Explanation.md#handle_update_client>)                   | `LiveClientsDisabler` (`wildflower/Client.u`)                                       |
| GET    | `/browser-sessions`              | the Owner's UI                    | [`handle_list_browser_sessions`](<Routes/Owner Resource Routes Explanation.md#handle_list_browser_sessions>)   | `LiveBrowserSessionsReader` (`wildflower/BrowserSession.r`)                         |
| DELETE | `/browser-sessions/{sid}`        | the Owner's UI                    | [`handle_revoke_browser_session`](<Routes/Owner Resource Routes Explanation.md#handle_revoke_browser_session>) | `LiveBrowserSessionsRevoker` (`wildflower/BrowserSession.d`)                        |
| POST   | `/revocations`                   | a caller revoking tokens          | [`handle_create_revocation`](<Routes/Session Routes Explanation.md#handle_create_revocation>)                  | `LiveTokenRevoker` (`wildflower/Token.d`)                                           |
| POST   | `/logout`                        | the Owner's UI                    | [`handle_logout`](<Routes/Session Routes Explanation.md#handle_logout>)                                        | `Authenticated<LiveSessionEnder>`, no scope                                         |
| GET    | `/session`                       | any caller, about its own session | [`handle_get_session`](<Routes/Session Routes Explanation.md#handle_get_session>)                              | `Authenticated<LiveSessionReader>`, no scope                                        |

Only the `/clients` routes are documented in the OpenAPI spec; the rest of the Owner's surface isn't yet.

## The pages in this part

- [OAuth Router](<Routes/OAuth Router Explanation.md>): the two `/oauth` route tables, and the request bodies the spec models.
- [Authorize](<Routes/Authorize Explanation.md>): the front door of the code flow.
- [Authorization Pages](<Routes/Authorization Pages Explanation.md>): the wait page, the React pages, the status poll and the limited page's calls.
- [Pairing and Sign-In](<Routes/Pairing and Sign In Explanation.md>): how a browser gets a browser session, and gives it up.
- [Device Authorization](<Routes/Device Authorization Explanation.md>): a device asking for its codes.
- [Token Endpoint](<Routes/Token Endpoint Explanation.md>): client authentication, the token exchange and token revocation.
- [Consent Routes](<Routes/Consent Routes Explanation.md>): reading and deciding a code request or a device request.
- [Owner Resource Routes](<Routes/Owner Resource Routes Explanation.md>): the Owner's grants, apps and browsers.
- [Session Routes](<Routes/Session Routes Explanation.md>): the caller's own session, logout, token revocation and the public keys.
