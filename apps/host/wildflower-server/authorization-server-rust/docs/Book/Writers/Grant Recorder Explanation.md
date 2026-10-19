# Grant Recorder

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs}}

When the Owner approves an app, the approval leaves a [standing grant](<../Domain/Grant Explanation.md>) behind, so the app's next request for the same access goes through without asking. The grant recorder writes it: it creates the grant, or widens the one already standing. For an app trusted on first use it also writes the app's registration, which the approval is what justifies.

**Both writes take a [`DelegatedScopes`](<../Authority/Delegated Scopes Explanation.md#delegatedscopes>).** A grant row and a widened registration only ever carry scopes an approver was entitled to delegate, and a scope the Owner unticked is added to neither.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::within}}

`within` builds the recorder over the caller's open write scope.

## Test fixtures

`redirect` is the redirect every grant in these tests is recorded for:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::redirect}}

`widened` widens the test fake's [`client`](<../Grant Store/Test Fake Explanation.md#client>) fixture, registered with `registered`, by `granted`, leaving its redirects alone, and answers the scopes the row ends up with:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::widened}}

## `record_code_grant`

The standing grant for an app and redirect, written in the approval's scope. **One grant per app and redirect: a re-approval widens the grant that stands, never adds a second.** If one is found, the re-approval is folded in by [`absorb_reapproval`](<../Domain/Grant Explanation.md#absorb_reapproval>) and written back; if not, a fresh grant holds exactly the delegated scopes. The write scope holds the database's write lock from before the read, so two approvals at once take turns at the read, and neither loses the other's scopes.

When the proof [writes the registration](<../Authority/Delegated Scopes Explanation.md#writes_registration>), the app's `clients` row is written first, in the same scope, so the registration lands with the grant it justifies or not at all. Only a code approval for an app trusted on first use writes it, and such a proof exists only when its approver held both `wildflower/Client.c` and `wildflower/Client.u`, so whether the row is created or widened, the approver could do it. An app with a fixed registration gets no `clients` row from an approval, whether it has one or not.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::record_code_grant_inserts_then_unions_scopes}}

The first approval creates the grant. The second, for the same app and redirect, updates the same row: the scopes are the union and the patient is the latest.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::record_code_grant_without_widening_never_creates_a_client}}

A proof that writes no registration leaves no `clients` row, even for an app with none.

Exercised end to end by [`consent_approval_persists_grant`](<../Integration Tests/Grant Flows Explanation.md#consent_approval_persists_grant>) and [`consent_approvals_union_scopes_into_grant`](<../Integration Tests/Grant Flows Explanation.md#consent_approvals_union_scopes_into_grant>).

## Writing the registration

The row is read inside the scope, under the write lock, and the write follows the row as it stands. An app with no row is registered; an app with one is widened. The redirect joins the allowlist only when the row doesn't already allow it. The store's upsert updates the row in place, keeping its registration time and any `disabled_at`, so **a widening never brings a disabled app back**.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs write_registration}}

A first approval registers a public client named after its own `client_id`, since no one supplied a display name. It holds only the redirect it just used and the scopes the Owner granted, and may use every grant type. The scopes go in through the same collapse as a widening, against an empty registration, so a row created by one approval and a row widened into the same state are identical.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs new_registration}}

A widening touches only the redirects and the scopes; the name, kind, secret and registration time stay as they were. The scopes are widened by meaning, not by string union: a grant of `patient/Patient.cruds` replaces a registered `patient/Patient.r` rather than sitting beside it, and granting again what the row already covers leaves it as it was. The row is only ever read by coverage ([`uncovered_scopes`](<../Domain/Client Explanation.md#uncovered_scopes>), [`classify_registration`](<../Domain/Client Explanation.md#classify_registration>)), so a collapsed row admits exactly what the uncollapsed one would.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs widen_registration}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::record_code_grant_widen_registers_a_new_client_with_the_delegated_scopes}}

A registering approval for an unknown app creates a public client holding exactly the delegated scopes and the approved redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::record_code_grant_widening_appends_only_a_new_redirect}}

A known app approved for a redirect it already has keeps one redirect; approved for a new one, it gains it. Either way its scopes widen by the approval.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::the_redirect_allowlist_moves_only_when_the_redirect_is_new}}

The allowlist is unchanged unless the redirect is new, and a new one is appended after the registered ones.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::a_broader_grant_replaces_the_narrower_registered_scope}}

`patient/Patient.cruds` replaces `patient/Patient.r`; `openid` stays.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::disjoint_interactions_on_one_resource_become_one_scope}}

Read and search on one resource become the one scope `patient/Patient.rs`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::re_granting_a_covered_scope_leaves_the_row_untouched}}

An app approved before, asking again for what its row covers, keeps the row as it was.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::a_v1_word_registration_is_not_merged_into_letter_access}}

A v1 `read` registration is never folded into a letter scope, which would grant access it was never registered for. Beside `patient/Patient.c` it stays; `patient/Patient.cruds`, which covers it, replaces it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::everything_granted_is_covered_by_the_widened_row}}

The property the trust-on-first-use path rests on: after widening, everything just granted is covered by the row, an unknown scope included, and so is what the row held before.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::a_new_registration_matches_a_row_widened_into_the_same_state}}

A new registration and an empty one widened by the same scopes hold the same collapsed `patient/Patient.rs openid`.

Exercised end to end by [`approving_a_new_app_registers_it_and_the_next_request_fast_paths`](<../Integration Tests/Grant Flows Explanation.md#approving_a_new_app_registers_it_and_the_next_request_fast_paths>) and [`approving_a_changed_app_widens_its_registration`](<../Integration Tests/Grant Flows Explanation.md#approving_a_changed_app_widens_its_registration>).

## `record_device_grant`

The standing grant for a device: the same read, fold in, write back, keyed on the app and the device's name instead of a redirect. **Device consent never writes the registration.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_device_grant}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs tests::record_device_grant_inserts_then_unions_scopes}}

Two approvals for the same app and device name leave one grant holding both scopes.

Exercised end to end by [`device_approval_mints_durable_grant_and_links_refresh_family`](<../Integration Tests/Device Code Explanation.md#device_approval_mints_durable_grant_and_links_refresh_family>).
