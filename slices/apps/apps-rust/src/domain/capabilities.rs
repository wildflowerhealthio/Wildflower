//! Scope-gated capabilities for the `/apps` **admin** surface — the apps slice's
//! copy of the default-safe authorization pattern (the generic machinery lives in
//! [`scope_capabilities_rust`]; the pattern originated on gatekeeper's `/access`
//! surface, recipe in `docs/Authorization/Scope-Gated Endpoints How-To.md`). They
//! live in `domain/` beside the [`AppsStore`] port they operate through — never
//! importing `crate::http` — so a forgotten permission check can't compile a
//! data-touching handler, and the whole surface stays unit-testable against the
//! in-memory `FakeAppsStore`.
//!
//! Each capability is the **fixed-scope** flavour: one static
//! `wildflower/Apps.<perm>` scope gates the whole capability, checked by the
//! [`Scoped`] extractor before `build` runs. So the structs here are generic over
//! the store port (and, where they touch the self-hosted installer, over that port
//! too) and hold their dependencies **lifted from the state** — never an
//! `Arc<AppsState>` they reach into. The concrete
//! [`FixedScopeCapability`] bindings that name the `SqliteAppsStore` adapter and
//! build a capability from the router state live beside the state in
//! [`crate::state`], so `domain/` stays store-agnostic.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! capability's `*_scopes()` function — read by **both** its binding and
//! [`grantable_apps_scopes`], so *enforced* and *grantable* can't drift.
//!
//! (The cross-cutting launch capability is a separate, hybrid concern — see the
//! launch handler.)

use std::sync::Arc;

use bytes::Bytes;
use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, CloudAppPayload, SelfHostedAppPayload};
use crate::domain::{
    AppRegistration, AppsError, AppsStore, CloudAppConfiguration, SelfHostedAppConfiguration,
    SelfHostedInstaller, SystemAppConfiguration,
};
use crate::id_utils::mint_app_id;

use std::collections::HashSet;

// ---- (resource, permission) → required scope, one source of truth ----------

/// Read the catalogue + per-kind detail — `wildflower/Apps.r`.
pub(crate) fn apps_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::READ,
    )]
}

/// Register a new cloud / self-hosted app — `wildflower/Apps.c`.
pub(crate) fn apps_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::CREATE,
    )]
}

/// Edit an app's content / home-screen placement — `wildflower/Apps.u`.
pub(crate) fn apps_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::UPDATE,
    )]
}

/// Remove an app — `wildflower/Apps.d`.
pub(crate) fn apps_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::DELETE,
    )]
}

/// The apps scopes the admin surface enforces, deduplicated in declaration order —
/// the registry mapping *capability → required scope*. Because it reads the very
/// `*_scopes()` functions the capability bindings enforce, what a token can be
/// *granted* and what it is *checked against* come from one source. The intended
/// grantable vocabulary for the consent surfaces (mirrors gatekeeper's
/// `grantable_admin_scopes`); nothing consumes it yet — the tests below pin it.
#[must_use]
pub fn grantable_apps_scopes() -> Vec<Scope> {
    let declared = [
        apps_reader_scopes(),
        apps_creator_scopes(),
        apps_editor_scopes(),
        apps_deleter_scopes(),
    ];
    let mut seen = HashSet::new();
    declared
        .into_iter()
        .flatten()
        .filter(|scope| seen.insert(scope.clone()))
        .collect()
}

// ---- capabilities ----------------------------------------------------------

/// Read access to the catalogue — `GET /apps` (the uniform registry), and the
/// per-kind detail reads (`GET /cloud-apps/{id}`, `/self-hosted-apps/{id}`,
/// `/system-apps/{id}`). Gated by `wildflower/Apps.r`. Generic over the store port
/// so the read logic is exercised against the in-memory fake.
pub(crate) struct AppsReader<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsReader<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// The full registry in display order (`GET /apps`).
    pub(crate) fn list(&self) -> Result<Vec<AppRegistration>, AppsError> {
        actions::list_registrations(&self.store)
    }

    /// A cloud app's editor detail, or `404` if no cloud app has the id.
    pub(crate) fn cloud(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        actions::get_cloud_app(&self.store, id)
    }

    /// A self-hosted app's editor detail, or `404` if no self-hosted app has the id.
    pub(crate) fn self_hosted(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        actions::get_self_hosted_app(&self.store, id)
    }

    /// A system app's read-only detail, or `404` if no system app has the id.
    pub(crate) fn system(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SystemAppConfiguration), AppsError> {
        actions::get_system_app(&self.store, id)
    }
}

/// Registration of new apps — `POST /cloud-apps` and `POST /self-hosted-apps`.
/// Gated by `wildflower/Apps.c`. Holds the store, the self-hosted installer, and
/// the loopback ports reserved against a new upload — all lifted from the state.
pub(crate) struct AppsCreator<S: AppsStore, I: SelfHostedInstaller> {
    store: S,
    installer: Arc<I>,
    reserved_ports: Vec<u16>,
}

impl<S: AppsStore, I: SelfHostedInstaller> AppsCreator<S, I> {
    pub(crate) fn new(store: S, installer: Arc<I>, reserved_ports: Vec<u16>) -> Self {
        Self {
            store,
            installer,
            reserved_ports,
        }
    }

    /// Create a cloud app: mint the id, validate, insert, and read the pair back
    /// in-transaction.
    pub(crate) fn cloud(
        &self,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        actions::create_cloud_app(&self.store, mint_app_id, payload)
    }

    /// Install a self-hosted app from an uploaded `bundle`: stage → insert →
    /// start the listener (cleaning up on failure), reserving the host's own
    /// loopback port so an upload never binds over it.
    pub(crate) async fn self_hosted(
        &self,
        name: String,
        subtitle: Option<String>,
        bundle: Bytes,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        let payload = SelfHostedAppPayload {
            name,
            subtitle,
            bundle,
            reserved_ports: self.reserved_ports.clone(),
        };
        actions::install_self_hosted_app(&self.store, self.installer.as_ref(), payload).await
    }
}

/// Content + home-screen edits — `PUT /cloud-apps/{id}`, `PUT /self-hosted-apps/{id}`,
/// `PUT /home-screen`. Gated by `wildflower/Apps.u`. Separate from
/// [`AppsCreator`] / [`AppsDeleter`] so an edit handler structurally can't create
/// or delete.
pub(crate) struct AppsEditor<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsEditor<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Replace a cloud app's content; a non-cloud id is `404`.
    pub(crate) fn cloud(
        &self,
        id: &str,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        actions::replace_cloud_app(&self.store, id, payload)
    }

    /// Replace a self-hosted app's launch path; a non-self-hosted id is `404`, a
    /// seeded app `409`.
    pub(crate) fn self_hosted(
        &self,
        id: &str,
        launch_path: Option<String>,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        actions::replace_self_hosted_app(&self.store, id, launch_path)
    }

    /// Atomically reorder + enable/disable the whole registry; a non-permutation
    /// body is `400 InvalidHomeScreen`.
    pub(crate) fn home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Vec<AppRegistration>, AppsError> {
        actions::replace_placements(&self.store, entries)
    }
}

/// Removal — `DELETE /apps/{id}` (any kind, resolved from the registration). Gated
/// by `wildflower/Apps.d`. Holds the store + the self-hosted installer (a
/// self-hosted delete stops the listener before the row is freed and discards the
/// folder after).
pub(crate) struct AppsDeleter<S: AppsStore, I: SelfHostedInstaller> {
    store: S,
    installer: Arc<I>,
}

impl<S: AppsStore, I: SelfHostedInstaller> AppsDeleter<S, I> {
    pub(crate) fn new(store: S, installer: Arc<I>) -> Self {
        Self { store, installer }
    }

    /// Remove a cloud app or an uploaded self-hosted app; unknown id `404`, a
    /// system / seeded self-hosted app `409`. The deleted pair the action returns
    /// is discarded — the handler answers `204 No Content`.
    pub(crate) fn delete(&self, id: &str) -> Result<(), AppsError> {
        actions::delete_app(&self.store, self.installer.as_ref(), id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::actions::test_fake::{
        create_cloud, seeded_self_hosted, system, FakeAppsStore, FakeInstaller,
    };
    use crate::domain::AppKind;

    fn reader(seed: impl FnOnce(&FakeAppsStore)) -> AppsReader<FakeAppsStore> {
        let store = FakeAppsStore::default();
        seed(&store);
        AppsReader::new(store)
    }

    #[test]
    fn reader_lists_and_reads_per_kind_through_the_store() {
        let reader = reader(|store| {
            create_cloud(store, "cloud-x").expect("seed cloud");
            seeded_self_hosted(store, "sh-x", true);
            system(store, "sys-x");
        });
        assert_eq!(reader.list().expect("list").len(), 3);
        assert_eq!(reader.cloud("cloud-x").expect("cloud").0.id, "cloud-x");
        assert_eq!(
            reader.self_hosted("sh-x").expect("self-hosted").0.kind,
            AppKind::SelfHosted
        );
        assert_eq!(
            reader.system("sys-x").expect("system").0.kind,
            AppKind::System
        );
        // A per-kind read of the wrong kind is a 404 (delegates to the action).
        assert!(matches!(
            reader.cloud("sys-x"),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    // The single-threaded fake installer holds `RefCell`s (not `Sync`); the real
    // `SelfHostedAppsService` the binding uses is `Send + Sync`, so the `Arc` is
    // only non-Send/Sync in this test.
    #[allow(clippy::arc_with_non_send_sync)]
    fn creator_creates_cloud_apps() {
        let creator = AppsCreator::new(
            FakeAppsStore::default(),
            Arc::new(FakeInstaller::new("folder")),
            Vec::new(),
        );
        let (registration, config) = creator
            .cloud(CloudAppPayload {
                name: "My App".to_owned(),
                subtitle: None,
                url: "https://example.com/launch".to_owned(),
                requires_tunnel: false,
            })
            .expect("create");
        assert_eq!(registration.kind, AppKind::Cloud);
        assert!(!registration.id.is_empty());
        assert!(config.url.to_string().contains("example.com"));
    }

    #[test]
    fn editor_replaces_content_and_reorders() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "cloud-x").expect("seed cloud");
        let editor = AppsEditor::new(store);
        let (registration, _config) = editor
            .cloud(
                "cloud-x",
                CloudAppPayload {
                    name: "Renamed".to_owned(),
                    subtitle: None,
                    url: "https://example.com/x".to_owned(),
                    requires_tunnel: false,
                },
            )
            .expect("replace");
        assert_eq!(registration.name, "Renamed");
        // A full-registry permutation reorders; a partial body is InvalidHomeScreen.
        assert!(matches!(
            editor.home_screen(&[("nope".to_owned(), true)]),
            Err(AppsError::InvalidHomeScreen { .. })
        ));
    }

    #[test]
    // See `creator_creates_cloud_apps`: the fake installer's `Arc` is non-Send/Sync
    // only in test; the production binding uses the `Send + Sync` service.
    #[allow(clippy::arc_with_non_send_sync)]
    fn deleter_removes_and_gates_on_removability() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "cloud-x").expect("seed cloud");
        seeded_self_hosted(&store, "seeded-x", true);
        let deleter = AppsDeleter::new(store, Arc::new(FakeInstaller::new("folder")));
        deleter.delete("cloud-x").expect("delete cloud");
        // A seeded self-hosted app is protected (409); an unknown id is 404.
        assert!(matches!(
            deleter.delete("seeded-x"),
            Err(AppsError::NotEditable { .. })
        ));
        assert!(matches!(
            deleter.delete("nope"),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn grantable_apps_scopes_are_the_expected_wildflower_scopes() {
        let rendered = scopes_rust::render_scopes(&grantable_apps_scopes());
        assert_eq!(
            rendered,
            vec![
                "wildflower/Apps.r".to_owned(),
                "wildflower/Apps.c".to_owned(),
                "wildflower/Apps.u".to_owned(),
                "wildflower/Apps.d".to_owned(),
            ],
        );
    }

    #[test]
    fn every_required_scope_is_a_known_wildflower_resource_not_unknown() {
        // A typo in a required-scope spelling would fall to `Scope::Unknown`, which
        // an owner's `wildflower/*.cruds` can't cover — locking the owner out.
        for scope in grantable_apps_scopes() {
            assert!(
                matches!(scope, Scope::WildflowerResource(_)),
                "required scope {scope} is not a wildflower resource scope",
            );
        }
    }

    /// Registry-completeness guard: every admin capability maps to exactly one
    /// `wildflower/Apps.<perm>` scope, and [`grantable_apps_scopes`]'s `declared`
    /// array must list all of them. Counting the resource-scope constructor
    /// textually (each capability's `*_scopes()` calls it exactly once, and the
    /// grantable fn / tests never do — tests spell scopes via `Scope::from`) keeps
    /// an honest addition honest: a capability added without registering enforces a
    /// scope the grantable vocabulary never offers — a silent lock-out.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        const SOURCE: &str = include_str!("capabilities.rs");
        // Assembled from fragments so this needle's own literal doesn't appear
        // contiguously in the counted source (each capability's `*_scopes()` fn is
        // the only place the full call appears).
        let needle = concat!(
            "Scope::wildflower(",
            "WildflowerResource::Apps, Permission::"
        );
        let scope_mappings = SOURCE.matches(needle).count();
        // One `declared` entry per capability scope function. Update BOTH when
        // adding a capability: its `*_scopes()` fn and the `declared` array.
        let declared_entries = 4;
        assert_eq!(
            scope_mappings, declared_entries,
            "found {scope_mappings} Apps scope mappings but grantable_apps_scopes() declares \
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
    /// state, while its scope check rides the `Scoped<AppLauncher>` umbrella +
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
