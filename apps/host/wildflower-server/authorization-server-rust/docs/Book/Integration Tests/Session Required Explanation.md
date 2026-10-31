# Session Required

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs}}

An app's request starts in a browser, and the server asks about the browser before it asks about the app. **A browser without a browser session gets nothing from `/oauth/authorize` but a trip to the pairing page**, and it comes back to the same request once paired. A browser with one gets the whole flow. Every code its request earns is issued under **that browser's session**, never the approver's, and carries only what that session also holds.

These tests hold the server to both halves. They lean on the [browser session](<../Domain/Browser Session Explanation.md>), on the [code request](<../Domain/Authorization Request/Code Request Explanation.md>) that records the `sid` it was made in, and on the [launch context](<../Domain/Launch Context Explanation.md>) a SMART launch carries.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationsession_required>) page, with the shared ones.

## `integration::session_required`

### `a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_browser_without_a_session_is_sent_to_pairing_even_with_a_standing_grant}}

Relies on the front door of [`handle_authorize_request`](<../HTTP/Routes/Authorize Explanation.md#item-handle_authorize_request>), which redirects before any request is parked or any launch consumed. Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_app`](<Test Fixtures Explanation.md#item-session_required--seed_app>), [`fhir_ui_query`](<Test Fixtures Explanation.md#item-fhir_ui_query>), [`APPROVE_FHIR_UI`](<Test Fixtures Explanation.md#item-APPROVE_FHIR_UI>), [`app_query`](<Test Fixtures Explanation.md#item-session_required--app_query>), [`APPROVE_APP`](<Test Fixtures Explanation.md#item-session_required--APPROVE_APP>), [`park_and_approve`](<Test Fixtures Explanation.md#item-park_and_approve>), [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>), [`get_authorize_without_session`](<Test Fixtures Explanation.md#item-get_authorize_without_session>), [`pairing_next`](<Test Fixtures Explanation.md#item-pairing_next>), [`location_of`](<Test Fixtures Explanation.md#item-location_of>), [`start_pairing`](<Test Fixtures Explanation.md#item-session_required--start_pairing>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>) and [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>).

### `a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_paired_browser_takes_the_fast_path_under_its_own_session_until_it_is_revoked}}

Relies on [`BrowserSession::is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>), [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>) and [`session_bounded_scopes`](<../Authority/Delegated Scopes Explanation.md#item-session_bounded_scopes>). Fixtures first used here: [`paired_browser_session_holding`](<Test Fixtures Explanation.md#item-paired_browser_session_holding>), [`limited_request_id`](<Test Fixtures Explanation.md#item-limited_request_id>), [`continue_past_session_shortfall`](<Test Fixtures Explanation.md#item-continue_past_session_shortfall>), [`redeem`](<Test Fixtures Explanation.md#item-session_required--redeem>), [`code_of`](<Test Fixtures Explanation.md#item-session_required--code_of>), [`sid_of`](<Test Fixtures Explanation.md#item-session_required--sid_of>), [`family_sid`](<Test Fixtures Explanation.md#item-family_sid>), [`post_token`](<Test Fixtures Explanation.md#item-session_required--post_token>) and [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>).

### `the_code_names_the_requesting_browser_s_session_not_the_approver_s`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs the_code_names_the_requesting_browser_s_session_not_the_approver_s}}

Relies on the [`CodeRequest`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest>)'s `sid` and [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>), through [`RequestApprover::approve_for_code`](<../Writers/Request Approver Explanation.md#item-RequestApprover--approve_for_code>). Fixtures first used here: [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>) and [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>).

### `an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs an_owner_approval_from_another_browser_is_bounded_by_the_requesting_session}}

Relies on [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) and [`session_bounded_scopes`](<../Authority/Delegated Scopes Explanation.md#item-session_bounded_scopes>). Fixtures first used here: [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>).

### `a_leaked_request_id_collects_nothing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs a_leaked_request_id_collects_nothing}}

Relies on the [`CodeRequest`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest>)'s `sid`, which [`AuthorizationStatusReader::status`](<../Capabilities/OAuth/Authorization Status Reader Explanation.md#item-AuthorizationStatusReader--status>) compares with the polling browser's. Fixtures first used here: [`paired_browser_session`](<Test Fixtures Explanation.md#item-paired_browser_session>) and [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs the_wait_page_reads_the_status_after_the_owner_signs_in_in_the_same_browser}}

Relies on [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>) and [`any_request_status_scopes`](<../Capabilities/OAuth/Authorization Status Reader Explanation.md#item-any_request_status_scopes>), the scopes that let a session read a request made in another. Fixtures first used here: [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>), [`browser_session_cookie`](<Test Fixtures Explanation.md#item-common--browser_session_cookie>), [`browser_session_token`](<Test Fixtures Explanation.md#item-common--browser_session_token>) and [`signed_in_session_token_that_cannot_decide`](<Test Fixtures Explanation.md#item-signed_in_session_token_that_cannot_decide>).

### `an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs an_expired_launch_and_an_unknown_one_go_back_to_the_app_saying_why}}

Relies on [`LaunchContext::for_client`](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_client>), [`LAUNCH_CONTEXT_TTL`](<../Domain/Launch Context Explanation.md#item-LAUNCH_CONTEXT_TTL>) and [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#item-LaunchRefusal>).
