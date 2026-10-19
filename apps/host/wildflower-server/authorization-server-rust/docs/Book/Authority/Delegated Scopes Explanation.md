# Delegated Scopes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs}}

When a request is approved, someone is handing on access: the Owner, or a browser the Owner paired. **No one can delegate more than they hold.** This page holds the scope rules the whole server leans on for that, in three parts.

- **What a prompt may grant at most.** Each consent prompt has a ceiling, set by its flow and the app's registration. Whatever the approver ticks is clamped to it.
- **What the approver must hold.** To approve a prompt at all, the approver holds its **approval scopes**: the power to decide the request and to create what approving it creates. And every piece of access it passes on, it must hold itself.
- **What the browser holds.** A code issued for an app carries only what the browser session the request was made in also holds, and the browser is told beforehand what it lacks.

**Delegated scopes** are the proof of the first two: a scope set the approver has approved **and** is entitled to delegate. The writers that record grants, write registrations and issue codes on an approval accept nothing else. The third part is two functions, applied when a code is issued and when `/oauth/authorize` decides where to send the browser.

## The three flows

A prompt belongs to one of three flows, and the flow decides both its ceiling and its approval scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow keep-docs}}

| Flow                             | Approving records a grant | Approving writes the registration | The approver must hold what is asked |
| -------------------------------- | ------------------------- | --------------------------------- | ------------------------------------ |
| Code, app trusted on first use   | yes                       | yes                               | yes                                  |
| Code, server-defined (fixed) app | yes                       | no                                | yes                                  |
| Device                           | yes                       | no                                | no: device consent is expandable     |
| Browser pairing                  | no                        | no                                | no: pairing consent is expandable    |

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::records_grant}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::writes_registration}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::approves_as_asked}}

## Held access

Not every scope is access. A resource scope (`patient/Observation.rs`, `system/*.cruds`, `wildflower/Grant.c`) and `wildflower/launch` are **held access**: what its holder must itself hold to pass on. Identity and session markers (`openid`, `fhirUser`, `launch`, `launch/patient`, `offline_access`) are no access anyone holds, so anyone may pass them on.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs is_held_access}}

**Holding is judged by coverage, in either SMART spelling.** SMART has two ways to write a permission, the v1 words (`.read`) and the v2 letters (`.rs`). A token redeemed at `/oauth/token` carries both in its `scope` claim, so a holder of one counts as holding the other: each held scope and each scope asked about also counts in its alternate form.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs coverage_in_either_spelling}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs may_pass_on}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs uncovered_held_access}}

## Test fixtures

`approvable` is a code prompt for a fixed registration: the request asks `requested`, the app is registered for `allowed`, through the shared [`client`](<../Grant Store/Test Fake Explanation.md#client>) fixture.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::approvable}}

`grant` is an approver holding the approval scopes of a prompt that writes no registration (deciding requests, creating grants), plus `scopes`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::grant}}

`device_prompt` is a device prompt for an app registered for `allowed`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::device_prompt}}

## `ApprovableScopes`

The scopes one consent prompt may grant at most. **An approved scope must be covered by a scope of the request and by a scope of the registration ceiling**, the most the app's registration permits for this approval. The prompt also carries its flow, which sets its approval scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes}}

There is one constructor per flow; each names the policy that fills the two halves.

## `grantable_subset`

The ticks that survive the prompt's ceiling: each one covered by a requested scope and by a ceiling scope, by permission and not spelling. They come back in canonical form, without duplicates, in the order the approver gave them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::grantable_subset}}

No unit test of its own; the tests under each constructor below show it per flow.

## `for_code`

An authorization-code prompt. **Who defines the registration decides the ceiling.** A server-defined registration is fixed, so its registered scopes are the ceiling. Any other app is trusted on first use, so the ceiling also takes in what this request asks for: approving it widens the registration with the grant. Either way the request is the other half, so **a code prompt never grants past what the app asked for.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_code}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_code_prompt_widens_the_allowance_only_for_a_registration_trusted_on_first_use}}

An app registered for `openid` alone, asking also for `patient/Patient.r`, may be granted both when it is trusted on first use, and so may an app with no registration yet; a fixed registration may be granted `openid` alone.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_code_prompt_never_grants_beyond_the_request}}

A registration listing `patient/Patient.r` doesn't let the approver add it to a request for `openid`.

## `for_device`

A device-code prompt. **Device consent is expandable**: the Owner may grant anything the app's registration allows, whatever the device asked for. So the registered scopes fill both halves.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_device}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_device_prompt_grants_within_the_client_allowance}}

Under a registration of `patient/*.rs` and `offline_access`, a narrower `patient/Observation.r` is grantable and `system/*.r` is dropped.

Exercised end to end by [`device_consent_allows_expansion_beyond_requested`](<../Integration Tests/Device Code Explanation.md#device_consent_allows_expansion_beyond_requested>) and [`device_consent_clamps_granted_scopes_to_client_allowed`](<../Integration Tests/Device Code Explanation.md#device_consent_clamps_granted_scopes_to_client_allowed>).

## `for_browser_pairing`

A browser pairing prompt. It asks for the Owner's scopes, and like device consent it is expandable: the Owner's scopes fill both halves. **No approved browser session can hold more than an Owner session.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_browser_pairing}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_pairing_prompt_grants_up_to_the_owner_s_scopes}}

`wildflower/launch` and `system/Patient.rs` fall under the Owner's scopes and survive; `openid` and `offline_access` don't, and are dropped.

## `missing_approval_scopes`

The prompt's **approval scopes** the approver doesn't hold; empty when it may approve. **One function answers this for every place that asks**, so they never disagree: the approve paths (through [`clamp`](#clamp)), the consent read (its `missingApprovalScopes`), and `/oauth/authorize`'s choice between the consent card and the wait page.

| Approval scope                      | Taken by                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `wildflower/AuthorizationRequest.u` | Every approval: it decides the request.                                                                                                  |
| `wildflower/Grant.c`                | A code or device approval: it records a standing grant.                                                                                  |
| `wildflower/Client.c`, `Client.u`   | A code approval for an app trusted on first use: it creates or widens the registration, whichever the row needs when the approval lands. |
| each requested held access          | A code approval: it approves the request as asked, so the approver must hold each held access the prompt may grant.                      |

A device or pairing prompt is expandable, so its approver may grant whatever it holds, and [`clamp`](#clamp) bounds that scope by scope instead.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::missing_approval_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::the_approval_scopes_follow_the_flow}}

An approver holding nothing lacks deciding for a pairing; deciding and grant creation for a device or fixed code prompt; and both client scopes besides for a code prompt trusted on first use, whether the app has a row yet or not.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_code_approval_takes_the_requested_resource_scopes}}

A fixed registration's ceiling drops `system/Patient.r` before the check, so its approver lacks only `patient/Observation.read`, and holding `patient/Observation.rs` covers it in the other spelling. With no fixed ceiling, `system/Patient.r` is required too.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::the_owner_s_scopes_cover_every_approval_scope}}

The Owner lacks no approval scope on any prompt.

Exercised end to end by the [Approval Scopes](<../Integration Tests/Approval Scopes Explanation.md>) page, among them [`a_browser_session_without_grant_create_goes_to_the_wait_page`](<../Integration Tests/Approval Scopes Explanation.md#a_browser_session_without_grant_create_goes_to_the_wait_page>) and [`an_owner_session_lacks_no_approval_scope`](<../Integration Tests/Approval Scopes Explanation.md#an_owner_session_lacks_no_approval_scope>).

## `DelegatedScopes`

The proof: a scope set whose approver held the prompt's approval scopes, clamped to what the prompt may grant, with every held access in it covered by the approver's own grant. It also records whether the approval behind it writes the app's registration.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes}}

## `clamp`

The one constructor, and the rule in three steps.

1. **The approver must hold the prompt's approval scopes**, whatever it ticked, even nothing. Otherwise the approval is refused with `InsufficientScope`, naming them.
2. The ticks are clamped to the prompt's [grantable subset](#grantable_subset). If nothing survives, there is no proof, and the caller denies the request rather than recording an empty grant.
3. **Every held access that survives must be covered by the approver's grant**, in either spelling. One that isn't fails the whole approval with `InsufficientApproverScope`, naming it, rather than being dropped in silence.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_admits_covered_approvable_scopes}}

Ticks inside the prompt and inside the approver's authority come back as the delegated set, as ticked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_drops_ticks_outside_the_approvable_scopes}}

A tick the request didn't ask for is dropped.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_yields_none_when_nothing_survives}}

When no tick survives, the answer is no proof at all.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_rejects_a_resource_scope_the_approver_does_not_hold}}

On a device prompt, an approver holding `patient/Patient.r` who ticks `patient/Observation.r` too is refused, and the refusal names `patient/Observation.r`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_rejects_every_resource_scope_for_an_empty_approver}}

An approver holding no resource access can delegate none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_passes_identity_markers_through_the_approver_check}}

`openid` and `offline_access` need no authority to pass on.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_covers_across_the_two_smart_spellings}}

An approver holding the letter form `patient/Patient.rs` may delegate the word form `patient/Patient.read`, which is recorded as ticked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::clamp_refuses_an_approver_lacking_an_approval_scope_before_anything_else}}

An approver without `wildflower/Grant.c` is refused on a device prompt even with nothing ticked, so the approval isn't quietly turned into a deny.

Exercised end to end by [`auth_code_grant_owner_narrows_requested_scope`](<../Integration Tests/Grant Flows Explanation.md#auth_code_grant_owner_narrows_requested_scope>), [`an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending`](<../Integration Tests/Grant Flows Explanation.md#an_approver_lacking_a_requested_resource_scope_is_refused_and_the_request_stays_pending>), [`an_approved_browser_without_grant_create_cannot_approve_a_device_request`](<../Integration Tests/Approval Scopes Explanation.md#an_approved_browser_without_grant_create_cannot_approve_a_device_request>) and [`an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s`](<../Integration Tests/Browser Pairing Explanation.md#an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s>).

## `scopes`

The delegated scopes, which every write under the proof records as they are: the request's approval, the standing grant, a widened registration. A code issued under them is further bounded by the browser session, in [`session_bounded_scopes`](#session_bounded_scopes).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::scopes}}

No unit test of its own; the `clamp` tests above read it.

## `writes_registration`

**Only a code approval for an app trusted on first use writes the registration**, and its approver held both `wildflower/Client.c` and `wildflower/Client.u`. The grant recorder asks the proof, in [`record_code_grant`](<../Writers/Grant Recorder Explanation.md#record_code_grant>), whether to create or widen the `clients` row.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::writes_registration}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::only_a_trusted_on_first_use_code_approval_writes_the_registration}}

Approved by the Owner, a code prompt trusted on first use writes the registration; a fixed one and a device prompt don't.

Exercised end to end by [`approving_a_new_app_registers_it_and_the_next_request_fast_paths`](<../Integration Tests/Grant Flows Explanation.md#approving_a_new_app_registers_it_and_the_next_request_fast_paths>) and [`approving_a_changed_app_widens_its_registration`](<../Integration Tests/Grant Flows Explanation.md#approving_a_changed_app_widens_its_registration>).

## `delegable_scopes`

Where a pairing card's ticks start (the device page asks it for a browser pairing alone): everything this approver may delegate on this prompt. The candidates are the requested scopes and the approver's own; the prompt's ceiling filters them, then any held access the approver doesn't cover is left out. **Approving the card untouched always passes [`clamp`](#clamp)'s approver check.** A pairing card shown to the Owner starts from the Owner's scopes; shown to a narrower approver, it starts from all that approver holds instead.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::delegable_scopes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_pairing_prompt_s_delegable_scopes_are_what_the_approver_holds}}

For the Owner, a pairing card starts from the Owner's scopes. For a narrower approver it starts from what that approver holds and an Owner could grant: its approval scopes, `system/Patient.rs` and `wildflower/launch`, but not its `openid`, which is no Owner scope. Approving exactly that passes the clamp.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::an_approver_without_launch_may_not_delegate_it}}

`wildflower/launch` is held access: an approver without it gets a card without it ticked, and ticking it anyway is refused, naming it.

Exercised end to end by [`a_narrower_approver_s_card_opens_with_what_it_may_delegate`](<../Integration Tests/Browser Pairing Explanation.md#a_narrower_approver_s_card_opens_with_what_it_may_delegate>).

## `session_bounded_scopes`

**A code carries only what both the app's authority and the browser the request was made in allow.** When a code is issued, by an approval or a standing grant, the request approver's [`approve_for_code`](<../Writers/Request Approver Explanation.md#approve_for_code>) narrows the authorized scopes to the [browser session](<../Domain/Browser Session Explanation.md>)'s grant. The request's approval and the standing grant keep the authorized scopes; only the code is narrowed.

Scope by scope:

- A marker passes through, whatever the session holds.
- Held access the session covers (either spelling, `system/*` covering `patient/*` and `user/*`) stays as authorized.
- Held access the session covers only in part narrows to the parts it holds: its intersection with each session scope. `system/*.cruds` against a session holding `system/Patient.cruds` is `system/Patient.cruds`. One scope's parts are collapsed, so overlapping session scopes yield the broadest part once.
- `wildflower/launch` has no parts: it stays only if the session holds it.

The result keeps each scope's first occurrence, in order, so a session that covers everything changes nothing but exact duplicates.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_bounded_scopes}}

A part is spelled in the authorized scope's grammar where one spells it: `patient/*.read` against `patient/Patient.rs` is `patient/Patient.read`. Where no word spells the part, it is letters.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs intersection_in_either_spelling}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_session_bounds_resource_scopes_by_coverage_in_either_spelling}}

A session's letters cover the word form and back, so those scopes stay as authorized; `patient/Condition.rs` and `wildflower/Grant.c`, which it holds none of, are dropped. A `system/*.cruds` session keeps `patient/` and `user/` scopes whole.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_session_narrows_a_scope_it_holds_only_part_of}}

Wildcards narrow to the session's named types, contexts to the session's, and interactions to the ones it holds; a word scope narrows in words where a word exists, and a letter scope stays letters.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_session_s_parts_are_deduplicated}}

`system/*.cruds` against overlapping session scopes comes out as the broadest part once, and a part two authorized scopes share, or a repeated marker, appears once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::a_session_passes_markers_through_and_bounds_launch}}

Every marker passes a session holding none of them; `wildflower/launch` stays only for the session that holds it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::the_owner_s_session_bounds_nothing}}

The Owner's session leaves every scope an approval can grant as it is.

Exercised end to end by [`the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code`](<../Integration Tests/Session Shortfall Explanation.md#the_fast_path_stops_at_the_limited_page_then_issues_the_narrowed_code>).

## `session_shortfall`

**The browser is told what it lacks before a narrowed code is issued.** The shortfall is each requested held access the session doesn't cover: every scope [`session_bounded_scopes`](#session_bounded_scopes) would drop or narrow, spelled as the request spells it, in order. `/oauth/authorize` sends the browser to the limited page when it isn't empty (and the session hasn't already gone on for this app), and the limited page lists it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs tests::the_session_shortfall_is_what_the_session_bound_drops_or_narrows}}

Against a session holding `patient/Patient.rs` and `patient/Observation.r`, the shortfall names the four scopes the bound narrows or drops, as requested; the bound itself narrows `patient/Observation.rs` and `system/*.cruds` and drops the other two. The Owner's session has no shortfall.

Exercised end to end by the [Session Shortfall](<../Integration Tests/Session Shortfall Explanation.md>) page, among them [`an_owner_session_never_sees_the_limited_page`](<../Integration Tests/Session Shortfall Explanation.md#an_owner_session_never_sees_the_limited_page>).
