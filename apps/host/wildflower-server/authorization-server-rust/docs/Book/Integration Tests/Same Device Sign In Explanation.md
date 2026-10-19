# Same-Device Sign-In

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs}}

The Owner's own browser doesn't pair. The base app, running on the same device as the server, mints a one-time sign-in code in-process and opens `GET /oauth/sign-in?code=…&next=…` in a browser. **Only the base can mint a code, so redeeming one proves the browser is on the Owner's device.** The sign-in starts an Owner [browser session](<../Domain/Browser Session Explanation.md>) holding the Owner's scopes, hands the browser its token as the `__Host-browser_session` cookie, and sends it on to an allowed `next`.

A code signs in once. A refused sign-in renders an error page, with no cookie and no redirect. The flow is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::sign_in}}, and the proof it mints under is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/same_device_sign_in.rs RedeemedSameDeviceSignInCode::redeem}}. The tests sign in with the harness's [`sign_in`](<../Integration Tests Explanation.md#sign_in>) and read the cookie with [`browser_session_token`](<../Integration Tests Explanation.md#browser_session_token>).

## Helpers

`assert_refused` holds a response to the sign-in's refusal: a `400` error page, with no cookie and no `Location`:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs assert_refused}}

## `a_code_signs_in_once`

**A code signs a browser in once.** The first sign-in answers `303` with the session cookie, uncached. The same code presented again is refused.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_code_signs_in_once}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::take}} and [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>).

## `an_unknown_code_signs_nobody_in`

**A code the base never minted signs nobody in, even while another code is outstanding**, and neither does a sign-in with no code at all.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs an_unknown_code_signs_nobody_in}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/same_device_sign_in_codes.rs SameDeviceSignInCodes::take}}.

## `the_cookie_holds_an_eight_hour_owner_token`

**The cookie holds an Owner token for eight hours, with exactly the browser session cookie's attributes.** The token is issued to the browser-session client, by and for this server's origin, holding the Owner's scopes, with a `jti` of its own. The Owner-gated routes accept it.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs the_cookie_holds_an_eight_hour_owner_token}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs OWNER_SESSION_TTL}} and [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>).

## `the_browser_goes_on_to_an_allowed_next`

**A sign-in sends the browser on to its `next` when that is a place a signed-in Owner belongs.** That is a path on this server (here the consent card), a URL under the hosted launcher or the hosted Authorization app, or a URL under the launcher and Authorization app pages the host opens for this server. Each `Location` is the `next` as given.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs the_browser_goes_on_to_an_allowed_next}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow}}.

## `a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable`

**Any other `next` is refused before the code is touched, so the code still signs in afterwards.** Refused are a protocol-relative URL, a backslash spelling a browser reads as another host, another origin, other paths on the launcher's and the host pages' origins, this server's bare origin (a URL, not a path), and an empty `next`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_next_anywhere_else_is_refused_and_leaves_the_code_redeemable}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow}}.

## `a_disabled_browser_session_client_signs_nobody_in_until_re_enabled`

**A browser-session client disabled out of band signs nobody in, and leaves the code unspent.** The client is essential, so the Owner can't disable it; the test disables it directly in the store. The sign-in then renders the "Browser sign-in disabled" page, uncached, with no cookie. Once the client is enabled again, the same code signs in.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_disabled_browser_session_client_signs_nobody_in_until_re_enabled}}

Relies on the [client](<../Domain/Client Explanation.md>)'s disabled state, which {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/same_device_sign_in.rs SameDeviceSignIn::sign_in}} checks before redeeming the code.

## `a_browser_session_is_revoked_by_its_jti`

**Each sign-in mints a token of its own, and revoking one token's `jti` signs out that browser alone.** `GET /authorization/session` answers the first token with the Owner's scopes. Once its `jti` is revoked, it answers `401`, while the second sign-in's token still works.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs a_browser_session_is_revoked_by_its_jti}}

Relies on the [token](<../Domain/Token Explanation.md>)'s `jti`, checked by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify}}.

## `revoking_the_browser_session_client_s_subject_signs_every_browser_out`

**Revoking the browser-session client's subject signs every browser out at once**, with a `204`. Both signed-in tokens are then refused with `401`, while a token issued to another client keeps working. The revocation epoch is second-granular, so a token issued in the revoking second is revoked too and the test needs no wait.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs revoking_the_browser_session_client_s_subject_signs_every_browser_out}}

Relies on the [token](<../Domain/Token Explanation.md>)'s subject, checked by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify}}.
