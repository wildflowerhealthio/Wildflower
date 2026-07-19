//! Scope-gated capabilities for the `/collector/remotes` surface — the
//! collector slice's copy of the default-safe authorization pattern (the generic
//! machinery lives in [`scope_capabilities_rust`]; the pattern originated on
//! gatekeeper's `/access` surface, recipe in
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`). Each capability is the
//! only door to the store for its operations, so a handler that skips the scope
//! check has no way to touch data.
//!
//! Each capability lives in its own submodule — [`RemotesReader`] in
//! [`remotes_reader`], [`RemotesCreator`] in [`remotes_creator`],
//! [`RemotesEditor`] in [`remotes_editor`], [`RemotesDeleter`] in
//! [`remotes_deleter`] — holding the struct, its `*_scopes()` mapping, and its
//! store-focused tests. This module aggregates them into
//! [`grantable_collector_scopes`], re-exports the surface the bindings use, and
//! carries the cross-cutting guard tests.
//!
//! The scope **resource** is [`WildflowerResource::Accounts`] — a collector
//! remote is an *account* at a data origin, and a remote's stored `config` can
//! carry that origin's credentials (e.g. a pharmacy login), so even a read needs
//! the `.r` permission. The **code** entity stays `Remote` throughout this crate;
//! only the scope vocabulary renames it to `Accounts`.
//!
//! Every capability is the **fixed-scope** flavour (one static scope gates the
//! whole capability): the `Scoped` extractor checks the scope before `build`
//! runs, so the capability method never re-checks. Each is **generic over the
//! [`RemotesStore`](crate::domain::RemotesStore) port** (`Cap<S: RemotesStore>`)
//! and holds the store handle **lifted from the state** (never an
//! `Arc<CollectorState>` it reaches into), so its logic is unit-testable against
//! the in-memory fake. The
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability)
//! bindings that name the concrete `SqliteRemotesStore` and build a capability
//! from the router state live beside the state in
//! [`crate::live_bindings`](crate::live_bindings) — so this module stays store-agnostic and free
//! of `crate::http`.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its `Capability` binding
//! and [`grantable_collector_scopes`], so *enforced* and *grantable* can't drift.

use scopes_rust::Scope;

mod remotes_creator;
mod remotes_deleter;
mod remotes_editor;
mod remotes_reader;

pub(crate) use remotes_creator::{remotes_creator_scopes, RemotesCreator};
pub(crate) use remotes_deleter::{remotes_deleter_scopes, RemotesDeleter};
pub(crate) use remotes_editor::{remotes_editor_scopes, RemotesEditor};
pub(crate) use remotes_reader::{remotes_reader_scopes, RemotesReader};

/// The `wildflower/Accounts.*` scopes the `/collector/remotes` surface enforces,
/// deduplicated in declaration order — the registry mapping *capability →
/// required scope*. Because it reads the very `*_scopes()` functions the
/// `Capability` bindings enforce, what a token can be *granted* and what it is
/// *checked against* come from one source. The per-slice grantable vocabulary;
/// nothing consumes it yet (the tests below pin it until a consent surface does).
#[must_use]
pub fn grantable_collector_scopes() -> Vec<Scope> {
    // One scope each and all distinct (`.r`/`.c`/`.u`/`.d`), so no dedup is
    // needed — but the order is the read/create/update/delete the table declares.
    [
        remotes_reader_scopes(),
        remotes_creator_scopes(),
        remotes_editor_scopes(),
        remotes_deleter_scopes(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::domain::test_fake::FakeRemotesStore;
    use crate::domain::{Remote, RemotesStore};

    /// A `config` JSON with the given discriminant `_tag`. Shared by the creator
    /// and editor test modules.
    pub(crate) fn config(tag: &str) -> serde_json::Value {
        serde_json::json!({ "_tag": tag, "rootUrl": "https://x" })
    }

    /// Seed a remote straight through the port (bypassing a capability) so the
    /// capability under test can then own the store by value. Shared by the
    /// reader, editor, and deleter test modules.
    pub(crate) fn seed(store: &FakeRemotesStore, id: &str, name: &str, tag: &str) {
        store
            .insert(&Remote {
                id: id.to_owned(),
                name: name.to_owned(),
                tag: tag.to_owned(),
                config: config(tag),
                added_at: "2026-07-01T00:00:00.000Z".to_owned(),
            })
            .expect("seed insert");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grantable vocabulary is exactly `wildflower/Accounts.{r,c,u,d}`, in
    /// that order — the scopes the four capabilities enforce. Pins both the
    /// rename (`Remote` code entity → `Accounts` scope resource) and the letter
    /// permissions so a drift in either is a red test, not a silent lock-out.
    #[test]
    fn grantable_scopes_are_accounts_r_c_u_d() {
        assert_eq!(
            scopes_rust::render_scopes(&grantable_collector_scopes()),
            vec![
                "wildflower/Accounts.r".to_owned(),
                "wildflower/Accounts.c".to_owned(),
                "wildflower/Accounts.u".to_owned(),
                "wildflower/Accounts.d".to_owned(),
            ],
        );
    }

    /// A typo in a required-scope spelling would fall to `Scope::Unknown`, which
    /// an owner's `wildflower/*.cruds` can't cover — locking the owner out.
    /// Assert each grantable scope is a real Wildflower resource scope so that
    /// can't ship.
    #[test]
    fn every_grantable_scope_is_a_known_wildflower_resource() {
        for scope in grantable_collector_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_collector_scopes`]'s array must list
    /// all of them. A capability added without registering enforces a scope the
    /// grantable vocabulary never offers — a silent lock-out. Counting the scope
    /// functions textually across the capability files keeps honest additions
    /// honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        // Count the per-capability scope functions across the sibling files — the
        // `pub(crate) fn …_scopes() -> Vec<Scope>` definitions, one per
        // capability. `mod.rs` is skipped, so neither the public
        // `grantable_collector_scopes` aggregator (also `…_scopes`, but `pub fn`)
        // nor this test's own needle literal is folded in. The two needles live on
        // separate lines so this filter closure never satisfies both on one line.
        let capability_scope_fns = rs_files_under(capabilities_dir)
            .into_iter()
            .filter(|path| path.file_name().is_some_and(|name| name != "mod.rs"))
            .flat_map(|path| {
                std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read capability source {}: {e}", path.display()))
                    .lines()
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|line| {
                let is_pub_crate_fn = line.contains("pub(crate) fn");
                let returns_scope_vec = line.contains("_scopes() -> Vec<Scope>");
                is_pub_crate_fn && returns_scope_vec
            })
            .count();
        // One array entry per capability's scope function. Update BOTH when adding
        // a capability: its `*_scopes()` fn and the `grantable_collector_scopes()`
        // array.
        let declared_entries = 4;
        assert_eq!(
            capability_scope_fns, declared_entries,
            "found {capability_scope_fns} capability scope functions but \
             grantable_collector_scopes() declares {declared_entries}; register the new \
             capability in its array",
        );
    }

    /// Default-safety guard: the scope-gated `/collector/remotes` handler files
    /// must reach the store **only** through a `Scoped<…>` capability — never a
    /// raw router `State<…>` or a direct `.store` field access. Bypassing the
    /// capability would need one of these tokens, and this test fails if one
    /// appears, so a forgotten scope check can't ship silently. (Mirrors
    /// gatekeeper's `access_handlers_reach_the_store_only_through_capabilities`.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default. (Advisory-strength: the needles are textual.)
    #[test]
    fn remotes_handlers_reach_the_store_only_through_capabilities() {
        // Raw router state or a direct store field access — the only ways to
        // reach a remote without a capability.
        const FORBIDDEN: &[&str] = &["State<", ".store"];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            // Module glue and the handler-test file (`routes/mod.rs`) are exempt —
            // every operation handler lives in its own file and is gated.
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the store directly \
                     (`{needle}`); acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 5,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("readable dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files.sort();
        files
    }
}
