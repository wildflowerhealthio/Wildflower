# Grant Recorder

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs}}

When the Owner approves an app, the approval leaves a [standing grant](<../Domain/Grant Explanation.md>) behind, so the app's next request for the same access goes through without asking. The grant recorder writes it: it creates the grant, or widens the one already standing. For an app [trusted on first use](<../Domain/Client Explanation.md>) it also writes the app's registration, which the approval is what justifies.

**Both writes take [delegated scopes](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes>).** A grant row and a widened registration only ever carry scopes an approver was entitled to delegate, and a scope the Owner unticked is added to neither. The proof also says whether to write the registration at all ([`would_write_registration`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--would_write_registration>)).

## `domain::capabilities::writers::grant_recorder`

The tests record grants at one redirect and widen a fixture client with the [grant-recorder fixtures](<Test Fixtures Explanation.md#grant-recorder>).

### `GrantRecorder`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder}}

#### `within`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::within}}

#### `record_code_grant`

**One grant per app and redirect: a re-approval widens the grant that stands, never adds a second.** The widening is the grant's own [`absorb_reapproval`](<../Domain/Grant Explanation.md#item-AuthorizationCodeGrant--absorb_reapproval>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant tests="tests::record_code_grant_inserts_then_unions_scopes tests::record_code_grant_without_widening_never_creates_a_client tests::record_code_grant_widen_registers_a_new_client_with_the_delegated_scopes tests::record_code_grant_widening_appends_only_a_new_redirect"}}

End to end, the [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) tests hold the grant and the registration at the consent route: an approval persists a grant, approvals union into it, approving a new app registers it so its next request takes the fast path, and approving a changed app widens its registration.

#### `record_device_grant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_device_grant tests="tests::record_device_grant_inserts_then_unions_scopes tests::a_new_grant_starts_unused_and_a_reapproval_keeps_its_last_use"}}

### `write_registration`

The store's upsert updates the row in place, keeping its registration time and any `disabled_at`, so **a widening never brings a disabled app back**.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs write_registration}}

### `new_registration`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs new_registration tests="tests::a_new_registration_matches_a_row_widened_into_the_same_state"}}

### `widen_registration`

The scopes widen by meaning, through [`widened_scopes`](<../Domain/Scopes Explanation.md#item-widened_scopes>), and the row is only ever read by coverage, as in [`PresentedClientChange`](<../Domain/Client Explanation.md#item-PresentedClientChange>), so a collapsed row admits exactly what the uncollapsed one would.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs widen_registration tests="tests::a_broader_grant_replaces_the_narrower_registered_scope tests::disjoint_interactions_on_one_resource_become_one_scope tests::re_granting_a_covered_scope_leaves_the_row_untouched tests::a_v1_word_registration_is_not_merged_into_letter_access tests::everything_granted_is_covered_by_the_widened_row tests::the_redirect_allowlist_moves_only_when_the_redirect_is_new"}}
