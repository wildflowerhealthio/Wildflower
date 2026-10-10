//! The scope-gated capability for the `/requests` surface — the request-log
//! slice's copy of the default-safe authorization pattern (the generic
//! machinery lives in [`wildflowerhealthio_scope_capabilities`]; recipe in
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`). The capability is the
//! only door to the store for its operations, so a handler that skips the scope
//! check has no way to read the log.
//!
//! [`RequestLogReader`] lives in [`request_log_reader`], holding the struct, its
//! `*_scopes()` mapping, and its store-focused test. This module aggregates the
//! scopes into [`grantable_request_log_scopes`], re-exports the surface the
//! binding uses, and carries the cross-cutting guard tests.
//!
//! The capability is the **fixed-scope** flavour: one static scope,
//! `wildflower/RequestLog.r`, gates it, checked by the [`Scoped`] extractor
//! before `build` runs. It is **generic over the
//! [`RequestLogStore`](crate::domain::RequestLogStore) port** and holds the
//! store handle lifted from the state. The concrete
//! [`FixedScopeCapability`](wildflowerhealthio_scope_capabilities::FixedScopeCapability)
//! binding that names `SqliteRequestLogStore` lives beside the router state in
//! `crate::live_bindings`, so `domain/` stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — the
//! capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_request_log_scopes`], so *enforced* and *grantable* can't drift.

use wildflowerhealthio_scopes::Scope;

pub(crate) use wildflowerhealthio_scope_capabilities::Scoped;

mod request_log_reader;

pub(crate) use request_log_reader::{request_log_reader_scopes, RequestLogReader};

/// The scopes the `/requests` surface enforces — the registry mapping
/// *capability → required scope*. Because it reads the very `*_scopes()`
/// functions the binding enforces, what a token can be *granted* and what it is
/// *checked against* come from one source. Pinned by the tests below until a
/// consent/admin surface consumes it.
#[must_use]
pub fn grantable_request_log_scopes() -> Vec<Scope> {
    [request_log_reader_scopes()]
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grantable_request_log_scopes_are_the_request_log_read_scope() {
        assert_eq!(
            wildflowerhealthio_scopes::render_scopes(&grantable_request_log_scopes()),
            vec!["wildflower/RequestLog.r".to_owned()],
        );
    }

    /// A typo in a required-scope spelling would fall to `Scope::Unknown`,
    /// which an owner's `wildflower/*.cruds` can't cover — locking the owner
    /// out. Assert each is a real Wildflower resource scope so that can't ship.
    #[test]
    fn every_required_scope_is_a_known_wildflower_resource_not_unknown() {
        for scope in grantable_request_log_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_request_log_scopes`]'s array must
    /// list all of them. A capability added without registering enforces a
    /// scope the grantable vocabulary never offers — a silent lock-out.
    /// Counting the scope functions textually across the capability files keeps
    /// honest additions honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        // Count the per-capability scope functions across the sibling files — the
        // `pub(crate) fn …_scopes() -> Vec<Scope>` definitions, one per
        // capability. `mod.rs` is skipped, so neither the public
        // `grantable_request_log_scopes` aggregator nor this test's own needle
        // literal is folded in. The two needles live on separate lines so this
        // filter closure never satisfies both on one line.
        let scope_fns = rs_files_under(capabilities_dir)
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
        // One array entry per capability's scope function. Update BOTH when
        // adding a capability: its `*_scopes()` fn and the array.
        let declared_entries = 1;
        assert_eq!(
            scope_fns, declared_entries,
            "found {scope_fns} capability scope functions but grantable_request_log_scopes() \
             declares {declared_entries}; register the new capability in its array",
        );
    }

    /// Default-safety guard: the scope-gated `/requests` handler files must
    /// reach the store **only** through a `Scoped<…>` capability — never a raw
    /// `State<…>` or a direct `.store` field access. This test fails if one
    /// appears, so a forgotten scope check can't ship silently.
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default — it must be consciously exempted below to escape.
    /// (Advisory-strength, deliberately: the needles are textual.)
    #[test]
    fn request_log_handlers_reach_the_store_only_through_capabilities() {
        // Module glue (`mod.rs`) and the pure wire-representation helper are not
        // handlers; every operation handler is gated.
        const EXEMPT_FILES: &[&str] = &["mod.rs", "wire_representations.rs"];
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
            let file_name = relative.rsplit('/').next().unwrap_or(&relative);
            if EXEMPT_FILES.contains(&file_name) {
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
            checked >= 2,
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
