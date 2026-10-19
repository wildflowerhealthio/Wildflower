# Consent Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/deny.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/ask_owner.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/approve.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/deny.rs}}

A request that needs a decision is a **consent prompt**, and these routes are where it is read and decided. There are two surfaces. The **code-flow prompt** is an app's `/oauth/authorize` request, keyed by the request's id, which the consent card shows. The **device page's prompt** is keyed by the short user code the device page asks for: a device's request through the device flow, or a browser asking to be paired.

Both surfaces live under `/authorization`, so a caller is first held to a valid, unrevoked bearer token by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}} (a `401` without one), and no answer is cached. Each handler then acquires its capability through `Scoped<…>`: **reading a prompt takes `wildflower/AuthorizationRequest.r`, deciding one takes `wildflower/AuthorizationRequest.u`**, and a token without the scope gets a `403` naming it. The Owner holds both. A paired browser holds only what its pairing granted, so it may be able to read a prompt it can't decide.

The rules of a decision (what an approval may grant, the acknowledgement, the patient, the race with another surface) belong to the capability: [OAuth Consents](<../../Capabilities/Access/OAuth Consents Explanation.md>) for the code flow and [Device Consents](<../../Capabilities/Access/Device Consents Explanation.md>) for the device page. The routes read the body, pass the server's clock, and put the outcome on the wire. The shapes both surfaces share, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ConsentResult}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/wire_representations.rs ApproveBody}}, are on [Errors and Wire Shapes](<../Errors and Wire Shapes Explanation.md>).

## `oauth_consents::router`

The code-flow prompt's route table: read, approve, deny, and ask the Owner. Asking the Owner raises the request for the Owner's attention, so that route alone is wrapped in the deferred authorization start limit the caller passes in ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs defer_authorization_start_limit}}).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/mod.rs router}}

## `handle_get_oauth_consent`

`GET /authorization/oauth-consents/{id}`. **The consent card loads the prompt it is about to show.** It goes through `Scoped<LiveConsentReader>` ([`oauth_consent`](<../../Capabilities/Access/OAuth Consents Explanation.md#oauth_consent>)), which resolves the request against the app's registration as it stands now. The answer is `404` when the id names no live code-flow prompt: unknown, decided, expired, still waiting on its own browser's limited page, or for an app disabled since.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs handle_get_oauth_consent}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs OAuthConsent}}

| Field                   | What the card does with it                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clientName`            | Names the app: its registered name, or its `client_id` when it has no row.                                                                                   |
| `scopes`                | Everything the app asked for.                                                                                                                                |
| `redirectUri`           | Where the app will be sent back to.                                                                                                                          |
| `preApprovedScopes`     | The scopes a standing grant already covers, ticked to start with.                                                                                            |
| `patient`               | The patient the request's SMART launch bound, when it bound one.                                                                                             |
| `registration`          | The warning the card leads with ([`ClientRegistrationBody`](#clientregistrationbody)), which makes the acknowledgement mandatory when it isn't `registered`. |
| `missingApprovalScopes` | The approval scopes the caller's own token lacks to approve this request. Empty when it may approve; otherwise the card offers to ask the Owner instead.     |

Exercised end to end by [`oauth_consent_prompt_carries_client_display_name`](<../../Integration Tests/Grant Flows Explanation.md#oauth_consent_prompt_carries_client_display_name>), [`oauth_consent_prompt_is_cache_suppressed`](<../../Integration Tests/Cache Suppression Explanation.md#oauth_consent_prompt_is_cache_suppressed>) and [`the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page`](<../../Integration Tests/Session Shortfall Explanation.md#the_owner_neither_sees_nor_decides_a_request_waiting_on_its_limited_page>).

## `ClientRegistrationBody`

The [registration verdict](<../../Domain/Client Explanation.md#clientregistrationverdict>) on the wire, tagged by `status`: `registered`, `new`, or `changed` with whether the redirect is new and which scopes are. The domain's `WouldWiden` is called `changed` here.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs ClientRegistrationBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/get.rs ClientRegistrationBody::from}}

## `handle_approve_oauth_consent`

`POST /authorization/oauth-consents/{id}/approve`. **The approver allows the request, with the scopes they ticked.** It goes through `Scoped<LiveConsentDecider>` ([`approve_oauth_consent`](<../../Capabilities/Access/OAuth Consents Explanation.md#approve_oauth_consent>)), which holds the approver's own grant, and hands it a fresh authorization code from {{#code-link apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_authorization_code}}.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs ApproveOAuthConsentBody}}

`acknowledgedRegistration` has no default. A client that hasn't been taught to show the registration warning can't approve a new or changed app by leaving the field out: its body fails to parse.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/approve.rs handle_approve_oauth_consent}}

| Answer                       | When                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`, `"status":"approved"` | The code is issued. `redirect` is the app's callback carrying it and the app's `state`, for the card to leave for.                                            |
| `200`, `"status":"denied"`   | Nothing was granted, the requesting browser's session has ended, or the app was disabled since: the request is denied and `redirect` carries `access_denied`. |
| `403`                        | The approver lacks an approval scope, or a ticked resource scope is beyond their own grant. Nothing is written.                                               |
| `409`                        | The warning wasn't acknowledged, or the body names a patient other than the one the launch bound. Nothing is written.                                         |
| `404`                        | No live code-flow prompt has this id.                                                                                                                         |

Exercised end to end by [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`approving_a_new_app_without_acknowledgement_is_rejected`](<../../Integration Tests/Grant Flows Explanation.md#approving_a_new_app_without_acknowledgement_is_rejected>), [`an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending`](<../../Integration Tests/Grant Flows Explanation.md#an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending>), [`an_approved_browser_without_grant_create_cannot_approve_a_code_request`](<../../Integration Tests/Approval Scopes Explanation.md#an_approved_browser_without_grant_create_cannot_approve_a_code_request>) and [`approving_a_request_whose_session_was_revoked_denies_it`](<../../Integration Tests/Browser Sessions Explanation.md#approving_a_request_whose_session_was_revoked_denies_it>).

## `handle_deny_oauth_consent`

`POST /authorization/oauth-consents/{id}/deny`. **The approver declines the request.** Through `Scoped<LiveConsentDecider>` ([`deny_oauth_consent`](<../../Capabilities/Access/OAuth Consents Explanation.md#deny_oauth_consent>)). The answer is `"status":"denied"` with the app's callback carrying `access_denied`, or `404` when no live prompt has the id.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/deny.rs handle_deny_oauth_consent}}

Exercised end to end by [`denying_a_new_app_registers_nothing`](<../../Integration Tests/Grant Flows Explanation.md#denying_a_new_app_registers_nothing>) and [`deciding_an_oauth_consent_clears_the_newest_pending_consent`](<../../Integration Tests/OAuth Endpoints Explanation.md#deciding_an_oauth_consent_clears_the_newest_pending_consent>).

## `handle_ask_owner`

`POST /authorization/oauth-consents/{id}/ask-owner`. **A browser that can read a prompt but not approve it hands it to the Owner.** The request stops counting as decidable in the browser that made it, so the host notifies the Owner. Nothing is decided. It takes only the read scope, through `Scoped<LiveConsentRaiser>` ([`raise_for_owner`](<../../Capabilities/Access/OAuth Consents Explanation.md#raise_for_owner>)).

Raising a request costs what starting one the Owner is asked about costs. The capability asks the start limit the layer deferred onto the request ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/authorization_start_limit.rs DeferredStartLimit::admits}}), and only when it is about to raise. A request already raised spends nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth_consents/ask_owner.rs handle_ask_owner}}

The answer is `204 No Content` whether it raised the request now or it was raised already, `429 Too Many Requests` when the limit refuses (the request left as it was), and `404` when no live prompt has the id.

Exercised end to end by [`asking_the_owner_raises_a_request_decidable_in_the_requesting_browser`](<../../Integration Tests/Approval Scopes Explanation.md#asking_the_owner_raises_a_request_decidable_in_the_requesting_browser>) and [`a_device_start_asks_the_gate_whatever_the_browser_session`](<../../Integration Tests/Authorization Start Limit Explanation.md#a_device_start_asks_the_gate_whatever_the_browser_session>).

## `devices::router`

The device page's route table: read, approve and deny, keyed by the user code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/mod.rs router}}

## `handle_get_device_consent`

`GET /authorization/devices/{userCode}`. **The device page loads the prompt for the code the approver typed.** Through `Scoped<LiveConsentReader>` ([`device_consent`](<../../Capabilities/Access/Device Consents Explanation.md#device_consent>)). The answer is `404` when the code names no live device-page prompt. A code-flow request never reaches the match below: the reader refuses one as not found.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs handle_get_device_consent}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs DeviceConsentKind}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/get.rs DeviceConsent}}

| Field                   | What the page does with it                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                  | `device` for a device's request, `browser` for a pairing.                                                                                            |
| `deviceName`            | The browser's name for a pairing; for a device, the name it gave or was inferred, if any.                                                            |
| `startingScopes`        | What the ticks start from: the device's requested scopes, or for a pairing everything the caller may delegate.                                       |
| `allowedScopes`         | How far the approver may expand: the app's whole registered scope list for a device, the Owner's scopes for a pairing. Device consent is expandable. |
| `missingApprovalScopes` | The approval scopes the caller's token lacks. Empty when it may approve; otherwise the page sends the approver to the device running the server.     |

Exercised end to end by [`device_authorization_carries_device_name_to_consent`](<../../Integration Tests/Device Code Explanation.md#device_authorization_carries_device_name_to_consent>), [`a_narrower_approver_s_card_opens_with_what_it_may_delegate`](<../../Integration Tests/Browser Pairing Explanation.md#a_narrower_approver_s_card_opens_with_what_it_may_delegate>), [`device_prompt_is_cache_suppressed`](<../../Integration Tests/Cache Suppression Explanation.md#device_prompt_is_cache_suppressed>) and [`unknown_device_404_is_cache_suppressed`](<../../Integration Tests/Cache Suppression Explanation.md#unknown_device_404_is_cache_suppressed>).

## `handle_approve_device_consent`

`POST /authorization/devices/{userCode}/approve`. **The approver allows the device or the browser, with the scopes they ticked**, and may rename the device first. Through `Scoped<LiveConsentDecider>` ([`approve_device_consent`](<../../Capabilities/Access/Device Consents Explanation.md#approve_device_consent>)). A device's approval leaves a standing device grant. A pairing's leaves none: the pairing page's poll starts the browser's session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/approve.rs handle_approve_device_consent}}

The answer is `"status":"approved"`, or `"status":"denied"` when nothing was granted, neither carrying a `redirect`: the device or the browser polls for its result. A `403` names an approval scope the approver lacks or a resource scope beyond their own grant, with nothing written. A `404` means no live prompt has the code.

Exercised end to end by [`device_consent_allows_expansion_beyond_requested`](<../../Integration Tests/Device Code Explanation.md#device_consent_allows_expansion_beyond_requested>), [`device_consent_approver_can_adjust_device_name`](<../../Integration Tests/Device Code Explanation.md#device_consent_approver_can_adjust_device_name>), [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>), [`a_browser_session_approves_the_code_and_the_device_poll_succeeds`](<../../Integration Tests/Device Page Explanation.md#a_browser_session_approves_the_code_and_the_device_poll_succeeds>) and [`an_approved_browser_without_grant_create_cannot_approve_a_device_request`](<../../Integration Tests/Approval Scopes Explanation.md#an_approved_browser_without_grant_create_cannot_approve_a_device_request>).

## `handle_deny_device_consent`

`POST /authorization/devices/{userCode}/deny`. **The approver declines the device or the browser.** Through `Scoped<LiveConsentDecider>` ([`deny_device_consent`](<../../Capabilities/Access/Device Consents Explanation.md#deny_device_consent>)). The answer is always `"status":"denied"` with no `redirect`, or `404` when no live prompt has the code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/devices/deny.rs handle_deny_device_consent}}

Exercised end to end by [`a_declined_pairing_sets_no_cookie`](<../../Integration Tests/Browser Pairing Explanation.md#a_declined_pairing_sets_no_cookie>).
