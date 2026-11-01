# OAuth Endpoints

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs}}

These tests hold the server's three OAuth doors to their contract with apps: `/oauth/authorize`, where a browser starts an app's request, `/oauth/device_authorization`, where a device starts one, and `/oauth/token`, where an app collects what it was granted. They are about what each door accepts, refuses and reports, more than about what happens once the Owner decides; [Grant Flows](<Grant Flows Explanation.md>) follows the flows end to end.

Most of the file is `/oauth/authorize`, and most of that is one rule from RFC 6749: **an error may be sent back to an app's redirect only once that redirect is trusted.** A redirect is trusted when a client the server already knows has it registered ([`Client::allows_redirect_uri`](<../Domain/Client Explanation.md#item-Client--allows_redirect_uri>)). Until then, a failure renders a local error page ([`AuthorizeRefusal`](<../Domain/Errors Explanation.md#item-AuthorizeRefusal>)), because redirecting to an address nobody vouched for would be an open redirect. Clients without a server-defined registration are trusted on first use: an unknown client, a new redirect or a new scope is carried to the Owner's prompt as a [presented client change](<../Domain/Client Explanation.md#item-PresentedClientChange>) instead of refused.

The tests run in this order: what `/oauth/authorize` checks and how it fails, a request's scopes against its client's registration, telling the Owner about a parked request, SMART App Launch ([launch context](<../Domain/Launch Context Explanation.md>)), the device door, and the token door.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationoauth_endpoints>) page, with the shared ones.

## `integration::oauth_endpoints`

### `authorize_unknown_client_parks_a_pending_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unknown_client_parks_a_pending_request}}

Relies on [`ResolvedCodeRequest::resolve`](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--resolve>) and [`CodeRequest::new`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--new>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>), [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>) and [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>).

### `authorize_unknown_client_renders_later_failures_locally`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unknown_client_renders_later_failures_locally}}

Relies on [`start_error`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-start_error>), which picks between the local page and the redirect. Fixtures first used here: [`CODE_VERIFIER`](<Test Fixtures Explanation.md#item-CODE_VERIFIER>) and [`body_string`](<Test Fixtures Explanation.md#item-body_string>).

### `authorize_unregistered_redirect_parks_and_keeps_the_redirect_untrusted`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unregistered_redirect_parks_and_keeps_the_redirect_untrusted}}

Relies on [`Client::allows_redirect_uri`](<../Domain/Client Explanation.md#item-Client--allows_redirect_uri>). Fixtures first used here: [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>).

### `authorize_disabled_client_is_still_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_disabled_client_is_still_rejected}}

Relies on [`ResolvedCodeRequest::is_client_disabled`](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--is_client_disabled>).

### `authorize_validates_redirect_uri_before_pkce_method`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_validates_redirect_uri_before_pkce_method}}

Relies on [`Client::is_registration_fixed`](<../Domain/Client Explanation.md#item-Client--is_registration_fixed>). Fixtures first used here: [`build_request`](<Test Fixtures Explanation.md#item-build_request>) and [`browser_session_cookie`](<Test Fixtures Explanation.md#item-common--browser_session_cookie>).

### `authorize_unsupported_response_type_redirects_back`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unsupported_response_type_redirects_back}}

Relies on [`validate_code_params`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-validate_code_params>) and [`build_client_error_redirect_url`](<../Domain/Authorization Code Explanation.md#item-build_client_error_redirect_url>).

### `authorize_unsupported_pkce_method_redirects_invalid_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_unsupported_pkce_method_redirects_invalid_request}}

Relies on [`validate_code_params`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-validate_code_params>).

### `authorize_disallowed_scope_parks_a_pending_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_disallowed_scope_parks_a_pending_request}}

Relies on [`uncovered_scopes`](<../Domain/Client Explanation.md#item-uncovered_scopes>) and [`PresentedClientChange`](<../Domain/Client Explanation.md#item-PresentedClientChange>). Fixtures first used here: [`get_oauth_consent`](<Test Fixtures Explanation.md#item-get_oauth_consent>).

### `authorize_publishes_the_parked_request_as_the_owner_prompt`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_publishes_the_parked_request_as_the_owner_prompt}}

Relies on [`OwnerPrompt::for_request`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt--for_request>). Fixtures first used here: [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>).

### `deciding_an_oauth_consent_clears_the_owner_prompt`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs deciding_an_oauth_consent_clears_the_owner_prompt}}

Relies on [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>), [`CodeRequest::to_denied`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied>) and [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>).

### `the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs the_pending_consent_watcher_sees_an_older_request_decided_under_a_newer_one}}

Relies on [`PendingConsentWatcher::until_settled`](<../Assembly/OAuth Bindings Explanation.md#item-PendingConsentWatcher--until_settled>), which rereads the request through [`AuthorizationRequestsTx::is_awaiting_owner`](<../Persistence/Authorization Requests Explanation.md#item-SqliteGrantTx--is_awaiting_owner>) each time the Owner prompt is recomputed, whether or not it changed.

### `a_fast_pathed_authorize_never_becomes_the_owner_prompt`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs a_fast_pathed_authorize_never_becomes_the_owner_prompt}}

Relies on [`GrantCoverage::resolve`](<../Authority/Standing Grant Explanation.md#item-GrantCoverage--resolve>) and [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>). Fixtures first used here: [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>), [`authorize_and_approve`](<Test Fixtures Explanation.md#item-authorize_and_approve>) and [`location_of`](<Test Fixtures Explanation.md#item-location_of>).

### `authorize_host_app_disallowed_scope_still_redirects_invalid_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_host_app_disallowed_scope_still_redirects_invalid_scope}}

Relies on [`Client::is_registration_fixed`](<../Domain/Client Explanation.md#item-Client--is_registration_fixed>).

### `authorize_allows_scope_covered_by_a_broader_allowed_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_allows_scope_covered_by_a_broader_allowed_scope}}

Relies on [`uncovered_scopes`](<../Domain/Client Explanation.md#item-uncovered_scopes>) and [`allowed_scope_covers`](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>).

### `authorize_treats_a_cross_grammar_scope_request_as_new`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_treats_a_cross_grammar_scope_request_as_new}}

Relies on [`uncovered_scopes`](<../Domain/Client Explanation.md#item-uncovered_scopes>).

### `authorize_consumes_a_smart_launch_once`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_consumes_a_smart_launch_once}}

Relies on [`LaunchContext::for_client`](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_client>) and [`consume_launch`](<../Capabilities/OAuth/Launch Contexts Explanation.md#item-consume_launch>). Fixtures first used here: [`smart_launch_query`](<Test Fixtures Explanation.md#item-smart_launch_query>), [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>) and [`ALREADY_USED_LOCATION`](<Test Fixtures Explanation.md#item-ALREADY_USED_LOCATION>).

### `authorize_consumes_a_server_launcher_launch_once`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_consumes_a_server_launcher_launch_once}}

Relies on [`LaunchContext::for_server_launcher`](<../Domain/Launch Context Explanation.md#item-LaunchContext--for_server_launcher>) and [`LaunchContext::admits_client`](<../Domain/Launch Context Explanation.md#item-LaunchContext--admits_client>).

### `authorize_refuses_a_bad_smart_launch_or_aud`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_refuses_a_bad_smart_launch_or_aud}}

Relies on [`LaunchRefusal`](<../Domain/Launch Context Explanation.md#item-LaunchRefusal>) and [`launch_refusal_kind`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-launch_refusal_kind>).

### `authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs authorize_renders_a_bad_smart_launch_locally_for_an_untrusted_redirect}}

Relies on [`start_error`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-start_error>).

### `device_authorization_happy_path`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_happy_path}}

Relies on [`DeviceRequest::new`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--new>) and [`DeviceAuthorizer::start`](<../Capabilities/OAuth/Device Authorizer Explanation.md#item-DeviceAuthorizer--start>).

### `device_authorization_allows_scope_covered_by_client_wildcard`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_allows_scope_covered_by_client_wildcard}}

Relies on [`Client::allows_scopes`](<../Domain/Client Explanation.md#item-Client--allows_scopes>).

### `device_authorization_unknown_client_returns_401`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs device_authorization_unknown_client_returns_401}}

Relies on [`AuthenticatedClient::authenticate`](<../Authority/Authenticated Client Explanation.md#item-AuthenticatedClient--authenticate>).

### `token_exchange_unknown_code_returns_400_invalid_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_unknown_code_returns_400_invalid_grant}}

Relies on [`RedeemedAuthorizationCode::redeem`](<../Authority/Redemption Explanation.md#item-RedeemedAuthorizationCode--redeem>).

### `token_exchange_short_code_verifier_returns_400_invalid_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_short_code_verifier_returns_400_invalid_grant}}

Relies on [`RedeemedAuthorizationCode::redeem`](<../Authority/Redemption Explanation.md#item-RedeemedAuthorizationCode--redeem>).

### `token_exchange_error_sets_cache_suppression_headers`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_error_sets_cache_suppression_headers}}

Relies on [`CacheSuppressed`](<../HTTP/Errors and Wire Shapes Explanation.md#item-CacheSuppressed>). [Cache Suppression](<Cache Suppression Explanation.md>) holds the `/authorization` responses to the same rule.

### `token_exchange_rejects_non_form_content_type`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_rejects_non_form_content_type}}

Relies on [`require_form_urlencoded_content_type`](<../HTTP/Routes/Token Endpoint Explanation.md#item-require_form_urlencoded_content_type>).

### `token_exchange_unknown_device_code_returns_400_invalid_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs token_exchange_unknown_device_code_returns_400_invalid_grant}}

Relies on [`ConsumedDeviceRequest::consume`](<../Authority/Redemption Explanation.md#item-ConsumedDeviceRequest--consume>).
