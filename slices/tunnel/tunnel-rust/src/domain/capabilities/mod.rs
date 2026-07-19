//! Scope-gated capabilities for the `/tunnel` surface — the tunnel slice's copy
//! of the default-safe authorization pattern (the generic machinery lives in
//! [`scope_capabilities_rust`]; the pattern originated on gatekeeper's `/access`
//! surface, recipe in `docs/Authorization/Scope-Gated Endpoints How-To.md`).
//! They live in `domain/` and depend only on the
//! [`TunnelStore`](crate::domain::TunnelStore) port + the [`TunnelDaemon`] handle
//! lifted from the state — never on `crate::http` — so the store-touching half is
//! unit-testable against the in-memory fake.
//!
//! Each capability lives in its own submodule — [`TunnelSettingsReader`] in
//! [`tunnel_settings_reader`], [`TunnelSettingsEditor`] in
//! [`tunnel_settings_editor`] — holding the struct, its `*_scopes()` mapping, and
//! its store-focused test. This module aggregates them into
//! [`grantable_tunnel_scopes`], re-exports the surface the bindings and handlers
//! use, and carries the cross-cutting guard tests.
//!
//! `TunnelSettings` is a **singleton** (no id), so — like gatekeeper's `/access`
//! surface, unlike databases' per-resource gate — both capabilities are the
//! **fixed-scope** flavour: the whole capability is gated by one static scope
//! (`wildflower/TunnelSettings.r` to read, `.u` to replace), checked by the
//! [`Scoped`] extractor before `build` runs. The concrete
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability)
//! bindings that name `SqliteTunnelStore` live beside the router state
//! (`crate::live_bindings`), so `domain/` stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_tunnel_scopes`], so *enforced* and *grantable* can't drift.

use scopes_rust::Scope;

pub(crate) use scope_capabilities_rust::Scoped;

mod tunnel_settings_editor;
mod tunnel_settings_reader;

pub(crate) use tunnel_settings_editor::{tunnel_settings_editor_scopes, TunnelSettingsEditor};
pub(crate) use tunnel_settings_reader::{tunnel_settings_reader_scopes, TunnelSettingsReader};

/// The tunnel scopes the `/tunnel` surface enforces, deduplicated in declaration
/// order — the registry mapping *capability → required scope*. Because it reads
/// the very `*_scopes()` functions the bindings enforce, what a token can be
/// *granted* and what it is *checked against* come from one source. Pinned by the
/// tests below until a consent/admin surface consumes it.
#[must_use]
pub fn grantable_tunnel_scopes() -> Vec<Scope> {
    let declared = [
        tunnel_settings_reader_scopes(),
        tunnel_settings_editor_scopes(),
    ];
    let mut seen = std::collections::HashSet::new();
    declared
        .into_iter()
        .flatten()
        .filter(|scope| seen.insert(scope.clone()))
        .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use crate::domain::TunnelDaemon;
    use crate::health::HealthProbe;
    use crate::test_support::{HoldUntilCancelRelayClient, StubProbe};

    /// A daemon handle for the store-focused capability tests. The capabilities
    /// only *read* the daemon (the handler drives it), so any idle daemon does.
    /// Shared by the reader and editor test modules.
    pub(crate) fn daemon() -> Arc<TunnelDaemon> {
        let probe: Arc<dyn HealthProbe> = Arc::new(StubProbe::passing());
        Arc::new(TunnelDaemon::new_test(
            Arc::new(HoldUntilCancelRelayClient),
            probe,
            "http://127.0.0.1:8080",
            8080,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grantable_tunnel_scopes_are_the_expected_wildflower_scopes() {
        let rendered = scopes_rust::render_scopes(&grantable_tunnel_scopes());
        assert_eq!(
            rendered,
            vec![
                "wildflower/TunnelSettings.r".to_owned(),
                "wildflower/TunnelSettings.u".to_owned(),
            ],
        );
    }

    #[test]
    fn every_required_scope_is_a_known_wildflower_resource_not_unknown() {
        // A typo in a required-scope spelling would fall to `Scope::Unknown`,
        // which an owner's `wildflower/*.cruds` can't cover — locking the owner
        // out. Assert each is a real Wildflower resource scope so that can't ship.
        for scope in grantable_tunnel_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_tunnel_scopes`]'s `declared` array
    /// must list all of them. A capability added without registering enforces a
    /// scope the grantable vocabulary never offers — a silent lock-out. Counting
    /// the scope functions textually across the capability files keeps honest
    /// additions honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        // Count the per-capability scope functions across the sibling files — the
        // `pub(crate) fn …_scopes() -> Vec<Scope>` definitions, one per
        // capability. `mod.rs` is skipped, so neither the public
        // `grantable_tunnel_scopes` aggregator (also `…_scopes`, but `pub fn`) nor
        // this test's own needle literal is folded in. The two needles live on
        // separate lines so this filter closure never satisfies both on one line.
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
        // One `declared` entry per capability's scope function. Update BOTH when
        // adding a capability: its `*_scopes()` fn and the `declared` array.
        let declared_entries = 2;
        assert_eq!(
            scope_fns, declared_entries,
            "found {scope_fns} capability scope functions but grantable_tunnel_scopes() declares \
             {declared_entries}; register the new capability in its `declared` array",
        );
    }

    /// Default-safety guard: the scope-gated `/tunnel` handler files must reach
    /// the store **only** through a `Scoped<…>` capability — never a raw
    /// `State<Arc<TunnelState>>` or a direct `.store` field access. This test
    /// fails if one appears, so a forgotten scope check can't ship silently.
    /// (Mirrors gatekeeper's / databases' source-guard tests.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default — it must be consciously exempted below to escape.
    /// (Advisory-strength, deliberately: the needles are textual.) The daemon is
    /// deliberately NOT forbidden: the handler drives it through the capability's
    /// `daemon()` accessor (acquired behind the gate), and it is runtime state,
    /// not the scope-protected settings.
    #[test]
    fn tunnel_handlers_reach_the_store_only_through_capabilities() {
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
