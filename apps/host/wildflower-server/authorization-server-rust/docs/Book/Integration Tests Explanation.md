# Integration Tests

The domain chapters show each rule on its own, against the fake store. The integration tests hold the whole server to its promises through the surface the outside world sees: HTTP. **Each test is one promise**, stated in the terms an app, a browser or the Owner would use ("a disabled client is refused", "a launch works once"), and checked by sending requests to the real router over a real database.

Nothing listens on a port. Each test builds the server's `axum` router over a fresh in-memory SQLite database, sends it requests one at a time with `tower`'s `oneshot`, and reads the responses. Every store, migration, seed, capability and route is the production one. The stand-ins are few: the database lives in memory, the tests mint their own tokens instead of earning them through a flow, and the authorization start gate admits everything unless a test passes its own.

## How they are run

All the files under `tests/integration/` build into one test binary, `integration`. Its `main.rs` only declares the modules, one per file, plus {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/main.rs common}}, the harness this page explains.

```sh
cargo test -p wildflowerhealthio-authorization-server --test integration
```

Every test file starts with `use crate::common::*;`. `common.rs` re-exports what the tests need from the crate (the domain types, the store traits, `setup_authorization_server`) along with `axum`, `chrono`, `serde_json` and `url`, so a test file names the server's own types without importing them.

## How to read the sub-chapters

Each sub-chapter covers one test file. It opens with the part of the server's promise that file holds it to, then gives each test a section: the promise first, then the test, then links to the domain sections the promise rests on. Read the domain chapters first; these chapters assume them.

The tests lean on the helpers below. A sub-chapter links a helper here rather than repeating it, so this page is the one place each is explained.

## Test fixtures

### `spin_up`

The start of almost every test. It sets up a fresh server over a fresh in-memory database and hands back three things: the server (its `router`, and the in-process handles the host would hold), an Owner token ([`mint_owner_token`](#mint_owner_token)), and the [`TestDb`](#testdb) the test reaches the database through. Before returning it pairs one browser for the test to make requests in ([`paired_browser_session`](#paired_browser_session)).

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up}}

### `spin_up_with_authorization_start_gate`

[`spin_up`](#spin_up) with the authorization start gate the test chooses, for the tests of the start limit. The config names the test origins (see [Constants](#constants)), the newest pending consent is published on a watch channel the test keeps, and the shared revocation store gets its own in-memory connection. `setup_authorization_server` runs the same bootstrap as the host: migrations, the signing key, the essential clients.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up_with_authorization_start_gate}}

### `TestDb`

The test's hold on the database the running router uses: the diesel pool behind the grant store, the connection behind the revocation store, and the receiving end of the pending-consent channel. It also carries the browser [`spin_up`](#spin_up) paired. That browser's session holds `wildflower/launch` and every FHIR scope, so it falls short of no FHIR request, but it can't decide consents, so a request made in it parks on the wait page.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TestDb}}

### `store_handle`

A second grant store on the same pool as the router. Tests use it to seed clients and to plant rows the HTTP surface can't make on demand, such as a request that has already expired, so the expiry paths run without sleeping. They also read through it to check what a request wrote.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs store_handle}}

### `revocation_store_handle`

The same, for the shared revocation store: a second handle on its connection, to plant revocations or check that one was written.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs revocation_store_handle}}

### `newest_pending_consent`

What the host would be asking the Owner about right now: the latest value on the pending-consent channel. It is how a test tells "the request was parked" from "the request was parked and the Owner was asked".

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs newest_pending_consent}}

### `seed_client_with_redirect`

Registers a public client, trusted on first use, with one allowed redirect and the given scopes. A client whose redirect is registered is the one case where an `/oauth/authorize` failure is sent back to the app instead of rendered locally, so the redirect-back tests need it. Its name, `Integration Test Client`, is what the Owner is shown.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_client_with_redirect}}

### `seed_test_client`

Registers [`TEST_CLIENT_ID`](#constants): a public client, trusted on first use, allowed every grant type and `system/*.cruds`, with no redirect. The device-flow and token-endpoint tests run as it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_test_client}}

### `seed_confidential_client`

Registers a confidential client whose stored secret hash matches the plaintext the test passes, so the test can authenticate as it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_confidential_client}}

### `spin_up_with_confidential_client`

[`spin_up`](#spin_up) plus [`CONFIDENTIAL_CLIENT_ID`](#constants), allowed `read` and `offline_access`, and a live refresh token for it, `conf-token`. A refresh is the cheapest real grant, so the client-authentication tests present their credentials with one.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up_with_confidential_client}}

### `plant_authorization_code`

Writes an approved code-flow request and its redeemable code straight to the store, made in the browser session `sid`. The request is approved through the domain's own transition, and the code's challenge is the real digest of [`CODE_VERIFIER`](#constants), so `/oauth/token` can redeem it. The caller picks `expires_at`, which both rows share, so a test can plant a code that has already expired.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_authorization_code}}

### `plant_device_request`

Writes a device-code request with user code `WILD-FLWR` in whichever status the test names, moved there through the domain's transitions (approved and claimed ones grant the requested scopes). With `expires_at` it stands up the approved, claimed or expired rows a device poll meets, without a device or an Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_device_request}}

### `plant_refresh_token`

Writes a refresh family for the client, scoped `read` and `offline_access`, with one live token whose plaintext the test holds. The family's deadline is the caller's, so expiry is tested without waiting.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_refresh_token}}

## Tokens and browser sessions

The tests mint their tokens directly, with the signing key the server seeded, rather than earning them through a flow. Unless a test asks otherwise, each names the server's origin as `iss` and `aud`, as every token the server mints does, so the bearer gates accept it.

### `mint_owner_token`

The Owner's token: issued to [`OWNER_TOKEN_CLIENT_ID`](#constants) and holding the Owner's scopes, which pass every `/authorization/*` scope gate. That client is one no test revokes or disables, so the Owner's token outlives whatever a test does to other clients.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_owner_token}}

### `mint_client_token`

A 15-minute token for any client, carrying exactly the scopes given, under no browser session. It and [`mint_browser_session_token`](#mint_browser_session_token) share one private minter:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_client_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_token_under_session}}

### `mint_browser_session_token`

A token for the browser-session client under the browser session `sid`: what a browser carries when its session holds `scopes` rather than the Owner's.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_browser_session_token}}

### `mint_scoped_token`

A token that is not the Owner's: issued to `scoped-app` and authorized for exactly `scopes`. It authenticates, so a gate that refuses it refuses on scope, which is how the scope-gating tests reach the `403` a real app's token would.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_scoped_token}}

### `mint_token_naming`

The same, with the `iss` and `aud` the test chooses: a token signed by this server's key but not minted for it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_token_naming}}

### `paired_browser_session`

A browser the Owner paired, holding `wildflower/launch` and `system/*.cruds`. It holds no `wildflower/` resource scope, so it can't decide consents. Returns the session's `sid` and a token minted under it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs paired_browser_session}}

### `paired_browser_session_holding`

A paired browser holding the scopes the test names: a 24-hour session for "Firefox on Linux", written to the store, and a token under it with the same scopes. A code earned by a request made in it carries only what those scopes allow, which is how the session-shortfall tests get a browser that holds less than an app asks for.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs paired_browser_session_holding}}

### `browser_session_cookie`

The `Cookie` header a browser holding a browser session token sends.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs browser_session_cookie}}

### `sign_in`

`GET /oauth/sign-in` with a sign-in `code` and the `next` page, as the browser the host opened sends it, with no cookie.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs sign_in}}

### `browser_session_token`

The token in the one `Set-Cookie` a sign-in answers with: the value of the `__Host-browser_session` cookie. It panics on any other number of cookies.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs browser_session_token}}

### `signed_in_owner_session_token`

A browser signed in as the Owner, the real way: a same-device sign-in code from the server's own minter, redeemed at [`sign_in`](#sign_in). Returns the session token its cookie holds.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs signed_in_owner_session_token}}

### `signed_in_session_token_that_cannot_decide`

A signed-in browser whose session can't decide consents. It signs in as the Owner, then mints a token under that session's `sid` holding `wildflower/AuthorizationRequest.r`, `wildflower/launch` and every FHIR scope. It can read authorization requests but not update them, and deciding takes both.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs signed_in_session_token_that_cannot_decide}}

## Driving an app's request

These walk an authorization-code request through the pages a browser and the Owner see.

### `authorize_query`

The `/oauth/authorize` query for a client and scope, with the shared `https://app.example/cb` redirect, `state=xyz`, and the real S256 challenge of [`CODE_VERIFIER`](#constants). PKCE passes, so a request built from it gets as far as the registration checks.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs authorize_query}}

### `get_authorize`

`GET /oauth/authorize` from a browser holding the given session token, usually the paired browser's ([`TestDb`](#testdb)).

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorize}}

### `get_authorize_without_session`

The same from a browser with no browser session, which the server sends to pairing.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorize_without_session}}

### `parked_request_id`

Asserts the response parks the browser on the wait page, a `302` to `authorize/{id}/wait`, and returns the request id. It is the shape of every `/oauth/authorize` request left waiting for the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs parked_request_id}}

### `polling_request_id`

The request id a wait-page `Location` names, resolved against `/oauth/authorize` as the browser resolves it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs polling_request_id}}

### `get_authorization_status`

The wait page's poll, `GET /oauth/authorize/{request_id}`, from the browser holding the given session token.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorization_status}}

### `limited_request_id`

Asserts the response sends the browser to the limited page, a `302` to `authorize/{id}/limited`, and returns the request id: a request whose browser session holds less than it asks for.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs limited_request_id}}

### `get_session_shortfall`

The limited page's read of what the session lacks, `GET /oauth/authorize/{request_id}/session-shortfall`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_session_shortfall}}

### `post_session_shortfall`

The limited page's Continue or Cancel, `POST /oauth/authorize/{request_id}/{action}`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_session_shortfall}}

### `continue_past_session_shortfall`

Presses Continue, asserts `200`, and returns the `location` the page is told to go to next.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs continue_past_session_shortfall}}

### `get_oauth_consent`

The Owner's view of a request, `GET /authorization/oauth-consents/{request_id}` with the Owner's token. Asserts `200` and returns the prompt's JSON.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_oauth_consent}}

### `approve_oauth_consent`

The Owner's Approve, `POST /authorization/oauth-consents/{request_id}/approve` with the JSON body the test writes. Returns the response for the test to judge.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs approve_oauth_consent}}

### `authorize_and_approve`

One request from start to approval: `/oauth/authorize` in the given browser, which must park it on the wait page, then the Owner approves it with the given body. Returns the request id. Tests use it to set up what an approval leaves behind (a grant, the fast path for the next request, a refresh family); the flow itself is held to its promise in [Grant Flows](<Integration Tests/Grant Flows Explanation.md>). The body carries `acknowledgedRegistration` like any real approval, but callers seed a client whose registration already covers the request, so the flag doesn't matter.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs authorize_and_approve}}

## Driving other endpoints

### `post_form`

A form-encoded `POST`, the body `/oauth/token` takes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_form}}

### `post_form_with_authorization`

The same with an `Authorization` header, for a client that authenticates with HTTP Basic.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_form_with_authorization}}

### `basic_authorization`

The `Authorization` header value for `client_secret_basic`: `Basic` and the base64 of `client_id:client_secret`, neither half percent-encoded.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs basic_authorization}}

### `owner_grants_probe`

The smallest call behind the Owner's bearer gate, `GET /authorization/grants`. A test sends it to ask "does this token still authenticate?".

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs owner_grants_probe}}

### `owner_revocation_request`

`POST /authorization/revocations` with the given token and JSON body.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs owner_revocation_request}}

### `patch_client`

`PATCH /authorization/clients/{client_id}` with the given token and JSON body.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs patch_client}}

### `disable_client`

Disables a client as of `at`, sent as the UTC string the launcher sends.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs disable_client}}

### `enable_client`

Enables a client again, sending `disabledAt: null`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs enable_client}}

## Reading responses

### `assert_cache_suppressed`

Asserts a response carries `Cache-Control: no-store` and `Pragma: no-cache`, each exactly once. `what` names the response in the failure message.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs assert_cache_suppressed}}

### `decode_jwt_payload`

A token's claims as JSON, read from its middle segment without checking the signature: enough to assert what a token says.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs decode_jwt_payload}}

### `jti_of`

A token's `jti`, the handle a revocation names it by.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs jti_of}}

### One-liners

| Helper                                                                                                             | What it does                                              |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs build_request}}     | A request from a builder and a body, ready for `oneshot`. |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs body_json}}         | Reads a whole response body as JSON.                      |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs body_string}}       | Reads a whole response body as text.                      |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs location_of}}       | A response's `Location` header, which must be there.      |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs set_cookie_values}} | Every `Set-Cookie` value on a response, in order.         |

## Constants

| Constant                                                                                                                    | Value and meaning                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs SERVER_ORIGIN}}              | `https://ruth.relay.example`: the server's origin, the `iss` and `aud` of every token it mints and the only ones its bearer gates accept. |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs LAUNCHER_BASE}}              | The hosted launcher's address in these tests, not the production one, so an assertion can't pass against a hard-coded address.            |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs AUTHORIZATION_APP_BASE}}     | The hosted Authorization app's address in these tests, likewise not the production one.                                                   |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs LAUNCHER_URL}}               | The page the host opens this server's launches in.                                                                                        |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs AUTHORIZATION_URL}}          | The page the host opens this server's Authorization app at.                                                                               |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs OWNER_TOKEN_CLIENT_ID}}      | `integration-test-owner-app`, the client the Owner's token is issued to.                                                                  |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TEST_CLIENT_ID}}             | `integration-test-app`, the client [`seed_test_client`](#seed_test_client) registers.                                                     |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TEST_CLIENT_SCOPE}}          | `system/*.cruds`, the scope that client is allowed: as broad as the Owner's FHIR access.                                                  |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CODE_VERIFIER}}              | The PKCE verifier the code-flow tests share: 43 characters, the shortest RFC 7636 allows. Their challenges are its real S256 digest.      |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CONFIDENTIAL_CLIENT_ID}}     | `conf-app`, the confidential client [`spin_up_with_confidential_client`](#spin_up_with_confidential_client) registers.                    |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CONFIDENTIAL_CLIENT_SECRET}} | That client's secret.                                                                                                                     |
| {{#code-link apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CHROME_MAC_USER_AGENT}}      | A desktop Chrome on macOS `User-Agent`, for the device-flow tests that name a device from its user agent.                                 |
