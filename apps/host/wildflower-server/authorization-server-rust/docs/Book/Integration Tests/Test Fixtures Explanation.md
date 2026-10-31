# Test Fixtures

The helpers the integration tests build their servers, requests and tokens with. The shared ones live in `common.rs`, which every test file brings in with `use crate::common::*;`, along with the crate's own types and `axum`, `chrono`, `serde_json` and `url`. A file's own helpers follow, by file. Each test links the fixtures it is the first on its page to use.

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs}}

## `integration::common`

Almost every test starts from [`spin_up`](#item-spin_up): a fresh server over a fresh in-memory database, an Owner token, and the [`TestDb`](#item-TestDb) the test reaches that database through. `setup_authorization_server` runs the same bootstrap as the host: migrations, the signing key, the essential clients.

### `TestDb`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TestDb}}

### `spin_up`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up}}

### `spin_up_with_authorization_start_gate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up_with_authorization_start_gate}}

### `restart`

Sets the server up again over the same databases, as a start of a new run does, so a test can see what a start ends and what survives it.

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs restart}}

### `set_up_over`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs set_up_over}}

### `spin_up_with_confidential_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs spin_up_with_confidential_client}}

Second handles onto the databases the router uses, to plant rows the HTTP surface can't make on demand (an already-expired request, say, so expiry runs without sleeping) and to read what a request wrote.

### `store_handle`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs store_handle}}

### `revocation_store_handle`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs revocation_store_handle}}

### `owner_prompt`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs owner_prompt}}

### `seed_client_with_redirect`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_client_with_redirect}}

### `seed_test_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_test_client}}

### `seed_confidential_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs seed_confidential_client}}

Rows a flow would write, written straight to the store and moved through the domain's own transitions, with deadlines the caller picks.

### `plant_authorization_code`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_authorization_code}}

### `plant_device_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_device_request}}

### `plant_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs plant_refresh_token}}

The tests mint their tokens directly, with the signing key the server seeded, rather than earning them through a flow. Unless a test asks otherwise, each names the server's origin as `iss` and `aud`, as every token the server mints does, so the bearer gates accept it.

### `mint_owner_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_owner_token}}

### `mint_client_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_client_token}}

### `mint_token_under_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_token_under_session}}

### `mint_browser_session_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_browser_session_token}}

### `mint_scoped_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_scoped_token}}

### `mint_token_naming`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs mint_token_naming}}

### `paired_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs paired_browser_session}}

### `paired_browser_session_holding`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs paired_browser_session_holding}}

### `narrow_browser_session_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs narrow_browser_session_of}}

### `browser_session_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs browser_session_cookie}}

### `sign_in`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs sign_in}}

### `browser_session_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs browser_session_token}}

### `signed_in_same_device_session_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs signed_in_same_device_session_token}}

### `signed_in_session_token_that_cannot_decide`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs signed_in_session_token_that_cannot_decide}}

These walk an authorization-code request through the pages a browser and the Owner see.

### `authorize_query`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs authorize_query}}

### `get_authorize`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorize}}

### `get_authorize_without_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorize_without_session}}

### `parked_request_id`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs parked_request_id}}

### `polling_request_id`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs polling_request_id}}

### `get_authorization_status`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_authorization_status}}

### `limited_request_id`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs limited_request_id}}

### `get_session_shortfall`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_session_shortfall}}

### `post_session_shortfall`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_session_shortfall}}

### `continue_past_session_shortfall`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs continue_past_session_shortfall}}

### `get_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs get_oauth_consent}}

### `approve_oauth_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs approve_oauth_consent}}

### `authorize_and_approve`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs authorize_and_approve}}

### `post_form`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_form}}

### `post_form_with_authorization`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs post_form_with_authorization}}

### `basic_authorization`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs basic_authorization}}

### `owner_grants_probe`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs owner_grants_probe}}

### `owner_revocation_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs owner_revocation_request}}

### `patch_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs patch_client}}

### `disable_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs disable_client}}

### `enable_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs enable_client}}

### `build_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs build_request}}

### `body_json`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs body_json}}

### `body_string`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs body_string}}

### `location_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs location_of}}

### `set_cookie_values`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs set_cookie_values}}

### `assert_cache_suppressed`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs assert_cache_suppressed}}

### `decode_jwt_payload`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs decode_jwt_payload}}

### `jti_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs jti_of}}

### `SERVER_ORIGIN`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs SERVER_ORIGIN}}

### `LAUNCHER_BASE`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs LAUNCHER_BASE}}

### `AUTHORIZATION_APP_BASE`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs AUTHORIZATION_APP_BASE}}

### `LAUNCHER_URL`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs LAUNCHER_URL}}

### `AUTHORIZATION_URL`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs AUTHORIZATION_URL}}

### `OWNER_TOKEN_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs OWNER_TOKEN_CLIENT_ID}}

### `TEST_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TEST_CLIENT_ID}}

### `TEST_CLIENT_SCOPE`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs TEST_CLIENT_SCOPE}}

### `CODE_VERIFIER`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CODE_VERIFIER}}

### `CONFIDENTIAL_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CONFIDENTIAL_CLIENT_ID}}

### `CONFIDENTIAL_CLIENT_SECRET`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CONFIDENTIAL_CLIENT_SECRET}}

### `CHROME_MAC_USER_AGENT`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/common.rs CHROME_MAC_USER_AGENT}}

## `integration::smoke`

The helpers of [Smoke](<Smoke Explanation.md>).

### `access_grants_status`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/smoke.rs access_grants_status}}

## `integration::request_caller`

The helpers of [Request Caller](<Request Caller Explanation.md>).

### `stamped_caller`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs stamped_caller}}

### `stamped_refusal`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs stamped_refusal}}

### `revoke`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs revoke}}

### `bearer_gated_router`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs bearer_gated_router}}

### `get_with_bearer`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/request_caller.rs get_with_bearer}}

## `integration::revocation`

The helpers of [Revocation](<Revocation Explanation.md>).

### `gate_status`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs gate_status}}

### `mint_host_app_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/revocation.rs mint_host_app_token}}

## `integration::same_device_session_ending`

The helpers of [Same-Device Session Ending](<Same Device Session Ending Explanation.md>).

### `sid_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs sid_of}}

### `launch`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs launch}}

### `authorize_destination`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs authorize_destination}}

### `is_consent_card`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs is_consent_card}}

### `is_pairing_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs is_pairing_page}}

### `stored_session`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_session_ending.rs stored_session}}

## `integration::same_device_sign_in`

The helpers of [Same-Device Sign-In](<Same Device Sign In Explanation.md>).

### `claims_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs claims_of}}

### `assert_refused`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/same_device_sign_in.rs assert_refused}}

## `integration::client_management`

The helpers of [Client Management](<Client Management Explanation.md>).

### `list_clients`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs list_clients}}

### `listed_clients`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs listed_clients}}

### `find_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs find_client}}

### `stored_disabled_at`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs stored_disabled_at}}

### `disabled_at_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs disabled_at_of}}

### `refresh_as_confidential_client`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/client_management.rs refresh_as_confidential_client}}

## `integration::oauth_endpoints`

The helpers of [OAuth Endpoints](<OAuth Endpoints Explanation.md>).

### `smart_launch_query`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs smart_launch_query}}

### `ALREADY_USED_LOCATION`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/oauth_endpoints.rs ALREADY_USED_LOCATION}}

## `integration::session_required`

The helpers of [Session Required](<Session Required Explanation.md>).

### `FHIR_UI_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs FHIR_UI_CLIENT_ID}}

### `fhir_ui_query`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs fhir_ui_query}}

### `app_query`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs app_query}}

### `seed_app`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs seed_app}}

### `park_and_approve`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs park_and_approve}}

### `APPROVE_APP`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs APPROVE_APP}}

### `APPROVE_FHIR_UI`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs APPROVE_FHIR_UI}}

### `pairing_next`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs pairing_next}}

### `code_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs code_of}}

### `post_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs post_token}}

### `redeem`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs redeem}}

### `family_sid`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs family_sid}}

### `sid_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs sid_of}}

### `start_pairing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_required.rs start_pairing}}

## `integration::session_shortfall`

The helpers of [Session Shortfall](<Session Shortfall Explanation.md>).

### `app_query`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs app_query}}

### `seed_app`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs seed_app}}

### `APPROVE_APP`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs APPROVE_APP}}

### `limited_browser`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs limited_browser}}

### `approve_a_standing_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs approve_a_standing_grant}}

### `redeem`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs redeem}}

### `code_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/session_shortfall.rs code_of}}

## `integration::wait_page`

The helpers of [Wait Page](<Wait Page Explanation.md>).

### `get`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs get}}

### `header`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/wait_page.rs header}}

## `integration::consent_card`

The helpers of [Consent Card](<Consent Card Explanation.md>).

### `REQUESTED_SCOPES`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs REQUESTED_SCOPES}}

### `authorize_with_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs authorize_with_cookie}}

### `parked_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs parked_page}}

### `decide`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs decide}}

### `status_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs status_of}}

### `parked_on_the_card`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/consent_card.rs parked_on_the_card}}

## `integration::approval_scopes`

The helpers of [Approval Scopes](<Approval Scopes Explanation.md>).

### `REQUESTED_SCOPES`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs REQUESTED_SCOPES}}

### `APPROVER_SCOPES`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs APPROVER_SCOPES}}

### `APPROVE_REQUESTED`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs APPROVE_REQUESTED}}

### `approved_browser_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs approved_browser_token}}

### `approver_scopes_without`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs approver_scopes_without}}

### `parked_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs parked_request}}

### `request_status`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs request_status}}

### `assert_refused_for_lacking`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs assert_refused_for_lacking}}

### `ask_owner`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs ask_owner}}

## `integration::device_page`

The helpers of [Device Page](<Device Page Explanation.md>).

### `DeviceAuthorization`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs DeviceAuthorization}}

### `start_device_flow`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs start_device_flow}}

### `device_consent_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs device_consent_request}}

### `poll`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/device_page.rs poll}}

## `integration::browser_pairing`

The helpers of [Browser Pairing](<Browser Pairing Explanation.md>).

### `FIREFOX_LINUX_USER_AGENT`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs FIREFOX_LINUX_USER_AGENT}}

### `NEXT`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs NEXT}}

### `StartedPairing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs StartedPairing}}

### `post_json`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs post_json}}

### `start_pairing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs start_pairing}}

### `poll`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs poll}}

### `poll_status`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs poll_status}}

### `approve`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs approve}}

### `paired_session_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs paired_session_token}}

## `integration::browser_sessions`

The helpers of [Browser Sessions](<Browser Sessions Explanation.md>).

### `sid_of`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs sid_of}}

### `post_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs post_token}}

### `authorization_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs authorization_request}}

### `listed_browser_sessions`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs listed_browser_sessions}}

### `sign_out`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_sessions.rs sign_out}}

## `integration::token_revocation`

The helpers of [Token Revocation](<Token Revocation Explanation.md>).

### `APP_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs APP_CLIENT_ID}}

### `OTHER_CLIENT_ID`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs OTHER_CLIENT_ID}}

### `seed_public_clients`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs seed_public_clients}}

### `post_form_body`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs post_form_body}}

### `revoke`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs revoke}}

### `refresh`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs refresh}}

### `assert_revocation_answered`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs assert_revocation_answered}}

### `assert_refresh_revoked`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/token_revocation.rs assert_refresh_revoked}}

## `integration::cache_suppression`

The helpers of [Cache Suppression](<Cache Suppression Explanation.md>).

### `owner_get`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/cache_suppression.rs owner_get}}

## `integration::authorization_start_limit`

The helpers of [Authorization Start Limit](<Authorization Start Limit Explanation.md>).

### `REQUESTED_SCOPES`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs REQUESTED_SCOPES}}

### `CountingGate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate}}

#### `CountingGate::refusing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::refusing}}

#### `CountingGate::asked`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::asked}}

#### `CountingGate::admit`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs CountingGate::admit}}

### `send`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs send}}

### `owner_decided_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs owner_decided_request}}

### `ask_owner`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs ask_owner}}

### `is_decidable_in_requesting_browser`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/authorization_start_limit.rs is_decidable_in_requesting_browser}}
