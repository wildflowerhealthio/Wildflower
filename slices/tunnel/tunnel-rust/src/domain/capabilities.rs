//! Scope-gated capabilities for the `/tunnel` surface — the tunnel slice's copy
//! of the default-safe authorization pattern (the generic machinery lives in
//! [`scope_capabilities_rust`]; the pattern originated on gatekeeper's `/access`
//! surface, recipe in `docs/Authorization/Scope-Gated Endpoints How-To.md`).
//! They live in `domain/` and depend only on the
//! [`TunnelStore`](crate::domain::TunnelStore) port + the [`TunnelDaemon`] handle
//! lifted from the state — never on `crate::http` — so the store-touching half is
//! unit-testable against the in-memory fake (see the tests below).
//!
//! `TunnelSettings` is a **singleton** (no id), so — like gatekeeper's `/access`
//! surface, unlike databases' per-resource gate — both capabilities are the
//! **fixed-scope** flavour: the whole capability is gated by one static scope
//! (`wildflower/TunnelSettings.r` to read, `.u` to replace), checked by the
//! [`Scoped`] extractor before `build` runs. The concrete
//! [`FixedScopeCapability`] bindings that name `SqliteTunnelStore` live beside the
//! router state (`crate::state`), so `domain/` stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_tunnel_scopes`], so *enforced* and *grantable* can't drift.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};

pub(crate) use scope_capabilities_rust::Scoped;

use crate::domain::{
    actions, SettingsUpdate, SettingsUpdateOutcome, TunnelDaemon, TunnelError, TunnelSettings,
    TunnelStore,
};

/// The scope gating [`TunnelSettingsReader`] — `wildflower/TunnelSettings.r`.
/// Shared by the capability's `FixedScopeCapability` binding and
/// [`grantable_tunnel_scopes`] so enforced and grantable can't drift.
pub(crate) fn tunnel_settings_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::TunnelSettings,
        Permission::READ,
    )]
}

/// The scope gating [`TunnelSettingsEditor`] — `wildflower/TunnelSettings.u`.
pub(crate) fn tunnel_settings_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::TunnelSettings,
        Permission::UPDATE,
    )]
}

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

/// Read the singleton tunnel settings — `GET /tunnel`. Generic over the store
/// port so the store read is unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteTunnelStore`. Holds the store handle
/// and the [`TunnelDaemon`] lifted from the state (never `Arc<TunnelState>`) —
/// the daemon supplies the observed-runtime half of the snapshot the handler
/// renders.
pub(crate) struct TunnelSettingsReader<S: TunnelStore> {
    store: S,
    daemon: Arc<TunnelDaemon>,
}

impl<S: TunnelStore> TunnelSettingsReader<S> {
    /// Build the reader over a store handle + the daemon, both lifted from the
    /// state.
    pub(crate) fn new(store: S, daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsReader { store, daemon }
    }

    /// The current persisted settings — the gated store read.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store read fails.
    pub(crate) fn settings(&self) -> Result<TunnelSettings, TunnelError> {
        self.store.get_settings()
    }

    /// The live daemon, for the handler to fold the observed runtime into the
    /// wire snapshot. Acquired only after the scope gate, so it rides behind the
    /// same `TunnelSettings.r` check as the settings themselves.
    pub(crate) fn daemon(&self) -> &TunnelDaemon {
        &self.daemon
    }
}

/// Replace the singleton tunnel settings — `PUT /tunnel`. Distinct from
/// [`TunnelSettingsReader`] because replacing is a `TunnelSettings.u` capability;
/// a reader holding `Scoped<TunnelSettingsReader>` structurally cannot write.
/// Generic over the store port, holding the store + daemon handles lifted from
/// the state.
pub(crate) struct TunnelSettingsEditor<S: TunnelStore> {
    store: S,
    daemon: Arc<TunnelDaemon>,
}

impl<S: TunnelStore> TunnelSettingsEditor<S> {
    /// Build the editor over a store handle + the daemon, both lifted from the
    /// state.
    pub(crate) fn new(store: S, daemon: Arc<TunnelDaemon>) -> Self {
        TunnelSettingsEditor { store, daemon }
    }

    /// Compare-and-swap the settings under `expected_revision` — the gated store
    /// write. Returns the [`SettingsUpdateOutcome`] (applied or stale-revision
    /// conflict); the handler drives the supervisor via the daemon and renders
    /// the snapshot.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn replace(
        &self,
        expected_revision: i64,
        update: SettingsUpdate,
    ) -> Result<SettingsUpdateOutcome, TunnelError> {
        actions::replace_settings(&self.store, expected_revision, update)
    }

    /// The live daemon, for the handler to reconcile the supervisor, await
    /// verification, and fold the observed runtime into the wire snapshot.
    /// Acquired only after the scope gate, so it rides behind the same
    /// `TunnelSettings.u` check as the write.
    pub(crate) fn daemon(&self) -> &TunnelDaemon {
        &self.daemon
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RelaySettings;
    use crate::health::HealthProbe;
    use crate::test_support::{HoldUntilCancelRelayClient, StubProbe};

    /// A daemon handle for the store-focused capability tests. The capabilities
    /// only *read* the daemon (the handler drives it), so any idle daemon does.
    fn daemon() -> Arc<TunnelDaemon> {
        let probe: Arc<dyn HealthProbe> = Arc::new(StubProbe::passing());
        Arc::new(TunnelDaemon::new_test(
            Arc::new(HoldUntilCancelRelayClient),
            probe,
            "http://127.0.0.1:8080",
            8080,
        ))
    }

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    /// The reader's gated store read returns the persisted singleton — exercised
    /// against the real in-memory `SQLite` store (the same adapter the binding
    /// wires, so the store read path is covered end to end without a database
    /// file).
    #[tokio::test]
    async fn reader_settings_returns_the_persisted_snapshot() {
        let store = crate::db::SqliteTunnelStore::open_in_memory().expect("store");
        let reader = TunnelSettingsReader::new(store, daemon());
        let settings = reader.settings().expect("read");
        assert_eq!(settings.revision, 0);
        assert_eq!(settings.public_host, None);
        assert!(!settings.requested_running);
    }

    /// The editor's gated write applies under the matching revision and bumps it,
    /// then conflicts (leaving state untouched) under a stale revision — the
    /// compare-and-swap the `PUT` gate now fronts.
    #[tokio::test]
    async fn editor_replace_applies_then_conflicts_on_a_stale_revision() {
        let store = crate::db::SqliteTunnelStore::open_in_memory().expect("store");
        let editor = TunnelSettingsEditor::new(store, daemon());

        let applied = editor
            .replace(
                0,
                SettingsUpdate {
                    public_host: Some("dev1.example.com".into()),
                    requested_running: true,
                    relay_settings: Some(relay()),
                },
            )
            .expect("write");
        let SettingsUpdateOutcome::Applied(settings) = applied else {
            panic!("expected Applied, got {applied:?}");
        };
        assert_eq!(settings.revision, 1);
        assert_eq!(settings.public_host.as_deref(), Some("dev1.example.com"));

        // A second writer still on revision 0 loses the CAS.
        let conflict = editor
            .replace(
                0,
                SettingsUpdate {
                    public_host: Some("evil.example.com".into()),
                    requested_running: false,
                    relay_settings: None,
                },
            )
            .expect("write");
        let SettingsUpdateOutcome::Conflict(current) = conflict else {
            panic!("expected Conflict, got {conflict:?}");
        };
        assert_eq!(current.revision, 1, "current row returned");
        assert_eq!(
            current.public_host.as_deref(),
            Some("dev1.example.com"),
            "the losing write left the settings untouched",
        );
    }

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
    /// the scope functions textually keeps honest additions honest.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        const CAPABILITIES_SOURCE: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/domain/capabilities.rs"
        ));
        // Count the per-capability scope functions — the `pub(crate) fn
        // …_scopes() -> Vec<Scope>` definitions. Matching the whole `pub(crate)
        // fn` + signature on one line excludes both the public
        // `grantable_tunnel_scopes` aggregator (also `…_scopes`, but `pub fn`)
        // and this test's own needle literal (no `pub(crate) fn`), which a bare
        // substring count over this single file would otherwise fold in.
        // The two needles live on separate lines so this very filter closure —
        // included in the scanned source — never satisfies both on one line and
        // counts itself.
        let scope_fns = CAPABILITIES_SOURCE
            .lines()
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
