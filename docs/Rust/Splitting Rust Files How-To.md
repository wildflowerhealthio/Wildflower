# Splitting Rust Files How-To

How to break a large Rust source file into a folder-module without breaking the
things that silently depend on its path — source-guard tests, path-prefix route
guards, and integration-test discovery. These are pure reorganization refactors,
but several non-obvious walls trip them.

## Goal

Turn `foo.rs` into `foo/{mod,…}.rs` (or split a big test file) and keep the
build, the guards, and the tests green.

## 1. Repoint `include_str!` source guards before you move a file

A source-guard test reads another file's text with `include_str!` and asserts
something about it (a count, a forbidden token). The path is relative to the
file the macro sits in, so moving _either_ file breaks it — silently, because
`include_str!` fails at compile time with a path error, not a test failure.

**Grep for `include_str!` before moving any file**, and repoint every hit. When
`consents.rs` splits into `consents/{mod,oauth,device,delegation}.rs`, the guard
in `gatekeeper-rust/src/domain/capabilities/mod.rs` that counts
`_scopes() -> Vec<Scope>` occurrences must repoint its
`include_str!("consents.rs")` to `include_str!("consents/mod.rs")` (the split
kept both `*_scopes()` fns in `mod.rs`).

## 2. Mind path-prefix and `read_dir` route guards

Some guards enumerate a directory tree at test time (`std::fs::read_dir`) so a
**new** `.rs` file is guarded by default. Two consequences when you split a file
into a subdirectory under such a tree:

- **A new subdirectory of a guarded file inherits the guard.** Splitting a
  non-exempt handler `admin.rs` into `admin/*.rs` means every new submodule is
  now scanned — if the submodules legitimately hold `State<…>` or a store
  accessor, the guard trips. Exempt them consciously; don't loosen the needle.
- **Path-prefix exemptions must still cover the split.** The gatekeeper guard
  `access_handlers_reach_the_store_only_through_capabilities` exempts by
  `EXEMPT_DIR_PREFIXES = ["oauth/"]` and `EXEMPT_FILES = ["mod.rs", …]`, so
  splitting `oauth/token_exchange.rs` into `oauth/token_exchange/*.rs` (whose
  submodules legitimately hold `State<`) stays green. The databases sibling
  guard skips `mod.rs` and `tests.rs`, so extracting an inline test module to
  `routes/tests.rs` needs `tests.rs` on the skip list.

The forbidden-token needle set is per slice (gatekeeper uses accessor shapes
`State<` / `.store`; databases uses `State<` plus module paths and a store type
name) — match whatever names the store-reaching shapes in _that_ crate, and
remember the guard is textual, so a mention of a needle in a doc comment counts.

## 3. A trait is one item — split by trait, never within one

You cannot split a single trait across files: a supertrait's methods need the
defining trait in scope at every call site, and every `impl` block would have to
fragment to match. So a file holding two traits
(`gatekeeper_store.rs` → `gatekeeper_store/{mod,tx,store}.rs`, one trait each)
splits cleanly, but decomposing one trait into per-resource sub-traits is a large
churn with real regression risk — not worth it for a size cleanup.

A large `impl` block is likewise irreducible; the honest split is structs +
one trait's impl in one file, the other trait's impl in another, and fixtures in
a third. A **child module can read its parent struct's private fields**, so the
impls and fixtures move down without widening any visibility.

## 4. A big integration test splits into ONE binary, not N

Cargo auto-discovers `tests/<name>/main.rs` as a **single** test target named
`<name>`. So a 3000-line `tests/integration.rs` becomes:

```text
tests/integration/
  main.rs        // mod common; mod smoke; mod oauth_endpoints; …
  common.rs      // shared helpers, all `pub` + `pub use`
  smoke.rs       // use crate::common::*;
  oauth_endpoints.rs
  …
```

`main.rs` is just `mod` declarations; every helper, `TestDb`, and shared `const`
lives in `common.rs` as `pub` (with a `pub use` re-export union), and each
section does `use crate::common::*;`. Because it compiles as **one** binary,
every helper is "used" by some section and the glob import never warns — so you
need no `#![allow(dead_code)]` (which the alternative `tests/common/mod.rs`-per-
binary layout would force, since each binary would see only part of `common`).

## 5. Update any doc that pins a moved path

A `.md` doc or doc comment that names a test by its old path
(`…/integration.rs::test` → `…/integration/smoke.rs::test`) is now a dead
reference. Grep for the old path and fix it in the same commit.

## References

- [Scope-Gated Endpoints How-To](../Authorization/Scope-Gated%20Endpoints%20How-To.md)
  — the source-guard capability pattern whose tests these splits must preserve.
- [Documentation How-To](../Documentation/How-To.md) — doc kind, naming, and
  placement rules.
- Agent Strategies § Rust — privatizing modules as a dead-code detector, and
  splitting a domain type from its persistence within one crate.
