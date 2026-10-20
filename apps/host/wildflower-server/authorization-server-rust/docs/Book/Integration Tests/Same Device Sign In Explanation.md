# Same-Device Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs}}

The Owner's own browser doesn't pair. The base app, running on the same device as the server, mints a one-time [sign-in code](<../Domain/Same Device Sign In Codes Explanation.md>) in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. **Only the base can mint a code, so redeeming one proves the browser is on the Owner's device.** The sign-in starts a same-device [browser session](<../Domain/Browser Session Explanation.md>) holding the Owner's scopes, hands the browser its token as the `__Host-browser_session` cookie, and sends it on to an allowed `next`.

A code signs in once. A refused sign-in renders an error page, with no cookie and no redirect. The flow is [`SameDeviceSignIn::sign_in`](<../Capabilities/OAuth/Same Device Sign In Explanation.md#item-SameDeviceSignIn--sign_in>), and the proof it mints under is [`RedeemedSameDeviceSignInCode::redeem`](<../Authority/Same Device Sign In Explanation.md#item-RedeemedSameDeviceSignInCode--redeem>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationsame_device_sign_in>) page, with the shared ones.

## `integration::same_device_sign_in`

### `a_code_signs_in_once`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_code_signs_in_once}}

Relies on [`SameDeviceSignInCodes::take`](<../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCodes--take>) and [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`sign_in`](<Test Fixtures Explanation.md#item-sign_in>), [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>), [`browser_session_token`](<Test Fixtures Explanation.md#item-common--browser_session_token>) and [`assert_refused`](<Test Fixtures Explanation.md#item-assert_refused>).

### `an_unknown_code_signs_nobody_in`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs an_unknown_code_signs_nobody_in}}

Relies on [`SameDeviceSignInCodes::take`](<../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCodes--take>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `the_browser_goes_on_to_an_allowed_next`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs the_browser_goes_on_to_an_allowed_next}}

Relies on [`SignInDestinations::allow`](<../Domain/Same Device Sign In Codes Explanation.md#item-SignInDestinations--allow>).

### `a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable}}

Relies on [`SignInDestinations::allow`](<../Domain/Same Device Sign In Codes Explanation.md#item-SignInDestinations--allow>), checked before [`SameDeviceSignInCodes::take`](<../Domain/Same Device Sign In Codes Explanation.md#item-SameDeviceSignInCodes--take>). Fixtures first used here: [`SERVER_ORIGIN`](<Test Fixtures Explanation.md#item-SERVER_ORIGIN>).

### `the_cookie_holds_an_eight_hour_owner_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs the_cookie_holds_an_eight_hour_owner_token}}

Relies on [`SAME_DEVICE_SESSION_TTL`](<../Capabilities/OAuth/Same Device Sign In Explanation.md#item-SAME_DEVICE_SESSION_TTL>) and [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>). Fixtures first used here: [`set_cookie_values`](<Test Fixtures Explanation.md#item-set_cookie_values>), [`claims_of`](<Test Fixtures Explanation.md#item-claims_of>) and [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>).

### `a_browser_session_is_revoked_by_its_jti`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_browser_session_is_revoked_by_its_jti}}

Relies on [`AccessTokenClaims`](<../Domain/Access Token Explanation.md#item-AccessTokenClaims>)'s `jti`, checked by [`TokenVerifier::verify`](<../Capabilities/Session/Token Verifier Explanation.md#item-TokenVerifier--verify>). Fixtures first used here: [`jti_of`](<Test Fixtures Explanation.md#item-jti_of>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>) and [`owner_revocation_request`](<Test Fixtures Explanation.md#item-owner_revocation_request>).

### `revoking_the_browser_session_client_s_subject_signs_every_browser_out`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs revoking_the_browser_session_client_s_subject_signs_every_browser_out}}

The revocation epoch is second-granular, so a token issued in the revoking second is revoked too. Relies on [`TokenVerifier::verify`](<../Capabilities/Session/Token Verifier Explanation.md#item-TokenVerifier--verify>).

### `a_disabled_browser_session_client_signs_nobody_in_until_re_enabled`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_disabled_browser_session_client_signs_nobody_in_until_re_enabled}}

Relies on [`is_essential_client`](<../Domain/Client Explanation.md#item-is_essential_client>) and the client's `disabled_at`, which [`SameDeviceSignIn::sign_in`](<../Capabilities/OAuth/Same Device Sign In Explanation.md#item-SameDeviceSignIn--sign_in>) checks before redeeming the code. Fixtures first used here: [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>), [`body_string`](<Test Fixtures Explanation.md#item-body_string>) and [`enable_client`](<Test Fixtures Explanation.md#item-enable_client>).
