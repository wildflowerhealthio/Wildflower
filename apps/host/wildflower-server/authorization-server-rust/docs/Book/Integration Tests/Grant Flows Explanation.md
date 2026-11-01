# Grant Flows

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs}}

These tests hold the server to its main promise: an app reaches the Owner's FHIR server only after the Owner said yes, now or in a standing grant, and never with more than the Owner and the browser it runs in hold. They drive the whole authorization-code flow over HTTP, from `/oauth/authorize` to `/oauth/token`, so this page starts with that flow as a story. The entities it moves through have their own pages: the [code request](<../Domain/Authorization Request/Code Request Explanation.md>), the [grant](<../Domain/Grant Explanation.md>), the [authorization code](<../Domain/Authorization Code Explanation.md>), the [browser session](<../Domain/Browser Session Explanation.md>) and the [client](<../Domain/Client Explanation.md>).

## The story

> The Owner has paired their laptop browser. They open **Wildflower Strength**, a SMART app, in that browser. Strength asks for `patient/Observation.rs` and `launch/patient`.

### The front door: no session, no request

The browser lands on `GET /oauth/authorize`. The first check is about the browser, not the app: does it carry a browser session?

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request from="// No browser session, no authorization" through="let Some((browser_session, browser_sid))"}}

**A code is always issued under a browser session (its `sid`).** Without one there is nothing to issue under and nothing to revoke later, so the browser is sent to pair first, with this request's path and query as where to come back to. Nothing is written yet, so the detour spends no SMART `launch` value.

Everything after this point runs in one write scope, in [`CodeAuthorizationStarter::start`](<../Capabilities/OAuth/Code Authorization Starter Explanation.md#item-CodeAuthorizationStarter--start>). Telling the Owner's popup about a new request happens after the scope closes.

### Three questions decide where the browser goes

The starter first validates the request: a signing key to mint with, a client that isn't disabled, PKCE, and the client's registration. A server-defined registration holds the request to its redirects and scopes. Any other client is trusted on first use: whatever steps outside its registration is carried to the Owner as a [presented client change](<../Domain/Client Explanation.md#item-PresentedClientChange>). Then three questions about the request pick the next step:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeNextStep}}

| Question, in the order asked                                     | Domain meaning                                                                                                                                                                  | If yes                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Does this browser's session hold less than the app asks for?** | The laptop was paired with read-only access, but the app wants write. The person at the browser is told before anyone else is bothered.                                         | The **limited page** (`ConfirmSessionShortfall`)           |
| **Does a standing grant already cover everything asked for?**    | The Owner said yes to this app at this redirect before and hasn't revoked it, the request changes nothing in the app's registration, and the launch admits the grant's patient. | [Issue a code now](#the-fast-path) (`RedirectToClient`)    |
| **Can this browser decide the request itself?**                  | The person at the browser is the Owner, holding enough to approve this request as asked.                                                                                        | The **consent card**, in place (`AwaitOwner`, decidable)   |
| _(otherwise)_                                                    | Someone else is using this browser.                                                                                                                                             | The **wait page**, and the Owner's popup shows the request |

The facts behind the three answers are worked out side by side, right before the request is parked:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="let decidable_in_requesting_browser" through="let waits_on_limited_page"}}

The second half of `waits_on_limited_page` means the limited page is shown **once per browser per app**: once this browser has pressed Continue for Strength, its later Strength requests skip the page, whatever the session lacks. Continue and Cancel are the code request's own transitions, [`CodeRequest::acknowledge_session_shortfall`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--acknowledge_session_shortfall>) and [`CodeRequest::to_denied_on_limited_page`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied_on_limited_page>).

Every one of these paths, the fast path included, parks a [code request](<../Domain/Authorization Request/Code Request Explanation.md>) first. From then on the request changes only through its own transitions, each written as a guarded replace on its status ([the Authorization Request page](<../Domain/Authorization Request Explanation.md>)), so the first decision wins.

### The Owner decides

Strength's request is pending. The laptop isn't the Owner, so it went to the wait page, and the host app on the Owner's phone shows the request as the [Owner prompt](<../Domain/Owner Prompt Explanation.md>). The Owner ticks scopes and taps Approve, which arrives at [`ConsentDecider::approve_oauth_consent`](<../Capabilities/Access/OAuth Consents Explanation.md#item-ConsentDecider--approve_oauth_consent>). Before anything is written, the approval must earn a proof:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in from="let maybe_delegated_scopes" through="let Some(delegated_scopes)"}}

**You can't give away what you don't hold.** [`DelegatedScopes::clamp`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--clamp>) is the whole rule:

1. The approver must hold the prompt's **approval scopes**: the power to decide a request, to record a grant, to write the registration of a client trusted on first use, and every resource scope (or `wildflower/launch`) the request asks for. Missing any is a `403` that names them, whatever was ticked ([Approval Scopes](<Approval Scopes Explanation.md>)).
2. The ticks are clamped to what the prompt may grant: each must be covered by a requested scope and by the client's registration, which for a client trusted on first use takes in what it asked for.
3. Every resource scope that survives must be covered by the approver's own grant.

If nothing survives, the request is denied. Before that, a request that would change the app's registration needs the Owner to acknowledge so (a `409` otherwise). And when the SMART launch pinned a patient, the approval must name that patient ([`CodeRequest::admits_patient`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--admits_patient>)).

### Approving and issuing the code

Both paths to a code go through one writer method, [`RequestApprover::approve_for_code`](<../Writers/Request Approver Explanation.md#item-RequestApprover--approve_for_code>): the Owner's approval above, and the [fast path](#the-fast-path) below. It takes a `CodeAuthority`, an enum with exactly two variants. **That enum is the complete answer to "what can cause a code to be issued?"**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code from="let Some(browser_session) =" through="self.tx.issue_authorization_code"}}

Three rules, in the order they run:

1. **The requesting browser must still be live.** If the laptop was signed out while the Owner decided, the approval becomes a denial and Strength hears `access_denied`. There's no session left to issue under.
2. **The request records what the authority allowed** (the [approval](<../Domain/Authorization Request Explanation.md#item-Approval>)'s granted scopes): the Owner's delegated scopes, or the requested scopes the standing grant covered ([`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>)).
3. **The code carries that, intersected with the browser's session** ([`session_bounded_scopes`](<../Authority/Delegated Scopes Explanation.md#item-session_bounded_scopes>)). A browser paired read-only earns its apps read-only access, whoever approved. The code also carries the `sid`, so revoking the laptop later ends everything Strength earned there.

On the Owner's path, the same write scope then records the **grant** for (Strength, its redirect), unioned into any grant already there, and for a client trusted on first use creates or widens its registration ([`GrantRecorder::record_code_grant`](<../Writers/Grant Recorder Explanation.md#item-GrantRecorder--record_code_grant>)). The code, the grant and the registration land together or not at all. The grant is what lets the next request's second question answer yes. On the fast path, the same scope stamps the standing grant's `last_used_at` instead.

### The fast path

The fast path is the one place a code is issued with no person deciding:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs fast_path_coverage}}

[`GrantCoverage::resolve`](<../Authority/Standing Grant Explanation.md#item-GrantCoverage--resolve>) answers `Full` only when the request makes no change to the client's registration (its [presented client change](<../Domain/Client Explanation.md#item-PresentedClientChange>) is `NoChange`) **and** the standing grant for that client and redirect covers every requested scope. Coverage is by permission, not spelling ([`allowed_scope_covers`](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>)): a grant for `patient/Observation.rs` answers a request for `patient/Observation.r`. A request that is new or steps outside the registration never takes the fast path, however well an old grant covers it: the Owner hasn't seen that combination. The browser session's part was settled by the first question: a request still waiting on its limited page never gets this far.

### Redemption: the code is spent once

The browser is sent back to Strength's redirect with `?code=…&state=…`. Strength posts the code and its PKCE verifier to `/oauth/token`, which builds the proof [`RedeemedAuthorizationCode`](<../Authority/Redemption Explanation.md#item-RedeemedAuthorizationCode--redeem>):

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem from="// A concurrent redemption" through="let Some(code)"}}

**A code presented twice means someone else has seen it.** The second presentation fails, and it also expires every refresh family the first redemption started. The attacker gets nothing, and the real app has to ask again.

The code is consumed before its bindings are checked: same client, same redirect, not expired, and the PKCE verifier matching the challenge. A code that fails any of them is spent all the same, and every failure reads `invalid_grant` on the wire. The token then carries the code's scopes, which the session already bounded. Its `scope` claim adds each SMART scope's other spelling ([`with_alternate_canonical_forms`](<../Domain/Scopes Explanation.md#item-with_alternate_canonical_forms>)), so the FHIR server can read either.

### Where the story lands

Follow the scopes and each step can only narrow them:

```text
asked for      ∩ registration           → approvable          (the Owner decides)
approvable     ∩ Owner's ticks, ⊆ Owner → DelegatedScopes     (the Owner decides)
DelegatedScopes                         → Approval on request (approving: the record)
DelegatedScopes ∩ browser session       → code's scopes       (approving: what's issued)
code's scopes                           → token's scopes      (redemption)
```

On the fast path the standing grant's coverage stands in for `DelegatedScopes`. When you review a change to this crate, ask which arrow it touches. If it touches none, it shouldn't be able to change what anyone can access. If it touches one, the proof or writer at that arrow is where to look.

## `integration::grant_flows`

### `auth_code_grant_happy_path_end_to_end`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_happy_path_end_to_end}}

Relies on [`CodeRequest::to_approved`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>), [`AuthorizationCode`](<../Domain/Authorization Code Explanation.md#item-AuthorizationCode>) and [`mint_access_token`](<../Domain/Access Token Explanation.md#item-mint_access_token>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`seed_client_with_redirect`](<Test Fixtures Explanation.md#item-seed_client_with_redirect>), [`CODE_VERIFIER`](<Test Fixtures Explanation.md#item-CODE_VERIFIER>), [`build_request`](<Test Fixtures Explanation.md#item-build_request>), [`browser_session_cookie`](<Test Fixtures Explanation.md#item-common--browser_session_cookie>), [`polling_request_id`](<Test Fixtures Explanation.md#item-polling_request_id>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`get_authorization_status`](<Test Fixtures Explanation.md#item-get_authorization_status>) and [`assert_cache_suppressed`](<Test Fixtures Explanation.md#item-assert_cache_suppressed>).

### `oauth_consent_prompt_carries_client_display_name`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs oauth_consent_prompt_carries_client_display_name}}

Relies on [`ResolvedCodeRequest::client_name`](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--client_name>).

### `auth_code_grant_owner_narrows_requested_scope`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_owner_narrows_requested_scope}}

Relies on [the clamp](#the-owner-decides) and [`grantable_scopes`](<../Domain/Scopes Explanation.md#item-grantable_scopes>). Fixtures first used here: [`paired_browser_session_holding`](<Test Fixtures Explanation.md#item-paired_browser_session_holding>).

### `an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending}}

Relies on [the approval scopes](#the-owner-decides) and [`CodeRequest::require_pending`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--require_pending>). Fixtures first used here: [`parked_request_id`](<Test Fixtures Explanation.md#item-parked_request_id>), [`get_authorize`](<Test Fixtures Explanation.md#item-get_authorize>), [`authorize_query`](<Test Fixtures Explanation.md#item-authorize_query>), [`mint_scoped_token`](<Test Fixtures Explanation.md#item-mint_scoped_token>) and [`approve_oauth_consent`](<Test Fixtures Explanation.md#item-approve_oauth_consent>).

### `minted_jwt_scope_claim_carries_alternate_canonical_forms`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs minted_jwt_scope_claim_carries_alternate_canonical_forms}}

Relies on [redemption](#redemption-the-code-is-spent-once) and [`with_alternate_canonical_forms`](<../Domain/Scopes Explanation.md#item-with_alternate_canonical_forms>). Fixtures first used here: [`authorize_and_approve`](<Test Fixtures Explanation.md#item-authorize_and_approve>) and [`decode_jwt_payload`](<Test Fixtures Explanation.md#item-decode_jwt_payload>).

### `consent_approval_persists_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_approval_persists_grant}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant>).

### `pre_approved_scopes_skip_consent_on_reauthorize`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs pre_approved_scopes_skip_consent_on_reauthorize}}

Relies on [the fast path](#the-fast-path) and [`CodeAuthority`](#approving-and-issuing-the-code).

### `reauthorizing_under_a_standing_grant_stamps_its_last_use`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs reauthorizing_under_a_standing_grant_stamps_its_last_use}}

Relies on [the fast path](#the-fast-path) and [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant>)'s `last_used_at`. Fixtures first used here: [`owner_grants_probe`](<Test Fixtures Explanation.md#item-owner_grants_probe>) and [`location_of`](<Test Fixtures Explanation.md#item-location_of>).

### `a_narrower_request_is_pre_approved_by_a_broader_standing_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs a_narrower_request_is_pre_approved_by_a_broader_standing_grant}}

Relies on [the fast path](#the-fast-path)'s coverage, [`allowed_scope_covers`](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>).

### `consent_approvals_union_scopes_into_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_approvals_union_scopes_into_grant}}

Relies on [`AuthorizationCodeGrant::absorb_reapproval`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant--absorb_reapproval>).

### `auth_code_grant_wrong_verifier_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_wrong_verifier_rejected}}

Relies on [redemption](#redemption-the-code-is-spent-once). Fixtures first used here: [`plant_authorization_code`](<Test Fixtures Explanation.md#item-plant_authorization_code>), [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>) and [`post_form`](<Test Fixtures Explanation.md#item-post_form>).

### `auth_code_grant_expired_code_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_expired_code_rejected}}

Relies on [`AuthorizationCode`](<../Domain/Authorization Code Explanation.md#item-AuthorizationCode>)'s `expires_at` and [redemption](#redemption-the-code-is-spent-once).

### `auth_code_grant_replay_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_replay_rejected}}

Relies on [redemption](#redemption-the-code-is-spent-once).

### `auth_code_replay_revokes_issued_refresh_family`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_replay_revokes_issued_refresh_family}}

Relies on [redemption](#redemption-the-code-is-spent-once) and [`RefreshTokenFamily`](<../Domain/Refresh Token Explanation.md#item-RefreshTokenFamily>).

### `consent_prompt_reports_the_presented_client_change`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_prompt_reports_the_presented_client_change}}

Relies on [`PresentedClientChange`](<../Domain/Client Explanation.md#item-PresentedClientChange>). Fixtures first used here: [`get_oauth_consent`](<Test Fixtures Explanation.md#item-get_oauth_consent>).

### `approving_a_new_app_without_acknowledgement_is_rejected`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_new_app_without_acknowledgement_is_rejected}}

Relies on [`PresentedClientChange::would_change_registration`](<../Domain/Client Explanation.md#item-PresentedClientChange--would_change_registration>).

### `approving_a_new_app_registers_it_and_the_next_request_fast_paths`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_new_app_registers_it_and_the_next_request_fast_paths}}

Relies on [`Client`](<../Domain/Client Explanation.md#item-Client>), [the grant and registration writes](#approving-and-issuing-the-code) and [the fast path](#the-fast-path).

### `approving_a_changed_app_widens_its_registration`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_changed_app_widens_its_registration}}

Relies on [`PresentedClientChange`](<../Domain/Client Explanation.md#item-PresentedClientChange>) and [the registration write](#approving-and-issuing-the-code).

### `denying_a_new_app_registers_nothing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs denying_a_new_app_registers_nothing}}

Relies on [`CodeRequest::to_denied`](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_denied>).

### `a_changed_request_never_takes_the_fast_path`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs a_changed_request_never_takes_the_fast_path}}

Relies on [the fast path](#the-fast-path)'s registration gate and [`ResolvedCodeRequest::presented_client_change`](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--presented_client_change>).
