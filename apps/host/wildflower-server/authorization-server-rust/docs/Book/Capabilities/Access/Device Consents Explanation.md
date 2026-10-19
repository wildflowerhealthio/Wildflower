# Device Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs}}

The device page is where a code shown somewhere else gets decided. A device (a watch, a TV) shows a user code from the device flow; a browser that isn't the Owner's shows one from a [browser pairing](<../../Authority/Browser Pairing Explanation.md>). The approver opens `/authorization/devices/{userCode}`, sees what is asked, and approves or denies. The capabilities are on [Consents](<Consents Explanation.md>).

**Device consent is expandable**: the approver may grant more than the device asked for, up to an envelope. For a device the envelope is the app's registered `allowed_scopes`; for a browser pairing it is the Owner's scopes, so no paired browser can hold more than an Owner session. Either way, the [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) clamp also bounds every resource scope by what the approver holds.

A device approval records a standing **device grant**, keyed by the app and the device's name. A pairing records no grant: the pairing page's poll starts the approved browser session once the request is approved.

## The prompt

**A device-page prompt exists while its request is pending and is a device request or a pairing.** Anything else under the code, a code-flow request included, is not found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs load_pending_request_by_user_code}}

## `device_consent`

**The device page's read**: the request, the app's name, the scopes the card's ticks start from, the envelope, and the approval scopes the reader lacks. The request and the app's row are read in one read scope; the view is built from them after it closes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentReader::device_consent}}

For a device, the ticks start from what it requested and the envelope is the app's registration; an app with no row shows its `client_id` and an empty envelope. For a pairing, the ticks start from [everything the reader may delegate](<../../Authority/Delegated Scopes Explanation.md#delegable_scopes>), so a narrower approver's card opens with what it holds, and the envelope is the Owner's scopes.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::consent_reader_says_which_approval_scopes_a_device_prompt_takes}}

A reader able to read and decide is told a device request also takes `wildflower/Grant.c`, and a pairing takes nothing more.

Exercised end to end by [`device_authorization_carries_device_name_to_consent`](<../../Integration Tests/Device Code Explanation.md#device_authorization_carries_device_name_to_consent>), [`device_authorization_infers_device_name_from_user_agent_when_unnamed`](<../../Integration Tests/Device Code Explanation.md#device_authorization_infers_device_name_from_user_agent_when_unnamed>), [`explicit_device_name_wins_over_user_agent_inference`](<../../Integration Tests/Device Code Explanation.md#explicit_device_name_wins_over_user_agent_inference>) and [`a_narrower_approver_s_card_opens_with_what_it_may_delegate`](<../../Integration Tests/Browser Pairing Explanation.md#a_narrower_approver_s_card_opens_with_what_it_may_delegate>).

## `approve_device_consent`

**The approver approves the code: the request's approval and, for a device, its standing grant land together in one write scope.** The newest pending consent is republished once it has committed. The outcome carries no redirect; the device or the pairing page learns of it by polling.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_device_consent}}

For a device, the app's row is the envelope, so a device whose app has no row is not found. The clamp comes first: it refuses an approver lacking an approval scope (`InsufficientScope`) or a resource scope it doesn't hold (`InsufficientApproverScope`), each writing nothing, and a clamp that leaves nothing is a deny. Then the [request approver](<../../Writers/Request Approver Explanation.md>) records the approval, under the approver's name for the device when it gave one, and the [grant recorder](<../../Writers/Grant Recorder Explanation.md>) records the device grant, or widens the one already standing for that device. The grant is named after the approver's name for the device, else the device's own, else the app's ([`device_grant_name`](<../../Domain/Authorization Request Explanation.md#device_grant_name>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_device_in}}

A pairing is clamped to the Owner's scopes and the approver's own, and the request is approved under the browser name the approver left. Nothing else is written.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_browser_pairing_in}}

Both rest on the request's own transitions, [`approve_device`](<../../Domain/Authorization Request Explanation.md#approve_device>) and [`approve_pairing`](<../../Domain/Authorization Request Explanation.md#approve_pairing>). A request decided by someone else since it was read is not found.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_expands_to_client_allowed_and_republishes}}

The device asked for `openid`; the approver grants `read`, which the app's registration allows. The approval stands, the device grant under the approver's name holds `read`, and the newest pending consent is republished once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_rejects_a_resource_scope_the_approver_cannot_delegate}}

An approver holding `system/Observation.r` can't grant `system/Patient.r`: `InsufficientApproverScope` naming it, nothing republished.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_allows_a_resource_scope_the_approver_holds}}

An approver holding `system/*.cruds` can.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent_requires_creating_the_grant_but_a_pairing_does_not}}

An approver who may only decide is refused a device request, naming `wildflower/Grant.c`, with no grant written and nothing republished; the same approver approves a pairing.

Exercised end to end by [`device_consent_clamps_granted_scopes_to_client_allowed`](<../../Integration Tests/Device Code Explanation.md#device_consent_clamps_granted_scopes_to_client_allowed>), [`device_consent_allows_expansion_beyond_requested`](<../../Integration Tests/Device Code Explanation.md#device_consent_allows_expansion_beyond_requested>), [`device_consent_threads_patient_onto_request`](<../../Integration Tests/Device Code Explanation.md#device_consent_threads_patient_onto_request>), [`device_consent_approver_can_adjust_device_name`](<../../Integration Tests/Device Code Explanation.md#device_consent_approver_can_adjust_device_name>), [`device_approval_mints_durable_grant_and_links_refresh_family`](<../../Integration Tests/Device Code Explanation.md#device_approval_mints_durable_grant_and_links_refresh_family>), [`a_browser_session_approves_the_code_and_the_device_poll_succeeds`](<../../Integration Tests/Device Page Explanation.md#a_browser_session_approves_the_code_and_the_device_poll_succeeds>), [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>), [`an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s`](<../../Integration Tests/Browser Pairing Explanation.md#an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s>) and [`an_approved_browser_without_grant_create_cannot_approve_a_device_request`](<../../Integration Tests/Approval Scopes Explanation.md#an_approved_browser_without_grant_create_cannot_approve_a_device_request>).

## `deny_device_consent`

**The approver declines the code.** In one write scope the request is loaded and [denied](<Consents Explanation.md#deny_pending_request>), and the newest pending consent is republished. The device's next poll hears `access_denied`; a pairing page sets no cookie.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::deny_device_consent}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::deny_device_consent_marks_denied_and_republishes}}

The request is denied and the newest pending consent republished once; an unknown code is `DeviceConsentNotFound`.

Exercised end to end by [`a_declined_pairing_sets_no_cookie`](<../../Integration Tests/Browser Pairing Explanation.md#a_declined_pairing_sets_no_cookie>).
