//! Scope-gated capabilities for the `/apps` surface — the apps slice's copy of the
//! default-safe authorization pattern (the generic machinery lives in
//! [`scope_capabilities_rust`]; the pattern originated on gatekeeper's `/access`
//! surface, recipe in `docs/Authorization/Scope-Gated Endpoints How-To.md`). They
//! live in `domain/` beside the [`AppsStore`](crate::domain::AppsStore) port they
//! operate through — never importing `crate::http` — so a forgotten permission
//! check can't compile a data-touching handler, and the whole surface stays
//! unit-testable against the in-memory `FakeAppsStore`.
//!
//! Each capability lives in its own submodule — [`AppsReader`] in [`apps_reader`],
//! [`AppsCreator`] in [`apps_creator`], [`AppsEditor`] in [`apps_editor`],
//! [`AppsDeleter`] in [`apps_deleter`], and the hybrid [`AppLauncher`] in
//! [`app_launcher`] — each holding the struct, its `*_scopes()` mapping, and its
//! store-focused test. This module aggregates them into [`grantable_apps_scopes`],
//! re-exports the surface the bindings and handlers use, and carries the
//! cross-cutting guard tests.
//!
//! The four admin capabilities are the **fixed-scope** flavour: one static
//! `wildflower/Apps.<perm>` scope gates the whole capability, checked by the
//! [`Scoped`](scope_capabilities_rust::Scoped) extractor before `build` runs. The
//! launch capability is the **hybrid** flavour (the static `wildflower/launch`
//! umbrella plus a data-dependent per-app SMART check). So the structs here are
//! generic over the store port (and, where they touch the self-hosted installer,
//! over that port too) and hold their dependencies **lifted from the state** —
//! never an `Arc<AppsState>` they reach into. The concrete
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability) /
//! [`Capability`](scope_capabilities_rust::Capability) bindings that name the
//! `SqliteAppsStore` adapter and `build` a capability from the router state live
//! beside the state in [`crate::live_bindings`], so `domain/` stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_apps_scopes`], so *enforced* and *grantable* can't drift.

use std::collections::HashSet;

use scopes_rust::Scope;

mod app_launcher;
mod apps_creator;
mod apps_deleter;
mod apps_editor;
mod apps_reader;

pub(crate) use app_launcher::{app_launcher_scopes, AppLauncher};
pub(crate) use apps_creator::{apps_creator_scopes, AppsCreator};
pub(crate) use apps_deleter::{apps_deleter_scopes, AppsDeleter};
pub(crate) use apps_editor::{apps_editor_scopes, AppsEditor};
pub(crate) use apps_reader::{apps_reader_scopes, AppsReader};

/// The apps scopes the slice enforces, deduplicated in declaration order — the
/// registry mapping *capability → required scope*, spanning the admin surface
/// (`Apps.{r,c,u,d}`) and the launch umbrella (`wildflower/launch`). Because it
/// reads the very `*_scopes()` functions the capability bindings enforce, what a
/// token can be *granted* and what it is *checked against* come from one source.
/// The intended grantable vocabulary for the consent surfaces (mirrors gatekeeper's
/// `grantable_admin_scopes`); nothing consumes it yet — the tests below pin it.
#[must_use]
pub fn grantable_apps_scopes() -> Vec<Scope> {
    let declared = [
        apps_reader_scopes(),
        apps_creator_scopes(),
        apps_editor_scopes(),
        apps_deleter_scopes(),
        app_launcher_scopes(),
    ];
    let mut seen = HashSet::new();
    declared
        .into_iter()
        .flatten()
        .filter(|scope| seen.insert(scope.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grantable_apps_scopes_are_the_expected_scopes() {
        let rendered = scopes_rust::render_scopes(&grantable_apps_scopes());
        assert_eq!(
            rendered,
            vec![
                "wildflower/Apps.r".to_owned(),
                "wildflower/Apps.c".to_owned(),
                "wildflower/Apps.u".to_owned(),
                "wildflower/Apps.d".to_owned(),
                // A *known* scope, deliberately last — not covered by the
                // `wildflower/*` resource wildcard, so it must be granted explicitly.
                "wildflower/launch".to_owned(),
            ],
        );
    }

    #[test]
    fn no_required_scope_is_an_unknown_scope() {
        // A typo in a required-scope spelling would fall to `Scope::Unknown`, which
        // no token can cover — locking every caller out. Assert each is a real scope
        // (a Wildflower resource, or the `wildflower/launch` known scope).
        for scope in grantable_apps_scopes() {
            assert!(
                !matches!(scope, Scope::Unknown(_)),
                "required scope {scope} parsed as Unknown — a typo no token can cover",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_apps_scopes`]'s `declared` array must
    /// list all of them. A capability added without registering enforces a scope the
    /// grantable vocabulary never offers — a silent lock-out. Counting the scope
    /// functions textually across the sibling capability files keeps an honest
    /// addition honest — and, unlike matching a call body, survives rustfmt's line
    /// wrapping.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        // Count the per-capability scope functions across the sibling files — the
        // `pub(crate) fn …_scopes() -> Vec<Scope>` definitions, one per capability.
        // `mod.rs` is skipped, so neither the public `grantable_apps_scopes`
        // aggregator (also `…_scopes`, but `pub fn`) nor this test's own needle
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
        // One `declared` entry per capability's scope function. Update BOTH when
        // adding a capability: its `*_scopes()` fn and the `declared` array.
        let declared_entries = 5;
        assert_eq!(
            scope_fns, declared_entries,
            "found {scope_fns} capability scope functions but grantable_apps_scopes() declares \
             {declared_entries}; register the new capability in its `declared` array",
        );
    }

    /// Default-safety guard: the `/apps` handler files must reach the store
    /// **only** through a `Scoped<…>` capability — never a raw router
    /// `State<Arc<AppsState>>` or a direct `state.store` access. Bypassing the
    /// capability would need one of these tokens, and this test fails if one
    /// appears, so a forgotten scope check can't ship silently. (Mirrors
    /// gatekeeper's `access_handlers_reach_the_store_only_through_capabilities`
    /// and databases' `database_handlers_reach_the_store_only_through_capabilities`.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default. `launch.rs` is the one exempted file: the launch
    /// response glue (tunnel / loopback / webview seams) legitimately reaches the
    /// state, while its scope check rides the `Scoped<LiveAppLauncher>` umbrella +
    /// the in-handler SMART gate. (Advisory-strength: the needles are textual.)
    #[test]
    fn apps_handlers_reach_the_store_only_through_capabilities() {
        // Raw router state or a direct store field access — the only ways to reach
        // the store without a capability.
        const FORBIDDEN: &[&str] = &["State<", "state.store"];
        // Module glue (router split + the router test suite) and the launch glue.
        const EXEMPT_FILES: &[&str] = &["mod.rs", "launch.rs"];
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
            checked >= 8,
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
