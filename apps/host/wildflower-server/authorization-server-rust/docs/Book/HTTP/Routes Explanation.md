# Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/mod.rs}}

The routes are where a caller meets the server. **Each handler is thin**: it reads the request, takes the capability its extractor grants ([`Live`](<Extractors Explanation.md#item-Live>) for an operation anyone may ask for, `Scoped` or `Authenticated` for one that wants a bearer), calls one operation, and renders the outcome. The rules live below it, in the capabilities and the domain; what a route adds is who may call it and what each outcome looks like on the wire.

The folder tree mirrors the URL tree. A path with one route is a file named for its operation (`well_known_jwks`, `logout`, `revocations`, `session`). A segment with several routes is a folder whose `mod.rs` is its route table (`oauth`, `oauth_consents`, `devices`, `grants`, `clients`, `browser_sessions`), with one file per handler.

The HTTP layer's [`router`](<../HTTP Explanation.md#item-http--router>) mounts the routes in two groups, and **the group decides the gate**:

- **`/.well-known/jwks.json` and `/oauth/*` are reached before anyone holds a token.** They answer what the request itself proves: a browser session cookie, a client's credentials, a code.
- **`/authorization/*` is the Owner's surface.** Every route sits behind the [session gate](<Middleware Explanation.md#item-require_valid_session>) and [cache suppression](<Middleware Explanation.md#item-cache_suppress>). Most then demand a scope through their `Scoped<…>` capability; the session read and logout are self-service, `Authenticated<…>`. The Owner's UI calls them on its bearer, and the server's own consent card and device page on the browser session's, which the host's cookie-to-bearer layer presents for them.

## Before a token

| Method | Path                                      | Who calls it                                | Handler                                                                                                                        |
| ------ | ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/.well-known/jwks.json`                  | anyone checking a token this server signed  | [`handle_jwks_request`](<Routes/Session Routes Explanation.md#item-handle_jwks_request>)                                       |
| GET    | `/oauth/authorize`                        | an app, sending the person's browser        | [`handle_authorize_request`](<Routes/Authorize Explanation.md#item-handle_authorize_request>)                                  |
| GET    | `/oauth/authorize/{id}`                   | the wait page                               | [`handle_authorization_status_request`](<Routes/Authorization Pages Explanation.md#item-handle_authorization_status_request>)  |
| GET    | `/oauth/authorize/{id}/session-shortfall` | the limited page                            | [`handle_session_shortfall_read`](<Routes/Authorization Pages Explanation.md#item-handle_session_shortfall_read>)              |
| POST   | `/oauth/authorize/{id}/continue`          | the limited page                            | [`handle_session_shortfall_continue`](<Routes/Authorization Pages Explanation.md#item-handle_session_shortfall_continue>)      |
| POST   | `/oauth/authorize/{id}/cancel`            | the limited page                            | [`handle_session_shortfall_cancel`](<Routes/Authorization Pages Explanation.md#item-handle_session_shortfall_cancel>)          |
| GET    | `/oauth/authorize/{id}/wait`              | a browser waiting for the Owner             | [`wait_page::router`](<Routes/Authorization Pages Explanation.md#item-wait_page--router>)                                      |
| GET    | `/oauth/authorize/{id}/consent`           | a browser that decides in place             | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#item-authorization_pages--router>)                  |
| GET    | `/oauth/authorize/{id}/limited`           | a browser whose session falls short         | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#item-authorization_pages--router>)                  |
| GET    | `/oauth/device`                           | the Owner, from a device's code             | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#item-authorization_pages--router>)                  |
| GET    | `/oauth/pair`                             | a browser without a session                 | [`authorization_pages::router`](<Routes/Authorization Pages Explanation.md#item-authorization_pages--router>)                  |
| POST   | `/oauth/token`                            | an app's back end, a device                 | [`handle_token_request`](<Routes/Token Endpoint Explanation.md#item-handle_token_request>)                                     |
| POST   | `/oauth/revoke`                           | an app's back end                           | [`handle_token_revocation_request`](<Routes/Token Endpoint Explanation.md#item-handle_token_revocation_request>)               |
| POST   | `/oauth/device_authorization`             | a device                                    | [`handle_device_authorization_request`](<Routes/Device Authorization Explanation.md#item-handle_device_authorization_request>) |
| POST   | `/oauth/pair/start`                       | the pairing page                            | [`handle_browser_pairing_start`](<Routes/Pairing and Sign In Explanation.md#item-handle_browser_pairing_start>)                |
| POST   | `/oauth/pair/poll`                        | the pairing page                            | [`handle_browser_pairing_poll`](<Routes/Pairing and Sign In Explanation.md#item-handle_browser_pairing_poll>)                  |
| GET    | `/oauth/sign-in`                          | the base app, opening the Owner's browser   | [`handle_sign_in`](<Routes/Pairing and Sign In Explanation.md#item-handle_sign_in>)                                            |
| POST   | `/oauth/sign-out`                         | the **Sign out** form on the server's pages | [`handle_sign_out`](<Routes/Pairing and Sign In Explanation.md#item-handle_sign_out>)                                          |

## The Owner's surface

Every path here is under `/authorization`.

| Method | Path                             | Handler                                                                                                             | Scope                               |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| GET    | `/oauth-consents/{id}`           | [`handle_get_oauth_consent`](<Routes/Consent Routes Explanation.md#item-handle_get_oauth_consent>)                  | `wildflower/AuthorizationRequest.r` |
| POST   | `/oauth-consents/{id}/approve`   | [`handle_approve_oauth_consent`](<Routes/Consent Routes Explanation.md#item-handle_approve_oauth_consent>)          | `wildflower/AuthorizationRequest.u` |
| POST   | `/oauth-consents/{id}/deny`      | [`handle_deny_oauth_consent`](<Routes/Consent Routes Explanation.md#item-handle_deny_oauth_consent>)                | `wildflower/AuthorizationRequest.u` |
| POST   | `/oauth-consents/{id}/ask-owner` | [`handle_ask_owner`](<Routes/Consent Routes Explanation.md#item-handle_ask_owner>)                                  | `wildflower/AuthorizationRequest.r` |
| GET    | `/devices/{userCode}`            | [`handle_get_device_consent`](<Routes/Consent Routes Explanation.md#item-handle_get_device_consent>)                | `wildflower/AuthorizationRequest.r` |
| POST   | `/devices/{userCode}/approve`    | [`handle_approve_device_consent`](<Routes/Consent Routes Explanation.md#item-handle_approve_device_consent>)        | `wildflower/AuthorizationRequest.u` |
| POST   | `/devices/{userCode}/deny`       | [`handle_deny_device_consent`](<Routes/Consent Routes Explanation.md#item-handle_deny_device_consent>)              | `wildflower/AuthorizationRequest.u` |
| GET    | `/grants`                        | [`handle_list_grants`](<Routes/Owner Resource Routes Explanation.md#item-handle_list_grants>)                       | `wildflower/Grant.r`                |
| GET    | `/grants/{id}`                   | [`handle_get_grant`](<Routes/Owner Resource Routes Explanation.md#item-handle_get_grant>)                           | `wildflower/Grant.r`                |
| DELETE | `/grants/{id}`                   | [`handle_revoke_grant`](<Routes/Owner Resource Routes Explanation.md#item-handle_revoke_grant>)                     | `wildflower/Grant.d`                |
| GET    | `/clients`                       | [`handle_list_clients`](<Routes/Owner Resource Routes Explanation.md#item-handle_list_clients>)                     | `wildflower/Client.r`               |
| PATCH  | `/clients/{clientId}`            | [`handle_update_client`](<Routes/Owner Resource Routes Explanation.md#item-handle_update_client>)                   | `wildflower/Client.u`               |
| GET    | `/browser-sessions`              | [`handle_list_browser_sessions`](<Routes/Owner Resource Routes Explanation.md#item-handle_list_browser_sessions>)   | `wildflower/BrowserSession.r`       |
| DELETE | `/browser-sessions/{sid}`        | [`handle_revoke_browser_session`](<Routes/Owner Resource Routes Explanation.md#item-handle_revoke_browser_session>) | `wildflower/BrowserSession.d`       |
| POST   | `/revocations`                   | [`handle_create_revocation`](<Routes/Session Routes Explanation.md#item-handle_create_revocation>)                  | `wildflower/Token.d`                |
| POST   | `/logout`                        | [`handle_logout`](<Routes/Session Routes Explanation.md#item-handle_logout>)                                        | none: self-service                  |
| GET    | `/session`                       | [`handle_get_session`](<Routes/Session Routes Explanation.md#item-handle_get_session>)                              | none: self-service                  |

## Pages

- [OAuth Router](<Routes/OAuth Router Explanation.md>): the two `/oauth` route tables, and the request bodies the spec models.
- [Authorize](<Routes/Authorize Explanation.md>): the front door of the code flow.
- [Authorization Pages](<Routes/Authorization Pages Explanation.md>): the wait page, the React pages, the status poll and the limited page's calls.
- [Token Endpoint](<Routes/Token Endpoint Explanation.md>): client authentication, the token exchange and token revocation.
- [Device Authorization](<Routes/Device Authorization Explanation.md>): a device asking for its codes.
- [Pairing and Sign-In](<Routes/Pairing and Sign In Explanation.md>): how a browser gets a browser session, and gives it up.
- [Consent Routes](<Routes/Consent Routes Explanation.md>): reading and deciding a code request or a device request.
- [Owner Resource Routes](<Routes/Owner Resource Routes Explanation.md>): the Owner's grants, apps and browsers.
- [Session Routes](<Routes/Session Routes Explanation.md>): the caller's own session, logout, token revocation and the public keys.
