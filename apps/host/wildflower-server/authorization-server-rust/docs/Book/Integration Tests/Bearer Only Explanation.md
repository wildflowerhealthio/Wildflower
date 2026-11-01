# Bearer Only

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs}}

**The bearer gates read the `Authorization: Bearer` header and nothing else.** No grant hands a token back as a cookie, a token carried in a `wf_auth` cookie authenticates nothing, and logout sets no cookies. The one cookie the server sets is the browser session's, from same-device sign-in ([Same-Device Sign-In](<Same Device Sign In Explanation.md>)) and from the pairing poll ([Browser Pairing](<Browser Pairing Explanation.md>)). It reaches the gates only through the host's cookie-to-bearer layer, which presents its token as the request's bearer.

## `integration::bearer_only`

### `a_device_grant_sets_no_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_device_grant_sets_no_cookie}}

Relies on [`DeviceRequest::to_claimed`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--to_claimed>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>), [`plant_device_request`](<Test Fixtures Explanation.md#item-plant_device_request>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>), [`TEST_CLIENT_ID`](<Test Fixtures Explanation.md#item-TEST_CLIENT_ID>), [`TEST_CLIENT_SCOPE`](<Test Fixtures Explanation.md#item-TEST_CLIENT_SCOPE>), [`post_form`](<Test Fixtures Explanation.md#item-post_form>), [`set_cookie_values`](<Test Fixtures Explanation.md#item-set_cookie_values>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `a_refresh_grant_sets_no_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_refresh_grant_sets_no_cookie}}

Relies on [`RefreshFamilyWriter::rotate`](<../Writers/Refresh Family Writer Explanation.md#item-RefreshFamilyWriter--rotate>). Fixtures first used here: [`plant_refresh_token`](<Test Fixtures Explanation.md#item-plant_refresh_token>).

### `a_cookie_carried_token_is_not_a_credential`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs a_cookie_carried_token_is_not_a_credential}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `logout_redirects_to_the_launcher_without_cookies`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/bearer_only.rs logout_redirects_to_the_launcher_without_cookies}}

Relies on [`handle_logout`](<../HTTP/Routes/Session Routes Explanation.md#item-handle_logout>). Fixtures first used here: [`LAUNCHER_BASE`](<Test Fixtures Explanation.md#item-LAUNCHER_BASE>).
