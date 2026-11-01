# Approval Scopes

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs}}

The Owner can approve anything. A paired browser, one whose browser session holds less than the Owner's, may approve a request too, but **only if it could create everything the approval creates**. Those are the request's **approval scopes**:

- `wildflower/AuthorizationRequest.u`, because every approval decides a request.
- `wildflower/Grant.c`, because a code or device approval records a standing [grant](<../Domain/Grant Explanation.md>).
- Both `wildflower/Client.c` and `wildflower/Client.u` for a code approval for a client trusted on first use, because it creates or widens the client's registration. It takes both whatever the row looks like when the approval lands, so an approval never turns on whether the row exists yet.
- The resource scopes a code-flow request asks for, because the approval approves the request as asked and the approver must hold what it passes on.

A refused approval is `403 InsufficientScope`, naming the scopes it lacks, and the request stays pending for the Owner. The same list is shown in three places, from one function ([`ApprovableScopes::missing_approval_scopes`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--missing_approval_scopes>)), so they never disagree: the approve call refuses on it ([`DelegatedScopes::clamp`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--clamp>)), the consent read reports it as `missingApprovalScopes`, and `/oauth/authorize` sends the browser to the [Consent Card](<Consent Card Explanation.md>) only when it lacks none, and to the [Wait Page](<Wait Page Explanation.md>) otherwise.

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationapproval_scopes>) page, with the shared ones.

## `integration::approval_scopes`

### `an_approved_browser_approves_a_registered_app_within_its_own_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_approves_a_registered_app_within_its_own_scopes}}

Relies on [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`approved_browser_token`](<Test Fixtures Explanation.md#item-approved_browser_token>), [`APPROVER_SCOPES`](<Test Fixtures Explanation.md#item-APPROVER_SCOPES>), [`parked_request`](<Test Fixtures Explanation.md#item-parked_request>), [`get_oauth_consent`](<Test Fixtures Explanation.md#item-get_oauth_consent>), [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>), [`APPROVE_REQUESTED`](<Test Fixtures Explanation.md#item-APPROVE_REQUESTED>) and [`body_json`](<Test Fixtures Explanation.md#item-body_json>).

### `an_approved_browser_without_client_update_cannot_register_a_new_app`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_client_update_cannot_register_a_new_app}}

Relies on [`Client::is_registration_fixed`](<../Domain/Client Explanation.md#item-Client--is_registration_fixed>) and [`DelegatedScopes::would_write_registration`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--would_write_registration>). Fixtures first used here: [`approver_scopes_without`](<Test Fixtures Explanation.md#item-approver_scopes_without>), [`assert_refused_for_lacking`](<Test Fixtures Explanation.md#item-assert_refused_for_lacking>), [`request_status`](<Test Fixtures Explanation.md#item-request_status>) and [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>).

### `an_approved_browser_without_client_create_cannot_widen_an_app`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_client_create_cannot_widen_an_app}}

Relies on [`DelegatedScopes::would_write_registration`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--would_write_registration>).

### `an_approved_browser_without_grant_create_cannot_approve_a_code_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_grant_create_cannot_approve_a_code_request}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant>).

### `an_approved_browser_without_grant_create_cannot_approve_a_device_request`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_grant_create_cannot_approve_a_device_request}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#item-DeviceGrant>); the device approval is [`ConsentDecider::approve_device_consent`](<../Capabilities/Access/Device Consents Explanation.md#item-ConsentDecider--approve_device_consent>). Fixtures first used here: [`plant_device_request`](<Test Fixtures Explanation.md#item-plant_device_request>) and [`build_request`](<Test Fixtures Explanation.md#item-build_request>).

### `a_same_device_session_lacks_no_approval_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_same_device_session_lacks_no_approval_scope}}

Relies on [`BrowserSession::new_same_device_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_same_device_session>). Fixtures first used here: [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>).

### `a_browser_session_without_grant_create_goes_to_the_wait_page`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_without_grant_create_goes_to_the_wait_page}}

Relies on [`ApprovableScopes::missing_approval_scopes`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--missing_approval_scopes>). Fixtures first used here: [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`REQUESTED_SCOPES`](<Test Fixtures Explanation.md#item-approval_scopes--REQUESTED_SCOPES>) and [`location_of`](<Test Fixtures Explanation.md#item-location_of>).

### `a_browser_session_without_client_update_starting_a_new_app_s_request_waits_for_the_owner`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_without_client_update_starting_a_new_app_s_request_waits_for_the_owner}}

Relies on [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>) and the [`CodeRequest`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest>)'s `decidable_in_requesting_browser`. Fixtures first used here: [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>).

### `a_browser_session_lacking_a_requested_resource_scope_waits_for_the_owner`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_lacking_a_requested_resource_scope_waits_for_the_owner}}

Relies on [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) and [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>). Fixtures first used here: [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`limited_request_id`](<Test Fixtures Explanation.md#item-limited_request_id>) and [`continue_past_session_shortfall`](<Test Fixtures Explanation.md#item-continue_past_session_shortfall>).

### `asking_the_owner_raises_a_request_decidable_in_the_requesting_browser`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs asking_the_owner_raises_a_request_decidable_in_the_requesting_browser}}

Relies on [`CodeRequest::to_raised_for_owner`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_raised_for_owner>). Fixtures first used here: [`ask_owner`](<Test Fixtures Explanation.md#item-approval_scopes--ask_owner>) and [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>).
