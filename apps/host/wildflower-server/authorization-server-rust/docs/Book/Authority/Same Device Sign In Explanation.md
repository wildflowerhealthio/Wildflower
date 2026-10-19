# Same-Device Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs}}

The Owner's browser signs in without a password. The base, the host app on the device that runs the server, mints a one-time [sign-in code](<../Domain/Same Device Sign In Codes Explanation.md>) in-process and opens `GET /oauth/sign-in` with it. **Only the base can mint a code, and the base runs on the server's own device, so redeeming one is proof the browser is on that device, and is the Owner's.**

A **redeemed same-device sign-in code** is that proof. It is the authority an **Owner session** is started under, and its token minted under. The token is issued to the browser-session client and holds the Owner's grant, with which the Owner decides consents on the server's own pages; it names the new session as its `sid`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode}}

What the minter reads off it, through [`TokenEntitlement::SameDeviceSignIn`](<Token Entitlement Explanation.md#tokenentitlement>), are the token's `sub` (the browser-session client), its `scope` (the session's scopes, the Owner's grant as stored) and its `sid`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::client_id}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::token_scopes}}

## Test fixtures

Sessions in the tests last eight hours.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::SESSION_TTL}}

The Owner's grant, as the tests give it: every FHIR resource and every Wildflower resource, all permissions.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::owner_grant}}

## `redeem`

The one constructor. The presented code is [taken](<../Domain/Same Device Sign In Codes Explanation.md#take>) out of the outstanding codes: **a code redeems once**, and an unknown, spent or expired code is no proof, the three alike. A code that redeems starts a new [Owner session](<../Domain/Browser Session Explanation.md#new_owner>) holding the Owner's grant, for the lifetime the caller passes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::redeem}}

The sign-in capability redeems it inside its write scope, then stores the session with the browser-session writer's [`start_owner_session`](<../Writers/Browser Session Writer Explanation.md#start_owner_session>) and mints the session's token with [`mint`](<../Writers/Access Token Minter Explanation.md#mint>).

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::a_code_redeems_once}}

The same code redeems, then doesn't.

Exercised end to end by [`a_code_signs_in_once`](<../Integration Tests/Same Device Sign In Explanation.md#a_code_signs_in_once>) and [`an_unknown_code_signs_nobody_in`](<../Integration Tests/Same Device Sign In Explanation.md#an_unknown_code_signs_nobody_in>).

## `session`

The Owner session the sign-in starts: the row the browser-session writer stores, and the token's `sid`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::session}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs tests::a_redeemed_code_names_the_browser_session_client_and_the_owner_s_grant}}

The proof names the browser-session client and the Owner's grant; its session is an Owner session with no name, holding the same scopes, starting now and lasting the TTL passed.

Exercised end to end by [`the_cookie_holds_an_eight_hour_owner_token`](<../Integration Tests/Same Device Sign In Explanation.md#the_cookie_holds_an_eight_hour_owner_token>).
