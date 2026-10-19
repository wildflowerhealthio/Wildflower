# Approval Scopes

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs}}

The Owner can approve anything. An approved browser, one whose browser session holds less than the Owner's, may approve a request too, but **only if it could create everything the approval creates**. Those are the request's **approval scopes**:

| Approval scope                           | Why                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wildflower/AuthorizationRequest.u`      | Every approval decides a request.                                                                                                                |
| `wildflower/Grant.c`                     | A code or device approval records a standing grant.                                                                                              |
| `wildflower/Client.c` and `Client.u`     | A code approval for a client trusted on first use creates or widens its registration. Both, whatever the row looks like when the approval lands. |
| the resource scopes the request asks for | A code approval approves the request as asked, so the approver must hold what it passes on.                                                      |

A refused approval is `403 InsufficientScope`, naming the scopes it lacks, and the request stays pending for the Owner. The same list is shown in three places, from one function ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::missing_approval_scopes}}), so they never disagree:

- the approve call refuses on it ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}}),
- the consent read reports it as `missingApprovalScopes`,
- `/oauth/authorize` sends the browser to the consent card only when it lacks none, and to the wait page otherwise.

Read the [Authorization Request](<../Domain/Authorization Request Explanation.md>) page first; the [Session Shortfall](<Session Shortfall Explanation.md>) and [Wait Page](<Wait Page Explanation.md>) pages cover the pages these tests route between.

## Helpers

The test client asks for one resource scope and `openid`. The approver set holds every approval scope that request can need, plus `wildflower/AuthorizationRequest.r` to read it:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs REQUESTED_SCOPES}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs APPROVER_SCOPES}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs APPROVE_REQUESTED}}

An approved browser is stood up by signing a browser in as the Owner and minting a token under its session holding only the scopes given. To the gates, that's a browser session holding those scopes. A test drops one scope at a time from the full set:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs approved_browser_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs approver_scopes_without}}

A request parked for the Owner by the harness's paired browser, its status as the wait page polls it, the refusal every negative test expects, and the "ask the server's owner" call:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs parked_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs request_status}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs assert_refused_for_lacking}}

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs ask_owner}}

## `an_approved_browser_approves_a_registered_app_within_its_own_scopes`

**An approved browser holding every approval scope approves like the Owner.** The consent read lacks nothing, and the approval lands.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_approves_a_registered_app_within_its_own_scopes}}

Relies on [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>).

## `an_approved_browser_without_grant_create_cannot_approve_a_code_request`

**No `wildflower/Grant.c`, no code approval.** Approving an app's request records a standing grant, so a browser that can't create grants is refused, and the request stays pending.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_grant_create_cannot_approve_a_code_request}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#authorizationcodegrant>).

## `an_approved_browser_without_grant_create_cannot_approve_a_device_request`

**The same holds for a device.** A browser that can read and decide requests, but not create grants, is refused a device approval, because it records a standing device grant. The request stays pending.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_grant_create_cannot_approve_a_device_request}}

Relies on [`DeviceGrant`](<../Domain/Grant Explanation.md#devicegrant>); the device approval is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/device.rs ConsentDecider::approve_device_consent}}.

## `an_approved_browser_without_client_update_cannot_register_a_new_app`

**Registering a new app takes both client scopes.** `wildflower/Client.c` alone is refused, and the refused approval registers nothing. A browser holding both then approves the same request.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_client_update_cannot_register_a_new_app}}

Relies on [`registration_is_fixed`](<../Domain/Client Explanation.md#registration_is_fixed>).

## `an_approved_browser_without_client_create_cannot_widen_an_app`

**Widening an app's registration takes both client scopes too.** `wildflower/Client.u` alone is refused. Requiring both means an approval never depends on whether the row exists by the time it lands.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_approved_browser_without_client_create_cannot_widen_an_app}}

Relies on [`registration_is_fixed`](<../Domain/Client Explanation.md#registration_is_fixed>); whether an approval writes the registration is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::writes_registration}}.

## `an_owner_session_lacks_no_approval_scope`

**The Owner's scopes cover every approval scope.** An Owner session lacks nothing and registers a new app on approval.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs an_owner_session_lacks_no_approval_scope}}

Relies on [`new_owner`](<../Domain/Browser Session Explanation.md#new_owner>).

## `a_browser_session_without_grant_create_goes_to_the_wait_page`

**A browser that couldn't approve its own request isn't shown the consent card.** Without `wildflower/Grant.c`, `/oauth/authorize` sends it to the wait page. With it, the same request goes to the consent card.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_without_grant_create_goes_to_the_wait_page}}

## `a_browser_session_without_client_update_starting_a_new_app_s_request_waits_for_the_owner`

**A browser that can't register a new app waits for the Owner.** Its request for an unregistered app goes to the wait page and is not decidable in that browser, so the host raises it for the Owner. With both client scopes, the same browser decides it on the consent card.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_without_client_update_starting_a_new_app_s_request_waits_for_the_owner}}

Relies on [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>) and [`CodeRequest`](<../Domain/Authorization Request Explanation.md#the-code-request>)'s `decidable_in_requesting_browser`.

## `a_browser_session_lacking_a_requested_resource_scope_waits_for_the_owner`

**A browser lacking a resource scope the app asks for can't approve the request as asked.** Its session falls short of the request, so `/oauth/authorize` sends it to the limited page first, and the Owner hears nothing yet. Continuing sends it to the wait page and raises the request for the Owner. The consent read names the missing resource scope.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs a_browser_session_lacking_a_requested_resource_scope_waits_for_the_owner}}

Relies on [`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>) and [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>).

## `asking_the_owner_raises_a_request_decidable_in_the_requesting_browser`

**"Ask the server's owner" really hands the request to the Owner.** A request its own browser could decide stops counting as decidable there, so the host notifies the Owner. It stays pending. A browser that can only read requests may ask. Once the Owner has decided, there is nothing left to ask about: `404`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/approval_scopes.rs asking_the_owner_raises_a_request_decidable_in_the_requesting_browser}}

Relies on [`raise_for_owner`](<../Domain/Authorization Request Explanation.md#raise_for_owner>).
