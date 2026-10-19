# Grant Flows

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs}}

These tests hold the server to its main promise: an app reaches the Owner's FHIR server only after the Owner said yes, now or in a standing grant, and never with more than the Owner and the browser it runs in hold. They drive the whole authorization-code flow over HTTP, from `/oauth/authorize` to `/oauth/token`, so this page starts with that flow as a story. The entities it moves through have their own pages: the [authorization request](<../Domain/Authorization Request Explanation.md>), the [grant](<../Domain/Grant Explanation.md>), the [authorization code](<../Domain/Authorization Code Explanation.md>), the [browser session](<../Domain/Browser Session Explanation.md>) and the [client](<../Domain/Client Explanation.md>). The test harness and its helpers are on the [Integration Tests](<../Integration Tests Explanation.md>) page.

## The story

> The Owner has paired their laptop browser. They open **Wildflower Strength**, a SMART app, in that browser. Strength asks for `patient/Observation.rs` and `launch/patient`.

### The front door: no session, no request

The browser lands on `GET /oauth/authorize`. The first check is about the browser, not the app: does it carry a browser session?

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/authorize.rs handle_authorize_request from="// No browser session, no authorization" through="let Some((browser_session, browser_sid))"}}

**A code is always issued under a browser session (its `sid`).** Without one there is nothing to issue under and nothing to revoke later, so the browser is sent to pair first, with this request's path and query as where to come back to. Nothing is written yet, so the detour spends no SMART `launch` value.

Everything after this point runs in one write scope, in `CodeAuthorizationStarter::start`. Telling the Owner's popup about a new request happens after the scope closes.

### Three questions decide where the browser goes

The starter first validates the request: a signing key to mint with, a client that isn't disabled, PKCE, and the client's registration. A server-defined registration holds the request to its redirects and scopes. Any other client is trusted on first use: whatever steps outside its registration is carried to the Owner as a warning. Then three questions about the request pick the next step:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs AuthorizeNextStep}}

| Question, in the order asked                                     | Domain meaning                                                                                                                                                       | If yes →                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Does this browser's session hold less than the app asks for?** | The laptop was paired with read-only access, but the app wants write. The person at the browser is told before anyone else is bothered.                              | The **limited page** (`ConfirmSessionShortfall`)           |
| **Does a standing grant already cover everything asked for?**    | The Owner said yes to this app at this redirect before and hasn't revoked it, the request matches the app's registration, and the launch admits the grant's patient. | [Issue a code now](#the-fast-path) (`RedirectToClient`)    |
| **Can this browser decide the request itself?**                  | The person at the browser is the Owner, holding enough to approve this request as asked.                                                                             | The **consent card**, in place (`AwaitOwner`, decidable)   |
| _(otherwise)_                                                    | Someone else is using this browser.                                                                                                                                  | The **wait page**, and the Owner's popup shows the request |

The facts behind the three answers are worked out side by side, right before the request is parked:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs CodeAuthorizationStarter::start_in from="let decidable_in_requesting_browser" through="let waits_on_limited_page"}}

The second half of `waits_on_limited_page` means the limited page is shown **once per browser per app**: once this browser has pressed Continue for Strength, its later Strength requests skip the page, whatever the session lacks. Continue, Cancel and the race between them are entity transitions, explained on the request's own page ([`acknowledge_session_shortfall`](<../Domain/Authorization Request Explanation.md#acknowledge_session_shortfall>), [`deny_on_limited_page`](<../Domain/Authorization Request Explanation.md#deny_on_limited_page>), [`RequestPhase`](<../Domain/Authorization Request Explanation.md#requestphase>)).

Every one of these paths, the fast path included, parks an [`AuthorizationRequest`](<../Domain/Authorization Request Explanation.md>) first. From then on the request changes only through its own [transitions](<../Domain/Authorization Request Explanation.md#requesttransition>), each written with the [guarded replace](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>), so the first decision wins.

### The Owner decides

Strength's request is pending. The laptop isn't the Owner, so it went to the wait page, and the host app on the Owner's phone shows the request. The Owner ticks scopes and taps Approve, which arrives at `ConsentDecider::approve_oauth_consent`. Before anything is written, the approval must earn a proof:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/oauth.rs ConsentDecider::approve_oauth_in from="let maybe_delegated_scopes" through="let Some(delegated_scopes)"}}

**You can't give away what you don't hold.** {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}} is the whole rule:

1. The approver must hold the prompt's **approval scopes**: the power to decide a request, to record a grant, to write the registration of a client trusted on first use, and every resource scope (or `wildflower/launch`) the request asks for. Missing any is a `403` that names them, whatever was ticked.
2. The ticks are clamped to what the prompt may grant: each must be covered by a requested scope and by the client's registration, which for a client trusted on first use takes in what it asked for.
3. Every resource scope that survives must be covered by the approver's own grant.

If nothing survives, the request is denied. Before that, a request from an app new to the Owner, or one stepping outside its registration, needs the Owner to acknowledge so (a `409` otherwise). And when the SMART launch pinned a patient, the approval must name that patient ([`admits_patient`](<../Domain/Authorization Request Explanation.md#admits_patient>)).

### Approving and issuing the code

Both paths to a code go through one writer method, `RequestApprover::approve_for_code`: the Owner's approval above, and the [fast path](#the-fast-path) below. It takes a `CodeAuthority`, an enum with exactly two variants. **That enum is the complete answer to "what can cause a code to be issued?"**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code from="let Some(browser_session)" through="self.tx.issue_authorization_code"}}

Three rules, in the order they run:

1. **The requesting browser must still be live.** If the laptop was signed out while the Owner decided, the approval becomes a denial and Strength hears `access_denied`. There's no session left to issue under.
2. **The request records what the authority allowed** (`Approval.granted_scopes`): the Owner's delegated scopes, or the requested scopes the standing grant covered. That's the record of the decision ([`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>)).
3. **The code carries that, intersected with the browser's session** (`session_bounded_scopes`). A browser paired read-only earns its apps read-only access, whoever approved. The code also carries the `sid`, so revoking the laptop later ends everything Strength earned there.

On the Owner's path, the same write scope then records the **grant** for (Strength, its redirect), unioned into any grant already there, and for a client trusted on first use creates or widens its registration ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant}}). The code, the grant and the registration land together or not at all. The grant is what lets the next request's second question answer yes.

### The fast path

The fast path is the one place a code is issued with no person deciding:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/code_authorization_starter.rs decide from="// The fast path:" through="let fast_path_coverage"}}

{{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}} answers `Full` only when the request matches the client's registration exactly (redirect on its allowlist, every scope inside it) **and** the standing grant for that client and redirect covers every requested scope. Coverage is by permission, not spelling: a grant for `patient/Observation.rs` answers a request for `patient/Observation.r`. A request that is new or steps outside the registration never takes the fast path, however well an old grant covers it: the Owner hasn't seen that combination.

### Redemption: the code is spent once

The browser is sent back to Strength's redirect with `?code=…&state=…`. Strength posts the code and its PKCE verifier to `/oauth/token`, which builds the proof `RedeemedAuthorizationCode`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem from="// A concurrent redemption" through="let Some(code)"}}

**A code presented twice means someone else has seen it.** The second presentation fails, and it also expires every refresh family the first redemption started. The attacker gets nothing, and the real app has to ask again.

The code is consumed before its bindings are checked: same client, same redirect, not expired, and the PKCE verifier matching the challenge. A code that fails any of them is spent all the same, and every failure reads `invalid_grant` on the wire. The token then carries the code's scopes, which the session already bounded. Its `scope` claim adds each SMART scope's other spelling, so the FHIR server can read either.

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

## `auth_code_grant_happy_path_end_to_end`

**An app the Owner approves ends up with a signed bearer token for exactly the approved scope.** The browser is parked on the wait page, the Owner approves, the approve response and the wait page's poll hand back the same code (the poll's answer kept out of every cache), and `/oauth/token` redeems it. No `offline_access` was granted, so no refresh token comes back.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_happy_path_end_to_end}}

Relies on [`approve_code`](<../Domain/Authorization Request Explanation.md#approve_code>), [`IssuedAuthorizationCode`](<../Domain/Authorization Code Explanation.md#issuedauthorizationcode>) and [`mint_access_token`](<../Domain/Token Explanation.md#mint_access_token>). The harness is [`spin_up`](<../Integration Tests Explanation.md#spin_up>) and [`seed_client_with_redirect`](<../Integration Tests Explanation.md#seed_client_with_redirect>).

## `oauth_consent_prompt_carries_client_display_name`

**The consent prompt names the app by its registered name, not only its opaque `client_id`.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs oauth_consent_prompt_carries_client_display_name}}

Relies on the request resolved against the client's registration ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/client_registration.rs ResolvedCodeRequest::client_name}}).

## `auth_code_grant_owner_narrows_requested_scope`

**The Owner may approve less than was asked, and the approval stands.** `patient/Observation.s` is inside the requested `patient/Observation.rs`, so the clamp keeps it by coverage, the request is approved rather than denied, and the token carries the narrowed scope.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_owner_narrows_requested_scope}}

Relies on [the clamp](#the-owner-decides). The browser holding the scope is [`paired_browser_session_holding`](<../Integration Tests Explanation.md#paired_browser_session_holding>).

## `an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending`

**An approver who doesn't hold every resource scope the request asks for can't approve it, and the refusal costs the request nothing.** The `403` names the missing scope, the request stays pending with no code, and the Owner, who holds it, can still approve.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending}}

Relies on [the approval scopes](#the-owner-decides) and [`into_pending_code`](<../Domain/Authorization Request Explanation.md#into_pending_code>).

## `consent_approval_persists_grant`

**An approval leaves a standing grant the Owner can see**: for this client and redirect, with the approved scopes and no patient.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_approval_persists_grant}}

Relies on [`AuthorizationCodeGrant`](<../Domain/Grant Explanation.md#authorizationcodegrant>). The flow is driven by [`authorize_and_approve`](<../Integration Tests Explanation.md#authorize_and_approve>).

## `consent_approvals_union_scopes_into_grant`

**A later approval adds to the standing grant; it never takes back what an earlier one gave.** Approving `write` after `read` leaves one grant for the app's redirect, covering both.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_approvals_union_scopes_into_grant}}

Relies on [`absorb_reapproval`](<../Domain/Grant Explanation.md#absorb_reapproval>).

## `pre_approved_scopes_skip_consent_on_reauthorize`

**Once the Owner has said yes, the same request again goes straight back to the app with a fresh code and its own `state`**, with no page and no prompt.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs pre_approved_scopes_skip_consent_on_reauthorize}}

Relies on [the fast path](#the-fast-path) and [`CodeAuthority`](#approving-and-issuing-the-code).

## `a_narrower_request_is_pre_approved_by_a_broader_standing_grant`

**A standing grant answers for any request inside it, not only for the same spelling.** A grant for `patient/Observation.rs` pre-approves a later request for `patient/Observation.r`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs a_narrower_request_is_pre_approved_by_a_broader_standing_grant}}

Relies on [the fast path](#the-fast-path)'s coverage.

## `minted_jwt_scope_claim_carries_alternate_canonical_forms`

**The FHIR server can read a token whichever SMART spelling the app asked in.** The app is told the scope it was granted (`patient/Observation.read`), and the signed token's `scope` claim carries both that and its letter-form twin `patient/Observation.rs`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs minted_jwt_scope_claim_carries_alternate_canonical_forms}}

Relies on [redemption](#redemption-the-code-is-spent-once) and [`mint_access_token`](<../Domain/Token Explanation.md#mint_access_token>).

## `auth_code_grant_wrong_verifier_rejected`

**A code is worthless without the PKCE verifier it was issued for.** A well-formed but wrong verifier gets `invalid_grant`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_wrong_verifier_rejected}}

Relies on [redemption](#redemption-the-code-is-spent-once). The code is planted with [`plant_authorization_code`](<../Integration Tests Explanation.md#plant_authorization_code>).

## `auth_code_grant_expired_code_rejected`

**A code past its expiry is refused, even with the right verifier.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_expired_code_rejected}}

Relies on [`IssuedAuthorizationCode`](<../Domain/Authorization Code Explanation.md#issuedauthorizationcode>)'s `expires_at` and [redemption](#redemption-the-code-is-spent-once).

## `auth_code_grant_replay_rejected`

**A code redeems once.** The second presentation of the same code gets `invalid_grant`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_grant_replay_rejected}}

Relies on [redemption](#redemption-the-code-is-spent-once).

## `auth_code_replay_revokes_issued_refresh_family`

**Replaying a code ends what its first redemption earned.** The first redemption returns a refresh token; after the replay, rotating that refresh token fails with `invalid_grant`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs auth_code_replay_revokes_issued_refresh_family}}

Relies on [redemption](#redemption-the-code-is-spent-once) and the [refresh token](<../Domain/Refresh Token Explanation.md>) family.

## `consent_prompt_reports_the_registration_verdict`

**The Owner is told whether the app is one they know.** This and the tests after it are about clients trusted on first use. A request that matches the registration reads `registered`; one from a `client_id` with no registration reads `new`, and the prompt names the app by that id.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs consent_prompt_reports_the_registration_verdict}}

Relies on [`ClientRegistrationVerdict`](<../Domain/Client Explanation.md#clientregistrationverdict>).

## `approving_a_new_app_without_acknowledgement_is_rejected`

**The Owner can't approve an app new to them without acknowledging the warning.** The `409` writes nothing (no client, no grant, no code), and the request is still there to decide again.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_new_app_without_acknowledgement_is_rejected}}

Relies on [`needs_acknowledgement`](<../Domain/Client Explanation.md#needs_acknowledgement>).

## `denying_a_new_app_registers_nothing`

**Denying an app new to the Owner leaves no registration behind.** The client's row is written only on approval.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs denying_a_new_app_registers_nothing}}

Relies on [`deny`](<../Domain/Authorization Request Explanation.md#deny>).

## `approving_a_new_app_registers_it_and_the_next_request_fast_paths`

**Trust on first use is one approval long.** The acknowledged approval issues the code, registers the app (public, named by its id, the one redirect it used, the approved scopes, no secret) and leaves a grant, so the same request a moment later is `registered` and goes straight back to the app.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_new_app_registers_it_and_the_next_request_fast_paths}}

Relies on [`Client`](<../Domain/Client Explanation.md#client>), [the grant and registration writes](#approving-and-issuing-the-code) and [the fast path](#the-fast-path).

## `approving_a_changed_app_widens_its_registration`

**Approving a known app's new redirect or scopes widens its registration in place, by exactly what was approved.** The prompt reports `changed` with what's new. Afterwards the new redirect is appended, the approved scopes are added, a scope requested but not approved is not, and the app's name and registration time are kept.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs approving_a_changed_app_widens_its_registration}}

Relies on [`ClientRegistrationVerdict`](<../Domain/Client Explanation.md#clientregistrationverdict>) and [the registration write](#approving-and-issuing-the-code).

## `a_changed_request_never_takes_the_fast_path`

**A standing grant doesn't skip the Owner for a request outside the app's registration**, even when it covers every requested scope. With the registration narrowed under the grant, the request reads `changed` and comes to the Owner with nothing pre-ticked.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/grant_flows.rs a_changed_request_never_takes_the_fast_path}}

Relies on [the fast path](#the-fast-path)'s registration gate and [`is_registered`](<../Domain/Client Explanation.md#is_registered>).
