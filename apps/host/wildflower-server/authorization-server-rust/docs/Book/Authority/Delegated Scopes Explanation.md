# Delegated Scopes

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs}}

When a request is approved, someone is handing on access: the Owner, or a browser the Owner paired. **No one can delegate more than they hold.** This page holds the scope rules the whole server leans on for that, in three parts.

- **What a prompt may grant at most.** Each consent prompt has a ceiling, set by its flow and the app's [registration](<../Domain/Client Explanation.md>). Whatever the approver ticks is clamped to it.
- **What the approver must hold.** To approve a prompt at all, the approver holds its **approval scopes**: the power to decide the request and to create what approving it creates. And every piece of access it passes on, it must hold itself.
- **What the browser holds.** A code issued for an app carries only what the [browser session](<../Domain/Browser Session Explanation.md>) the request was made in also holds, and the browser is told beforehand what it lacks, on the [limited page](<../Domain/Authorization Request/Code Request Explanation.md#the-limited-page>).

**Delegated scopes** are the proof of the first two: a scope set the approver has approved **and** is entitled to delegate. The writers that record grants, write registrations and issue codes on an approval accept nothing else. The third part is two free functions, applied when a code is issued and when `/oauth/authorize` decides where to send the browser.

Every "covers" on this page is the [scope coverage](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>) the Scopes page explains: by permission, not by spelling.

## `domain::authority::delegated_scopes`

The tests build prompts and approvers with the [delegated-scopes fixtures](<Test Fixtures Explanation.md#delegated-scopes>).

### `ApprovalFlow`

A prompt belongs to one of four flows, and the flow decides both its ceiling and its approval scopes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow}}

#### What approving does

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::would_record_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::would_write_registration}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovalFlow::would_approve_as_asked}}

### `is_held_access`

Not every scope is access. A resource scope (`patient/Observation.rs`, `system/*.cruds`, `wildflower/Grant.c`) and `wildflower/launch` are **held access**: what its holder must itself hold to pass on.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs is_held_access}}

### `coverage_in_either_spelling`

**Holding is judged by coverage, in either SMART spelling.** SMART writes a permission two ways, the v1 words (`.read`) and the v2 letters (`.rs`). A token redeemed at `/oauth/token` carries [both](<../Domain/Scopes Explanation.md#item-with_alternate_canonical_forms>) in its `scope` claim, so a holder of one counts as holding the other.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs coverage_in_either_spelling}}

### `may_pass_on`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs may_pass_on}}

### `uncovered_held_access`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs uncovered_held_access}}

### `ApprovableScopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes}}

#### `for_code`

**Who defines the registration decides the ceiling** ([`is_registration_fixed`](<../Domain/Client Explanation.md#item-Client--is_registration_fixed>)). Either way the request is the other half, so **a code prompt never grants past what the app asked for.** A [resolved code request](<../Domain/Authorization Request/Code Request Explanation.md#item-ResolvedCodeRequest--approvable_scopes>) builds its prompt here.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_code tests="tests::a_code_prompt_widens_the_allowance_only_for_a_registration_trusted_on_first_use tests::a_code_prompt_never_grants_beyond_the_request"}}

#### `for_device`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_device tests="tests::a_device_prompt_grants_within_the_client_allowance"}}

End to end, the [Device Code](<../Integration Tests/Device Code Explanation.md>) tests hold the same rule at the consent route: `device_consent_allows_expansion_beyond_requested` and `device_consent_clamps_granted_scopes_to_client_allowed`.

#### `for_session_widening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_session_widening tests="tests::a_widening_prompt_grants_only_what_was_asked"}}

#### `for_browser_pairing`

**No paired browser session can hold more than a same-device one**, since both are capped by the Owner's scopes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_browser_pairing tests="tests::a_pairing_prompt_grants_up_to_the_owner_s_scopes"}}

#### `grantable_subset`

The tests under each constructor above show it per flow. It is the prompt's half of [`grantable_scopes`](<../Domain/Scopes Explanation.md#item-grantable_scopes>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::grantable_subset}}

#### `missing_approval_scopes`

**One function answers "may this approver approve?" for every place that asks**, so the consent card, the approve route and `/oauth/authorize` never disagree.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::missing_approval_scopes tests="tests::the_approval_scopes_follow_the_flow tests::a_code_approval_takes_the_requested_resource_scopes tests::the_owner_s_scopes_cover_every_approval_scope"}}

End to end, the [Approval Scopes](<../Integration Tests/Approval Scopes Explanation.md>) page holds it at the routes: a browser session without `wildflower/Grant.c` goes to the wait page, and an Owner session lacks no approval scope.

#### `delegable_scopes`

Where a pairing card's ticks start. Its promise is that the card, approved untouched, passes [`clamp`](#item-DelegatedScopes--clamp) below.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::delegable_scopes tests="tests::a_pairing_prompt_s_delegable_scopes_are_what_the_approver_holds tests::an_approver_without_launch_may_not_delegate_it"}}

### `DelegatedScopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes}}

#### `clamp`

The one constructor. It runs [`missing_approval_scopes`](#item-ApprovableScopes--missing_approval_scopes) first, then [`grantable_subset`](#item-ApprovableScopes--grantable_subset), then [`uncovered_held_access`](#item-uncovered_held_access) against the approver's grant. **A held access the approver lacks fails the whole approval**, rather than being dropped in silence, so the Owner sees the refusal instead of a narrower grant than they ticked.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp tests="tests::clamp_admits_covered_approvable_scopes tests::clamp_drops_ticks_outside_the_approvable_scopes tests::clamp_yields_none_when_nothing_survives tests::clamp_rejects_a_resource_scope_the_approver_does_not_hold tests::clamp_rejects_every_resource_scope_for_an_empty_approver tests::clamp_passes_identity_markers_through_the_approver_check tests::clamp_covers_across_the_two_smart_spellings tests::clamp_refuses_an_approver_lacking_an_approval_scope_before_anything_else"}}

End to end, the [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>), [Approval Scopes](<../Integration Tests/Approval Scopes Explanation.md>) and [Browser Pairing](<../Integration Tests/Browser Pairing Explanation.md>) tests hold the clamp at the routes: an Owner narrowing a request, an approver lacking a requested scope leaving it pending, and a pairing granting nothing past the Owner's scopes or the approver's.

#### `scopes`

The `clamp` tests read it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::scopes}}

#### `would_write_registration`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::would_write_registration tests="tests::only_a_trusted_on_first_use_code_approval_writes_the_registration"}}

### `session_bounded_scopes`

**A code carries only what both the app's authority and the browser the request was made in allow.** The request's approval and the standing grant keep the authorized scopes; only the code is narrowed. So a browser paired read-only earns no app write access, whoever approved the request.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_bounded_scopes tests="tests::a_session_bounds_resource_scopes_by_coverage_in_either_spelling tests::a_session_narrows_a_scope_it_holds_only_part_of tests::a_session_s_parts_are_deduplicated tests::a_session_passes_markers_through_and_bounds_launch tests::the_owner_s_session_bounds_nothing"}}

### `intersection_in_either_spelling`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs intersection_in_either_spelling}}

### `session_shortfall`

**The browser is told what it lacks before a narrowed code is issued.** The shortfall and the bound are two views of one rule: the shortfall names, as requested, each scope the bound would drop or narrow.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs session_shortfall tests="tests::the_session_shortfall_is_what_the_session_bound_drops_or_narrows"}}

End to end, the [Session Shortfall](<../Integration Tests/Session Shortfall Explanation.md>) tests hold the limited page to it: the fast path stops there and then issues the narrowed code, and an Owner session never sees it.
