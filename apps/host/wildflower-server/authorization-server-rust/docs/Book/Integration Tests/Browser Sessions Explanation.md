# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs}}

A browser session is the server's record of one signed-in browser. Everything minted under it names it as `sid`: the browser's own token, and every code, access token and refresh family an app earns there. **Revoking the session ends all of them**, wherever they are checked. Read the [Browser Session](<../Domain/Browser Session Explanation.md>) page first.

These tests sign a browser in as the Owner with [signed_in_owner_session_token](<../Integration Tests Explanation.md#signed_in_owner_session_token>) and probe a token with [owner_grants_probe](<../Integration Tests Explanation.md#owner_grants_probe>).

## Helpers

The `sid` a token names, read without verifying it:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs sid_of}}

An app's call to `POST /oauth/token`:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs post_token}}

A call on the `/authorization` surface with a bearer, and the list of sessions it is shown, each marked with whether it is the caller's own:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs authorization_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs listed_browser_sessions}}

The Sign out form's post, with the browser's cookie if it has one:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs sign_out}}

## `a_sign_in_starts_an_owner_session_its_token_names`

**A sign-in starts its own Owner session: unnamed, holding the Owner's scopes, lasting eight hours, and the token it hands the browser names it and ends with it.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs a_sign_in_starts_an_owner_session_its_token_names}}

A second sign-in gets a different `sid`. Relies on [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>) and [`BrowserSession`](<../Domain/Browser Session Explanation.md>).

## `revoking_a_session_stops_its_authorization_and_fhir_requests`

**A revoked session's token is refused at the `/authorization` gate and by the in-process verifier the FHIR server uses. Another session's token keeps working on both.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs revoking_a_session_stops_its_authorization_and_fhir_requests}}

The verifier answers `Revoked`, not a generic rejection. Relies on [`VerifyError`](<../Domain/Token Explanation.md#verifyerror>).

## `an_app_authorized_in_a_session_is_ended_with_it`

**An app authorized in a browser earns everything under that browser's session, and loses it all when the session is revoked.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs an_app_authorized_in_a_session_is_ended_with_it}}

The access token and its refreshed successor both name the session's `sid`, and the refresh marks the session seen. After revocation the family's next refresh is `invalid_grant` and the original access token verifies as `Revoked`. Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#refreshtokenfamily>) and [`BrowserSession`](<../Domain/Browser Session Explanation.md>).

## `approving_a_request_whose_session_was_revoked_denies_it`

**If the requesting browser is signed out before the Owner approves, the approval becomes a denial.** The app gets `access_denied`, never a code whose tokens would be refused.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs approving_a_request_whose_session_was_revoked_denies_it}}

Relies on [`is_live`](<../Domain/Browser Session Explanation.md#is_live>) and [`deny`](<../Domain/Authorization Request Explanation.md#deny>).

## `the_browsers_list_shows_live_sessions_and_revokes_one`

**The browsers list shows the live sessions, newest first, with the caller's own marked. Revoking one takes it off the list and ends its token. Revoking it again is a `404`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_browsers_list_shows_live_sessions_and_revokes_one}}

A fresh session's `lastSeenAt` equals its `createdAt`: signing in is its first use. The seeded paired browser is listed too. Relies on [`BrowserSession`](<../Domain/Browser Session Explanation.md>).

## `revoking_the_caller_s_own_session_signs_it_out`

**A browser may revoke its own session, and that signs it out.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs revoking_the_caller_s_own_session_signs_it_out}}

## `the_browsers_routes_are_scope_gated`

**Listing sessions takes `wildflower/BrowserSession.r`; revoking one takes `wildflower/BrowserSession.d`.** A token without the scope gets a `403` naming it, and nothing is revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_browsers_routes_are_scope_gated}}

## `signing_out_revokes_the_cookie_s_session_and_clears_it`

**Signing out revokes the session the cookie holds, clears the cookie with the attributes it was set with, and sends the browser to the launcher.** Another browser's session stands.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs signing_out_revokes_the_cookie_s_session_and_clears_it}}

The response is uncached ([assert_cache_suppressed](<../Integration Tests Explanation.md#assert_cache_suppressed>)).

## `signing_out_without_a_standing_session_still_clears_the_cookie`

**Signing out with no cookie, an ended session or a garbage cookie still clears the cookie and sends the browser to the launcher.** There is nothing to revoke, and no error.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs signing_out_without_a_standing_session_still_clears_the_cookie}}

## `the_session_read_answers_the_browser_session_s_expiry`

**`GET /authorization/session` answers when the caller's browser session expires**, which the server's pages show as "Signed in until". A token under no browser session answers `null`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_session_read_answers_the_browser_session_s_expiry}}

Relies on [`BrowserSession`](<../Domain/Browser Session Explanation.md>).
