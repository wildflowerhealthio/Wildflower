# Source Guards

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs}}

Some of the crate's rules are about where code may be written, not what it does. A route handler never reaches the store except through a capability. A privileged write never happens outside a writer. The domain never imports the transport layer. The compiler can't hold those, so **source-guard tests** do: each enumerates the source files and fails on a line that breaks the rule, so a new file is guarded the day it is added.

They are advisory-strength, and say so. The needles are text, not types: a guard catches the ordinary way of breaking its rule, not a determined one. What keeps them honest is that they scan **production code only**. Comments and string literals may name anything, and every `#[cfg(test)]` item (the unit-test module, a test-only method, a test-only `use`) may arrange state directly, planting rows or building proofs, without being the production path the guard pins.

## The domain module

`src/domain/mod.rs` is also the domain's front page. **Nothing in the domain depends on `crate::http`.** The entities carry diesel derives naming their `crate::db` tables, and that is the domain's only reach into the adapter.

- The **entities**, one module each, own their rules. An [authorization request](<Authorization Request Explanation.md>) owns its lifecycle: each change is a transition, and the store writes it back only while the row still has the status it was read with.
- The **port**, the [grant store](<../Grant Store Explanation.md>), is persistence as the domain sees it: one scope per operation, read or write, handing out single-statement primitives, one trait per table.
- The **capabilities** are the operations. Each opens its one scope at its top, runs its flow inside to an outcome, and acts on the outcome (republishing, the revocation store) once the scope has closed ([Capabilities](<../Capabilities Explanation.md>)).
- The **authority proofs** are what every privileged write demands ([Authority](<../Authority Explanation.md>)), and the **writers** are the one place those writes happen ([Writers](<../Writers Explanation.md>)).

Everything fails with the domain's own [`AuthorizationServerError`](<Errors Explanation.md#item-AuthorizationServerError>).

## The guards

Two guards sit here, and three more beside the layers they guard:

- [`production_code_precedes_the_test_module`](#item-test_layout_guard--production_code_precedes_the_test_module): no file under `src/` has production code after its unit-test module.
- [`domain_never_references_crate_http`](#item-http_free_guard--domain_never_references_crate_http): no file under `src/domain/` names `crate::http`.
- {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::handlers_reach_the_state_only_through_capabilities}}: no route handler names the router state or one of its fields; it reaches them only through a capability extractor ([Capabilities](<../Capabilities Explanation.md>)).
- {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::middleware_verifies_only_through_the_token_verifier}}: no middleware names the store or the revocation store; the gates verify a token through the token verifier.
- {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::privileged_store_calls_happen_only_in_writers}}: the calls that grant authority, and the building of an approved or claimed request, appear only in the writers and the few files allowed them ([Writers](<../Writers Explanation.md>)).

The handler, middleware and writer guards also fail when they find fewer files than expected, so a moved directory can't make them pass by scanning nothing.

## `domain::source_guard`

The helpers every guard in the crate scans with. Enumerating `.rs` files and making a path relative are project-agnostic, and come from the kitchen-sink crate:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard from="pub(crate) use"}}

What this module adds is reading Rust as production code. Its own tests trim each scanned line with a [small helper](<Test Fixtures Explanation.md#source-guards>), so assertions read the code as written.

### `production_lines`

**The lines a guard scans.**

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::production_lines tests="source_guard::tests::skips_only_the_gated_item source_guard::tests::skips_a_braceless_gated_item"}}

### `production_code_after_test_module`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::production_code_after_test_module tests="source_guard::tests::reports_production_code_after_the_test_module"}}

### `CfgTestItem`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::CfgTestItem}}

### `cfg_test_items`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::cfg_test_items}}

### `item_end`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::item_end}}

### `is_mod_header`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::is_mod_header}}

### `code_only`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::code_only tests="source_guard::tests::code_only_blanks_comments_and_literals"}}

### `raw_string_hashes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::raw_string_hashes}}

## `domain::test_layout_guard`

### `production_code_precedes_the_test_module`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs test_layout_guard::production_code_precedes_the_test_module}}

## `domain::http_free_guard`

### `domain_never_references_crate_http`

The guard's needle is assembled from parts, so its own source doesn't trip it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs http_free_guard::domain_never_references_crate_http}}
