# Writers

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs}}

Some writes hand out authority: approving a request, issuing an authorization code, recording or widening a standing grant, widening an app's registration, reading a private key to sign a token with, issuing a refresh token, starting a browser session. **Every one of them happens in a writer, and every writer method takes an [authority proof](<Authority Explanation.md>) as the price of admission.** A proof can only be had from its one constructor, which runs the check it stands for, so a write that holds the proof is a write whose check ran.

A writer is not a gate of its own. It is built over the caller's open scope (`within(tx)`), so what it writes lands with the rest of the operation or not at all, and the gate is the proof each method demands. The capabilities in the next part decide what is being done and obtain the proof; the [Grant Store](<Grant Store Explanation.md>) holds the rows. The writers sit between them: the only code that may make the privileged store calls.

- [Request Approver](<Writers/Request Approver Explanation.md>): approves a pending request of any flow, on [delegated scopes](<Authority/Delegated Scopes Explanation.md>), and for the code flow issues its code, on delegated scopes or a [standing grant](<Authority/Standing Grant Explanation.md>), bounded by the requesting browser's session.
- [Grant Recorder](<Writers/Grant Recorder Explanation.md>): records the standing grant an approval leaves behind, and registers or widens an app trusted on first use, on delegated scopes.
- [Refresh Family Writer](<Writers/Refresh Family Writer Explanation.md>): starts a refresh-token family for a [redemption](<Authority/Redemption Explanation.md>) that earns one, and rotates a validated refresh token, expiring the family on a replay.
- [Access Token Minter](<Writers/Access Token Minter Explanation.md>): reads the active signing key and signs an access token carrying exactly a [token entitlement](<Authority/Token Entitlement Explanation.md>)'s claims.
- [Browser Session Writer](<Writers/Browser Session Writer Explanation.md>): stores the session a [same-device sign-in](<Authority/Same Device Sign In Explanation.md>) or a [claimed pairing](<Authority/Browser Pairing Explanation.md>) starts.
- [Test Fixtures](<Writers/Test Fixtures Explanation.md>): the helpers the writers' tests share.

## `domain::capabilities::writers::tests`

**A privileged write outside the writers fails the unit tests.** A new flow that reached around a writer would reach around the proof the writer's method demands, so the rule is pinned by a [source guard](<Domain/Source Guards Explanation.md>) rather than left to review. The guard holds two lists, each against the paths allowed it, and scans production code only ([`production_lines`](<Domain/Source Guards Explanation.md#item-source_guard--production_lines>)).

### `PRIVILEGED_CALLS` and `ALLOWED_PREFIXES`

The first list is the store calls that grant authority.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::PRIVILEGED_CALLS}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::ALLOWED_PREFIXES}}

### `ApprovalConstruction` and `APPROVAL_CONSTRUCTIONS`

The second is every way to make an [authorization request](<Domain/Authorization Request Explanation.md>) approved or claimed. A request changes only through its own transitions, and only the writers may call the approving ones, so an approved request can't be had without the proof the writer demands.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::ApprovalConstruction}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::APPROVAL_CONSTRUCTIONS}}

### The allowed paths

The paths `APPROVAL_CONSTRUCTIONS` names.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::ENTITY}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::CODE_ROW_CONVERSION}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::USER_CODE_ROW_CONVERSION}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::WRITERS}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::TEST_FAKE}}

### `holds`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::holds}}

### `violations`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::violations tests="tests::the_guard_catches_every_approval_construction_outside_its_files"}}

### `privileged_store_calls_happen_only_in_writers`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::privileged_store_calls_happen_only_in_writers}}
