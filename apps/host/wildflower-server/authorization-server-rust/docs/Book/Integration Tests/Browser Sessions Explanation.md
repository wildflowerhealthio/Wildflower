# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs}}

A [browser session](<../Domain/Browser Session Explanation.md>) is the server's record of one signed-in browser. Everything minted under it names it as `sid`: the browser's own token, and every code, access token and refresh family an app earns there. **Revoking the session ends all of them**, wherever they are checked: on the `/authorization` surface, at the in-process verifier the FHIR server uses, and at refresh. `/authorization/browser-sessions` lists the live sessions and revokes one, and `/oauth/sign-out` revokes the session a browser's cookie holds.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationbrowser_sessions>) page, with the shared ones.

## `integration::browser_sessions`

### `a_sign_in_starts_a_same_device_session_its_token_names`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs a_sign_in_starts_a_same_device_session_its_token_names}}

A second sign-in gets a different `sid`. Relies on [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>), [`sid_of`](<Test Fixtures Explanation.md#item-browser_sessions--sid_of>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>) and [`decode_jwt_payload`](<Test Fixtures Explanation.md#item-decode_jwt_payload>).

### `revoking_a_session_stops_its_authorization_and_fhir_requests`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs revoking_a_session_stops_its_authorization_and_fhir_requests}}

The verifier answers `Revoked`, not a generic rejection. Relies on [`AccessTokenVerifyError`](<../Domain/Access Token Explanation.md#item-AccessTokenVerifyError>) and [`TokenVerifier::verify`](<../Capabilities/Session/Token Verifier Explanation.md#item-TokenVerifier--verify>). Fixtures first used here: [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>).

### `an_app_authorized_in_a_session_is_ended_with_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs an_app_authorized_in_a_session_is_ended_with_it}}

Relies on [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>) and [`BrowserSession::is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`location_of`](<Test Fixtures Explanation.md#item-location_of>), [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`post_token`](<Test Fixtures Explanation.md#item-browser_sessions--post_token>) and [`CODE_VERIFIER`](<Test Fixtures Explanation.md#item-CODE_VERIFIER>).

### `approving_a_request_whose_session_was_revoked_denies_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs approving_a_request_whose_session_was_revoked_denies_it}}

Relies on [`BrowserSession::is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>) and [`CodeRequest::deny`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--deny>), through [`RequestApprover::approve_for_code`](<../Writers/Request Approver Explanation.md#item-RequestApprover--approve_for_code>).

### `the_browsers_list_shows_live_sessions_and_revokes_one`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_browsers_list_shows_live_sessions_and_revokes_one}}

A fresh session's `lastSeenAt` equals its `createdAt`: signing in is its first use. Relies on [`BrowserSession`](<../Domain/Browser Session Explanation.md#item-BrowserSession>). Fixtures first used here: [`authorization_request`](<Test Fixtures Explanation.md#item-authorization_request>) and [`listed_browser_sessions`](<Test Fixtures Explanation.md#item-listed_browser_sessions>).

### `revoking_the_caller_s_own_session_signs_it_out`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs revoking_the_caller_s_own_session_signs_it_out}}

Relies on [`BrowserSession::is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>).

### `the_browsers_routes_are_scope_gated`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_browsers_routes_are_scope_gated}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>). Fixtures first used here: [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>).

### `signing_out_revokes_the_cookie_s_session_and_clears_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs signing_out_revokes_the_cookie_s_session_and_clears_it}}

Relies on [`BrowserSession::is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>). Fixtures first used here: [`sign_out`](<Test Fixtures Explanation.md#item-sign_out>), [`LAUNCHER_BASE`](<Test Fixtures Explanation.md#item-LAUNCHER_BASE>), [`set_cookie_values`](<Test Fixtures Explanation.md#item-set_cookie_values>) and [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>).

### `signing_out_without_a_standing_session_still_clears_the_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs signing_out_without_a_standing_session_still_clears_the_cookie}}

Relies on [`carried_browser_session`](<../HTTP/Browser Session Cookie Explanation.md#item-carried_browser_session>).

### `the_session_read_answers_the_browser_session_s_expiry`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs the_session_read_answers_the_browser_session_s_expiry}}

Relies on [`BrowserSession`](<../Domain/Browser Session Explanation.md#item-BrowserSession>).
