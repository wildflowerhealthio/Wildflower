# Device Authorizer

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs}}

A device with no browser of its own can't send the Owner to a consent card. It asks through the device flow (RFC 8628) instead. It calls `POST /oauth/device_authorization` and gets two codes back: a secret `device_code` it keeps and polls `/oauth/token` with, and a short `user_code` the Owner confirms at the server's device page. The device authorizer starts that flow. It parks a pending [authorization request](<../../Domain/Authorization Request Explanation.md>) of the device kind and raises the Owner's notification.

**Starting a device authorization grants nothing.** The scopes it records are what the device asked for. The Owner's approval at the device page decides what the device gets, and the token poll ([`exchange_device_code`](<Token Exchanger Explanation.md#exchange_device_code>)) mints it. Only an app that has [authenticated](<Client Authenticator Explanation.md#authenticate>) may start one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer}}

It holds the store, the port that republishes the Owner's newest pending consent, and the URL of the device page. `new` builds it from those handles, lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::new}}

## `DEVICE_AUTHORIZATION_TTL`

**The Owner has five minutes to approve.** A device request expires five minutes after it starts. A browser pairing, which reuses the device flow's codes and page, gets the same five minutes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DEVICE_AUTHORIZATION_TTL}}

## `device_page`

The device page, where the Owner enters or confirms a `user_code`: RFC 8628's `verification_uri`. The authorizer doesn't read it itself; the route builds the response's `verification_uri` and `verification_uri_complete` from it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::device_page}}

No unit test of its own. Exercised end to end by [`device_authorization_happy_path`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_happy_path>) and [`verification_uri_complete_serves_the_device_page_on_the_server_origin`](<../../Integration Tests/Device Page Explanation.md#verification_uri_complete_serves_the_device_page_on_the_server_origin>).

## The unique `user_code`

**A new `user_code` collides with no request already stored**, pending or settled, device or pairing. The device page looks a request up by its `user_code`, so a stale denied or expired row holding the same code could shadow the new one. Ten random candidates are tried, a generous number for the code's alphabet and length; when every one collides, nothing is started. Browser pairing draws its codes here too.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs generate_unique_user_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs MAX_USER_CODE_GENERATION_ATTEMPTS}}

## `start`

The device asks for scopes, under the name it gives itself (`Kitchen iPad`) or, failing that, one the route infers from its `User-Agent`, or under no name.

1. **A scope outside the app's registration refuses the whole request**, before anything is written: `invalid_scope`. The check is by coverage, so a broad registered scope admits a narrower request it covers ([`allows_scopes`](<../../Domain/Client Explanation.md#allows_scopes>)). Unlike `/oauth/authorize`, the device door doesn't park an out-of-registration request for the Owner.
2. The `device_code` is a 256-bit random token, like an authorization code.
3. In one **write** scope, a unique `user_code` is drawn and the request is parked, pending, under the `device_code` as its id, for the five-minute TTL. It records the requested scopes and the device's name. A device that gives no name is approved under the app's own name ([`device_grant_name`](<../../Domain/Authorization Request Explanation.md#device_grant_name>)).
4. After the scope closes, the newest pending consent is republished, so the host notifies the Owner of the new request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizer::start}}

The device gets its codes back, with the TTL and the poll interval in seconds. The route adds the verification URIs.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceCodes}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs DeviceAuthorizationError}}

### Test fixtures

`device_page` is a page URL the authorizer is built with; `start` never reads it. `authenticated` is the app `app`, registered for `patient/*.rs` and `openid`, authenticated through the fake store's `authenticated_public_client`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::device_page}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::authenticated}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::start_parks_a_pending_request_and_raises_the_popup}}

A request for `patient/Patient.r openid`, which `patient/*.rs` covers, answers the five-minute TTL and the poll interval. The parked request, found by its `user_code`, is exactly a fresh pending device request under the `device_code`, carrying the device's name. The Owner's notification is raised once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs tests::start_refuses_a_scope_outside_the_allowlist}}

A request for `system/*.cruds` is `ScopeNotAllowed`, and nobody is notified.

Exercised end to end by [`device_authorization_happy_path`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_happy_path>), [`device_authorization_allows_scope_covered_by_client_wildcard`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_allows_scope_covered_by_client_wildcard>) and [`device_authorization_carries_device_name_to_consent`](<../../Integration Tests/Device Code Explanation.md#device_authorization_carries_device_name_to_consent>).
