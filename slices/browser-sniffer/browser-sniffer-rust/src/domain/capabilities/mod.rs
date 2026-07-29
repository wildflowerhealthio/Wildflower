//! Scope-gated capabilities for the `/sniffer` surface — the browser-sniffer
//! slice's copy of the default-safe authorization pattern (the generic
//! machinery lives in [`scope_capabilities_rust`]; recipe in
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`). Each capability is
//! the only door to the host handle / event stream for its operations, so a
//! handler that skips the scope check has no way to drive the webview or read
//! the stream.
//!
//! The scope **resource** is [`WildflowerResource::Sniffer`]: driving the
//! sniffer opens arbitrary origins in an on-device webview and its event
//! stream carries the sniffed pages' response bodies verbatim, so both sides
//! are gated (not merely authenticated). Two capabilities:
//! [`SnifferDriver`] (`.c`, the whole mutating control plane) in
//! [`sniffer_driver`], and [`SnifferObserver`] (`.r`, the event stream) in
//! [`sniffer_observer`].
//!
//! Every capability is the **fixed-scope** flavour; the
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability)
//! bindings that lift the handle / events out of the router state live beside
//! the state in [`crate::live_bindings`], so this module stays free of
//! `crate::http`.
//!
//! The (resource, permission) → required-scope mapping lives in one place —
//! each capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_sniffer_scopes`], so *enforced* and *grantable* can't drift.

use scopes_rust::Scope;

mod sniffer_driver;
mod sniffer_observer;

pub(crate) use sniffer_driver::{sniffer_driver_scopes, SnifferDriver};
pub(crate) use sniffer_observer::{sniffer_observer_scopes, SnifferObserver};

/// The `wildflower/Sniffer.*` scopes the `/sniffer` surface enforces, in
/// declaration order — the registry mapping *capability → required scope*.
/// Because it reads the very `*_scopes()` functions the bindings enforce, what
/// a token can be *granted* and what it is *checked against* come from one
/// source.
#[must_use]
pub fn grantable_sniffer_scopes() -> Vec<Scope> {
    [sniffer_driver_scopes(), sniffer_observer_scopes()]
        .into_iter()
        .flatten()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grantable vocabulary is exactly `wildflower/Sniffer.{c,r}` — the
    /// scopes the two capabilities enforce. Pins the resource name and the
    /// letter permissions so a drift in either is a red test, not a silent
    /// lock-out.
    #[test]
    fn grantable_scopes_are_sniffer_c_and_r() {
        assert_eq!(
            scopes_rust::render_scopes(&grantable_sniffer_scopes()),
            vec![
                "wildflower/Sniffer.c".to_owned(),
                "wildflower/Sniffer.r".to_owned(),
            ],
        );
    }

    /// A typo in a required-scope spelling would fall to `Scope::Unknown`,
    /// which an owner's `wildflower/*.cruds` can't cover — locking the owner
    /// out. Assert each grantable scope is a real Wildflower resource scope so
    /// that can't ship.
    #[test]
    fn every_grantable_scope_is_a_known_wildflower_resource() {
        for scope in grantable_sniffer_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every capability declares exactly one
    /// `*_scopes()` function, and [`grantable_sniffer_scopes`]'s array must
    /// list all of them. (Mirrors collector-rust's guard; textual, so
    /// advisory-strength.)
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        let capabilities_dir = std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities"
        ));
        let capability_scope_fns = std::fs::read_dir(capabilities_dir)
            .expect("enumerate capabilities dir")
            .map(|entry| entry.expect("readable dir entry").path())
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "rs")
                    && path.file_name().is_some_and(|name| name != "mod.rs")
            })
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
        // adding a capability: its `*_scopes()` fn and the
        // `grantable_sniffer_scopes()` array.
        let declared_entries = 2;
        assert_eq!(
            capability_scope_fns, declared_entries,
            "found {capability_scope_fns} capability scope functions but \
             grantable_sniffer_scopes() declares {declared_entries}; register the new capability \
             in its array",
        );
    }

    /// Default-safety guard: the scope-gated `/sniffer` handler files must
    /// reach the handle/events **only** through a `Scoped<…>` capability —
    /// never a raw router `State<…>` or a direct field access. (Mirrors
    /// collector-rust's guard; textual, so advisory-strength.)
    #[test]
    fn sniffer_handlers_reach_the_host_only_through_capabilities() {
        const FORBIDDEN: &[&str] = &["State<", ".handle", ".events"];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the host directly (`{needle}`); \
                     acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 7,
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
