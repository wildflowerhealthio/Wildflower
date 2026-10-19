# Source Guards

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs}}

Some of the crate's rules are about where code may be written, not what it does. A route handler never reaches the store except through a capability. A privileged write never happens outside a writer. The domain never imports the transport layer. The compiler can't hold those, so **source-guard tests** do: each enumerates the source files and fails on a line that breaks the rule, so a new file is guarded the day it is added.

They are advisory-strength, and say so. The needles are text, not types: a guard catches the ordinary way of breaking its rule, not a determined one. What keeps them honest is that they scan **production code only**. Comments and string literals may name anything, and every `#[cfg(test)]` item (the unit-test module, a test-only method, a test-only `use`) may arrange state directly, planting rows or building proofs, without being the production path the guard pins.

## The domain module

`src/domain/mod.rs` is also the domain's front page. **Nothing in the domain depends on `crate::http`.** The entities carry diesel derives naming their `crate::db` tables, and that is the domain's only reach into the adapter.

- The **entities**, one module each, own their rules: an [authorization request](<Authorization Request Explanation.md>) owns its lifecycle, each change a transition the store writes back only where the row is still in the phase it was read in.
- The **port**, the [grant store](<../Grant Store Explanation.md>), is persistence as the domain sees it: one scope per operation, read or write, handing out single-statement primitives, one trait per table.
- The **capabilities** are the operations. Each opens its one scope at its top, runs its flow inside to an outcome, and acts on the outcome (republishing, the revocation store) once the scope has closed ([Capabilities](<../Capabilities Explanation.md>)).
- The **authority proofs** are what every privileged write demands ([Authority](<../Authority Explanation.md>)), and the **writers** are the one place those writes happen ([Writers](<../Writers Explanation.md>)).

Everything fails with the domain's own [`AuthorizationServerError`](<Errors Explanation.md#authorizationservererror>).

## What the guards enforce

| Guard                                                                                                                                         | The rule                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`domain_never_references_crate_http`](#domain_never_references_crate_http)                                                                   | No file under `src/domain/` names `crate::http`.                                                                                                                                                                           |
| [`production_code_precedes_the_test_module`](#production_code_precedes_the_test_module)                                                       | No file under `src/` has production code after its unit-test module.                                                                                                                                                       |
| [`handlers_reach_the_state_only_through_capabilities`](<../Capabilities Explanation.md#handlers_reach_the_state_only_through_capabilities>)   | No route handler (any file under `src/http/routes/` but `mod.rs`) names the router state or one of its fields: it reaches them only through a `Scoped`, `Authenticated` or `Live` capability extractor.                    |
| [`middleware_verifies_only_through_the_token_verifier`](<../Capabilities Explanation.md#middleware_verifies_only_through_the_token_verifier>) | No file under `src/http/middleware/` names the store or the revocation store: the gates verify a token through the token verifier.                                                                                         |
| [`privileged_store_calls_happen_only_in_writers`](<../Writers Explanation.md#privileged_store_calls_happen_only_in_writers>)                  | The calls that grant authority (approving a request, issuing a code, recording a grant, reading the signing key, starting a session, …) appear only in the writers, the store adapter and port, the test fake and seeding. |

The handler, middleware and writer guards also fail when they find fewer files than expected, so a moved directory can't make them pass by scanning nothing.

## `source_guard`

The shared helpers every guard in the crate scans with. Enumerating `.rs` files (`rs_files_under`) and making a path relative (`relative_to`) are project-agnostic and come from the kitchen-sink crate; what this module adds is reading Rust as production code.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard from="pub(crate) use"}}

## Test fixtures

The helpers' own tests trim each scanned line, so assertions read the code as written.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::scanned}}

## `code_only`

The source, line for line, with every comment and every string or char literal replaced by spaces, so what remains is code alone and line numbers still match the file. It handles line comments, nested block comments, escaped strings, raw strings with any number of `#`s (and their byte forms), and tells a char literal like `'{'` from a lifetime like `'a`. Blanking literals also blanks the braces inside them, which keeps the test-item finder's brace count true.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::code_only}}

A raw string starts at an `r` or `br` that isn't the tail of an identifier, followed by any `#`s and a quote:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::raw_string_hashes}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::code_only_blanks_comments_and_literals}}

A needle inside a string, a line comment, a block comment and a raw string is gone; a brace in a char literal is gone, a lifetime is kept, and escaped char literals blank to their full width.

## `production_lines`

**The lines a guard scans**: the production code of a file, one entry per non-blank line, numbered from 1. Comments and literals are already blank; every `#[cfg(test)]` item is skipped, and only that item, so production code after a test-only method is still scanned.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::production_lines}}

A gated item runs from its `#[cfg(test)]` through any further attributes to where its braces balance, or, for an item with no body, to its `;`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::cfg_test_items}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::item_end}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::skips_only_the_gated_item}}

A test-only method in the middle of an `impl` is skipped, and the production method after it is still scanned.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::skips_a_braceless_gated_item}}

A gated `mod fake;` and a gated `use` are skipped alone, leaving the function after them.

## `production_code_after_test_module`

**Production code belongs above the tests**, so a reader who reaches `#[cfg(test)] mod tests` has seen the whole implementation. This answers the line of the first production code after the file's first inline test module, or `None`. A braceless `#[cfg(test)] mod x;` isn't an inline module, and a second gated module after the first is test code, not production.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::production_code_after_test_module}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs source_guard::tests::reports_production_code_after_the_test_module}}

A file whose tests come last, a file with none, and a file with only a gated `mod fake;` above its code report nothing; an `impl` after the test module is reported at its line, past a blank line and a comment; two test modules in a row are fine.

## `production_code_precedes_the_test_module`

**No file under `src/` has production code after its unit-test module.** Every violation is collected and reported at once, as `path:line`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs test_layout_guard::production_code_precedes_the_test_module}}

## `domain_never_references_crate_http`

**The domain never depends on the transport layer.** The capabilities live in the domain and are built from `crate::live_bindings`, so a stray `use crate::http::…` would couple the domain back to HTTP. The guard's needle is assembled from parts, so its own source doesn't trip it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/mod.rs http_free_guard::domain_never_references_crate_http}}
