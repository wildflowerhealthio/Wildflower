# Device Page

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs}}

The device page is where a person types, or follows a link with, a device's user code and approves it. `/oauth/device_authorization` points the device's user at it as `verification_uri_complete`: `/oauth/device` on the server's own origin. The page is the same bytes whatever the code: it reads the code from its own URL. It decides the request through the same `/authorization/devices/{userCode}` API the [Device Code](<Device Code Explanation.md>) tests drive, on the bearer of the browser session that opened it.

Turning the page's browser session cookie into that bearer is the host's job (`wildflower-server-rust`), not this crate's, so these tests send the browser session's token as the bearer themselves.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationdevice_page>) page, with the shared ones.

## `integration::device_page`

### `verification_uri_complete_serves_the_device_page_on_the_server_origin`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs verification_uri_complete_serves_the_device_page_on_the_server_origin}}

Relies on [`device_page_url_with_code`](<../HTTP/Routes/Authorization Pages Explanation.md#item-device_page_url_with_code>) and [`router_for`](<../HTTP/Routes/Authorization Pages Explanation.md#item-router_for>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>), [`start_device_flow`](<Test Fixtures Explanation.md#item-start_device_flow>), [`SERVER_ORIGIN`](<Test Fixtures Explanation.md#item-SERVER_ORIGIN>) and [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `a_browser_session_approves_the_code_and_the_device_poll_succeeds`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs a_browser_session_approves_the_code_and_the_device_poll_succeeds}}

Relies on [`DeviceRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--approve>) and [`DeviceRequest::claim`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--claim>). Fixtures first used here: [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>), [`device_consent_request`](<Test Fixtures Explanation.md#item-device_consent_request>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`poll`](<Test Fixtures Explanation.md#item-device_page--poll>) and [`TEST_CLIENT_SCOPE`](<Test Fixtures Explanation.md#item-TEST_CLIENT_SCOPE>).

### `without_a_session_the_request_is_left_pending`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs without_a_session_the_request_is_left_pending}}

Relies on [`require_valid_session`](<../HTTP/Middleware Explanation.md#item-require_valid_session>).

### `an_unknown_code_is_not_found_for_the_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs an_unknown_code_is_not_found_for_the_browser_session}}

Relies on [`load_pending_request_by_user_code`](<../Capabilities/Access/Device Consents Explanation.md#item-load_pending_request_by_user_code>).
