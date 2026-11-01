# Session Shortfall

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs}}

A browser paired with read-only access may run an app that asks for more. The code it earns would carry only what its session holds, so **the browser is told first, on the limited page, before anyone else is bothered**. `/oauth/authorize` parks the request awaiting that page and sends the browser to `/oauth/authorize/{id}/limited`. The page reads what the session lacks ([`session_shortfall`](<../Authority/Delegated Scopes Explanation.md#item-session_shortfall>)), then goes on (`…/continue`) or cancels (`…/cancel`).

Until the browser goes on, the Owner isn't asked and nothing decides the request. Going on takes the branch the start would have taken: the fast path under a standing grant, the consent card, or the wait page. Only the browser that made the request can read, continue or cancel it. Once a browser session has gone on for an app, its later requests for that app skip the page. The request's two limited-page transitions are [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) and [`CodeRequest::to_denied_on_limited_page`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied_on_limited_page>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationsession_shortfall>) page, with the shared ones.

## `integration::session_shortfall`

### `the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code}}

Relies on [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) and [`CodeAuthorizationStarter::continue_past_session_shortfall`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-CodeAuthorizationStarter--continue_past_session_shortfall>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_app`](<Test Fixtures Explanation.md#item-session_shortfall--seed_app>), [`approve_a_standing_grant`](<Test Fixtures Explanation.md#item-approve_a_standing_grant>), [`limited_browser`](<Test Fixtures Explanation.md#item-limited_browser>), [`limited_request_id`](<Test Fixtures Explanation.md#item-limited_request_id>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`app_query`](<Test Fixtures Explanation.md#item-session_shortfall--app_query>), [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>), [`get_session_shortfall`](<Test Fixtures Explanation.md#item-get_session_shortfall>), [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`continue_past_session_shortfall`](<Test Fixtures Explanation.md#item-continue_past_session_shortfall>), [`redeem`](<Test Fixtures Explanation.md#item-session_shortfall--redeem>), [`code_of`](<Test Fixtures Explanation.md#item-session_shortfall--code_of>) and [`post_session_shortfall`](<Test Fixtures Explanation.md#item-post_session_shortfall>).

### `a_session_that_went_on_for_an_app_skips_the_limited_page_for_it`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs a_session_that_went_on_for_an_app_skips_the_limited_page_for_it}}

Relies on the per-session, per-client acknowledgement that [`CodeAuthorizationStarter::continue_past_session_shortfall`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-CodeAuthorizationStarter--continue_past_session_shortfall>) records. Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`location_of`](<Test Fixtures Explanation.md#item-location_of>) and [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>).

### `continue_for_an_app_disabled_since_denies_the_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs continue_for_an_app_disabled_since_denies_the_request}}

Relies on [`CodeRequest::to_denied_on_limited_page`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied_on_limited_page>). Fixtures first used here: [`disable_client`](<Test Fixtures Explanation.md#item-disable_client>) and [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>).

### `cancel_answers_the_app_access_denied`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs cancel_answers_the_app_access_denied}}

Relies on [`CodeRequest::to_denied_on_limited_page`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied_on_limited_page>), through [`SessionShortfall::cancel`](<../Capabilities/OAuth/Session Shortfall Explanation.md#item-SessionShortfall--cancel>).

### `the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page}}

Relies on [`CodeRequest::is_awaiting_limited_page_at`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--is_awaiting_limited_page_at>) and [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>), [`APPROVE_APP`](<Test Fixtures Explanation.md#item-session_shortfall--APPROVE_APP>) and [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>).

### `another_browser_can_neither_read_nor_continue_nor_cancel`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs another_browser_can_neither_read_nor_continue_nor_cancel}}

Relies on the [`CodeRequest`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest>)'s `sid`, which [`load_code_request_awaiting_limited_page`](<../Capabilities/OAuth/Session Shortfall Explanation.md#item-load_code_request_awaiting_limited_page>) compares with the calling browser's. Fixtures first used here: [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>).

### `a_same_device_session_never_sees_the_limited_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs a_same_device_session_never_sees_the_limited_page}}

Relies on [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>).

### `without_a_standing_grant_continue_raises_the_request_for_the_owner`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs without_a_standing_grant_continue_raises_the_request_for_the_owner}}

Relies on [`CodeRequest::to_raised_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_raised_for_owner>) and [`ApprovableScopes::missing_approval_scopes`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--missing_approval_scopes>), which decides between the consent card and the wait page. Fixtures first used here: [`decode_jwt_payload`](<Test Fixtures Explanation.md#item-decode_jwt_payload>), [`mint_browser_session_token`](<Test Fixtures Explanation.md#item-mint_browser_session_token>) and [`get_oauth_consent`](<Test Fixtures Explanation.md#item-get_oauth_consent>).

### `an_expired_request_on_the_limited_page_goes_no_further`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs an_expired_request_on_the_limited_page_goes_no_further}}

Relies on [`CodeRequest::is_expired_at`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--is_expired_at>).
