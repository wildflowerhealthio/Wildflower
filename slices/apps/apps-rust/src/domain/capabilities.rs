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
use scopes_rust::{Grant, Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, CloudAppPayload};
use crate::domain::{
    AppConfiguration, AppKind, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
    CloudInsertError, SelfHostedAppConfiguration, SelfHostedAppConfigurationPayload,
    SelfHostedInstaller, SystemAppConfiguration,
};
use crate::id_utils::mint_app_id;
use crate::ports::AppLaunchScopes;

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

/// Launch a scoped app — the `wildflower/launch` umbrella. A **known** scope, so
/// (unlike `wildflower/Apps.*`) it is NOT covered by the `wildflower/*` resource
/// wildcard and must be granted explicitly. The per-app SMART check that a launch
/// additionally passes is data-dependent and lives on [`AppLauncher`], not here.
pub(crate) fn app_launcher_scopes() -> Vec<Scope> {
    vec![Scope::any_scoped_app_launch()]
}

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
        self.store.list_registrations()
    }

    /// A cloud app's editor detail, or `404` if no cloud app has the id (an
    /// unknown id, or one of another kind).
    pub(crate) fn cloud(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        match actions::get_app(&self.store, id)? {
            (registration, AppConfiguration::Cloud(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
    }

    /// A self-hosted app's editor detail, or `404` if no self-hosted app has the id.
    pub(crate) fn self_hosted(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        match actions::get_app(&self.store, id)? {
            (registration, AppConfiguration::SelfHosted(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
    }

    /// A system app's read-only detail, or `404` if no system app has the id.
    pub(crate) fn system(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SystemAppConfiguration), AppsError> {
        match actions::get_app(&self.store, id)? {
            (registration, AppConfiguration::System(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
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

    /// Create a cloud app: mint the id, validate the content, synthesize the
    /// `(registration, configuration)`, and insert. A [`CloudInsertError::IdTaken`]
    /// means the server-minted id was already taken (a vanishingly-unlikely 21-char
    /// collision), surfaced as a logged [`AppsError::Infrastructure`] rather than
    /// silently returning the existing row.
    pub(crate) fn cloud(
        &self,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        let id = mint_app_id();
        let (name, subtitle, url) =
            actions::validate_cloud_fields(payload.name, payload.subtitle, payload.url)?;
        let registration = AppRegistration {
            id,
            kind: AppKind::Cloud,
            // The store assigns the tail `position`; this is a placeholder.
            position: 0,
            on_homescreen: true,
            name,
            subtitle,
            local_only: false,
            client_id: None,
            requires_tunnel: payload.requires_tunnel,
        };
        let config = CloudAppConfiguration { url };
        self.store
            .insert_cloud_app(&registration, &config)?
            .map_err(|error| match error {
                CloudInsertError::IdTaken => {
                    tracing::error!("app id collision on {}", registration.id);
                    AppsError::infrastructure("insert_cloud_app id collision", "id already exists")
                }
            })
    }

    /// Install a self-hosted app from an uploaded `bundle`: derive the slug (id /
    /// subdomain) from `name`, stage the bundle, synthesize the pair, insert
    /// (reserving the host's own loopback port so an upload never binds over it),
    /// and start the listener — unwinding the staged files if the insert fails.
    pub(crate) async fn self_hosted(
        &self,
        name: String,
        subtitle: Option<String>,
        bundle: Bytes,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        // The slug is the name reduced to a DNS label; a name that slugs to
        // nothing is a `400 InvalidName` before anything is staged.
        let slug = actions::slugify(&name).ok_or_else(|| AppsError::InvalidName {
            message: "name must contain at least one letter or digit".to_owned(),
        })?;

        // Stage the bundle onto disk (extract + move into place) so a committed
        // row always points at present files.
        let staged = self.installer.stage(bundle).await?;

        // Synthesize the registration + create payload the store persists — the
        // slug is the id and subdomain, `position` is a placeholder the store
        // overrides, and an empty subtitle clears to `None`. The store owns `port`
        // and writes `seeded = false`.
        let registration = AppRegistration {
            id: slug.clone(),
            kind: AppKind::SelfHosted,
            position: 0,
            on_homescreen: true,
            name,
            subtitle: subtitle.filter(|s| !s.is_empty()),
            local_only: true,
            client_id: None,
            requires_tunnel: false,
        };
        let create = SelfHostedAppConfigurationPayload {
            content_folder: staged.content_folder,
            subdomain: slug,
            launch_path: staged.launch_path,
        };

        // Insert; unwind the just-staged files if the row can't be written.
        let (registration, config) =
            match self
                .store
                .insert_self_hosted_app(&registration, &create, &self.reserved_ports)
            {
                Ok(pair) => pair,
                Err(error) => {
                    self.installer.discard(&create.content_folder);
                    return Err(error);
                }
            };

        // The row is committed and the files are in place — bring the listener online.
        self.installer
            .start_listener(&registration.id, &config)
            .await?;
        Ok((registration, config))
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

    /// Replace a cloud app's content; a non-cloud id is `404`. Resolves the kind
    /// before validating any field (a bad url on a non-cloud id is still a `404`),
    /// then overlays the edited fields onto the current registration — the store
    /// writes only the editable subset, so placement stays untouched.
    pub(crate) fn cloud(
        &self,
        id: &str,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        let (current, configuration) = actions::get_app(&self.store, id)?;
        if !matches!(configuration, AppConfiguration::Cloud(_)) {
            return Err(AppsError::NotFound { id: id.to_owned() });
        }
        let (name, subtitle, url) =
            actions::validate_cloud_fields(payload.name, payload.subtitle, payload.url)?;
        let edited = AppRegistration {
            name,
            subtitle,
            requires_tunnel: payload.requires_tunnel,
            ..current
        };
        self.store
            .replace_cloud_app(&edited, &CloudAppConfiguration { url })?
            .ok_or_else(|| {
                AppsError::infrastructure(
                    "cloud app vanished between find and replace",
                    format!("id={id}"),
                )
            })
    }

    /// Replace a self-hosted app's launch path; a non-self-hosted id is `404`, a
    /// seeded app `409`. Overlays the new `launch_path` onto the current
    /// configuration and hands the store the pair.
    pub(crate) fn self_hosted(
        &self,
        id: &str,
        launch_path: Option<String>,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        let (current_registration, configuration) = actions::get_app(&self.store, id)?;
        let current_config = match configuration {
            AppConfiguration::SelfHosted(config) if config.seeded => {
                // A migration-seeded app (patient-browser) is read-only, same 409
                // as delete.
                return Err(AppsError::NotEditable { id: id.to_owned() });
            }
            AppConfiguration::SelfHosted(config) => config,
            _ => return Err(AppsError::NotFound { id: id.to_owned() }),
        };
        let launch_path = actions::validate_launch_path(launch_path)?;
        // The store writes only `launch_path`; carry the immutable `content_folder`
        // / `subdomain` from the current config to fill the shared payload.
        let payload = SelfHostedAppConfigurationPayload {
            content_folder: current_config.content_folder,
            subdomain: current_config.subdomain,
            launch_path,
        };
        self.store
            .replace_self_hosted_app(&current_registration, &payload)?
            .ok_or_else(|| {
                AppsError::infrastructure(
                    "self-hosted app vanished between find and replace",
                    format!("id={id}"),
                )
            })
    }

    /// Atomically reorder + enable/disable the whole registry; a non-permutation
    /// body is `400 InvalidHomeScreen`.
    pub(crate) fn home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Vec<AppRegistration>, AppsError> {
        self.store
            .replace_placements(entries)?
            .ok_or_else(|| AppsError::InvalidHomeScreen {
                message: "home-screen body must list every app exactly once".to_owned(),
            })
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
    /// system / seeded self-hosted app `409`. The handler answers `204 No Content`,
    /// so the removed pair is discarded.
    ///
    /// A self-hosted app's teardown **brackets** the store delete: stop the listener
    /// *before* the row (and its id) is freed — so a same-slug reinstall can't
    /// interleave and get its fresh listener torn down — then discard the serving
    /// folder *after* the row is gone. A cloud / system app has no host-side state,
    /// so the installer is untouched. A `false` from the store means the row
    /// vanished between the read and the delete (it was just read under the same
    /// store, so it can't legitimately have gone) — a logged `Infrastructure` 500,
    /// never a misleading 404.
    pub(crate) fn delete(&self, id: &str) -> Result<(), AppsError> {
        let (_registration, configuration) = actions::get_app(&self.store, id)?;
        if !configuration.is_removable() {
            // A system app, or a migration-seeded self-hosted app (patient-browser).
            return Err(AppsError::NotEditable { id: id.to_owned() });
        }

        let self_hosted = configuration.as_self_hosted();
        if self_hosted.is_some() {
            // Stop the listener while the row still holds the id.
            self.installer.stop_listener(id);
        }
        let did_delete = self.store.delete_app(id)?;
        if !did_delete {
            return Err(AppsError::infrastructure(
                "row vanished between find_app and delete_app",
                format!("id={id}"),
            ));
        }
        if let Some(config) = self_hosted {
            // Remove the serving folder now the row is gone.
            self.installer.discard(&config.content_folder);
        }
        Ok(())
    }
}

/// Launch authorization — the **hybrid** capability behind `GET` / `POST
/// /apps/{id}`. Unlike the fixed-scope admin capabilities above, its binding
/// implements [`Capability`](scope_capabilities_rust::Capability) directly: the
/// static umbrella `wildflower/launch` (from [`app_launcher_scopes`]) is enforced
/// by the [`Scoped`](scope_capabilities_rust::Scoped) extractor, **and** the
/// builder stores the caller's [`Grant`] for the data-dependent per-app SMART
/// check ([`missing_launch_scopes`](AppLauncher::missing_launch_scopes)).
///
/// Doesn't touch the store — the launch handler resolves the app through the
/// (state-held) store as exempted launch glue; this capability owns only the
/// authorization: the caller's grant + the [`AppLaunchScopes`] port that resolves
/// a SMART app's required scopes.
pub(crate) struct AppLauncher {
    granted: Grant,
    launch_scopes: Arc<dyn AppLaunchScopes>,
}

impl AppLauncher {
    pub(crate) fn new(granted: Grant, launch_scopes: Arc<dyn AppLaunchScopes>) -> Self {
        Self {
            granted,
            launch_scopes,
        }
    }

    /// The scopes the caller lacks to launch `registration` — empty means
    /// authorized. A **non-SMART** app (no `client_id`) needs only the umbrella
    /// scope the extractor already enforced, so it short-circuits to no missing
    /// scopes; a **SMART** app additionally requires the caller's grant to cover
    /// its OAuth client's requested scopes (resolved through the
    /// [`AppLaunchScopes`] port). The handler renders a non-empty result as a
    /// `403 InsufficientScope` (JSON for the loopback/SPA arm, a browser-appropriate
    /// response for a forwarded navigation).
    pub(crate) fn missing_launch_scopes(
        &self,
        registration: &AppRegistration,
    ) -> Result<Vec<Scope>, AppsError> {
        if !registration.is_smart() {
            return Ok(Vec::new());
        }
        let required = self.launch_scopes.required_scopes(registration)?;
        Ok(self.granted.missing_scopes(&required))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::actions::test_fake::{
        create_cloud, registration, seeded_self_hosted, system, FakeAppsStore, FakeInstaller,
    };
    use crate::domain::AppKind;

    /// A fake [`AppLaunchScopes`] returning a fixed required-scope set. The
    /// capability only consults it for a SMART app, so a non-SMART test never
    /// reaches here.
    struct FakeLaunchScopes {
        required: Vec<Scope>,
    }

    impl AppLaunchScopes for FakeLaunchScopes {
        fn required_scopes(
            &self,
            _registration: &AppRegistration,
        ) -> Result<Vec<Scope>, AppsError> {
            Ok(self.required.clone())
        }
    }

    fn launcher(granted: &str, required: &[&str]) -> AppLauncher {
        AppLauncher::new(
            Grant::parse(granted.split_whitespace()),
            Arc::new(FakeLaunchScopes {
                required: required.iter().map(|s| Scope::from(*s)).collect(),
            }),
        )
    }

    fn smart_registration() -> AppRegistration {
        let mut reg = registration("smart-app", AppKind::Cloud);
        reg.client_id = Some("client-1".to_owned());
        reg
    }

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
        // A per-kind read of the wrong kind is a 404 (resolved through get_app).
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

    /// A cloud replace resolves the kind before validating any field: an unknown
    /// id and a wrong-kind id are both `404`, and the wrong-kind `404` wins even
    /// over a bad url (the field is never reached).
    #[test]
    fn editor_cloud_replace_unknown_or_wrong_kind_is_not_found() {
        let store = FakeAppsStore::default();
        system(&store, "sys-x");
        let editor = AppsEditor::new(store);
        assert!(matches!(
            editor.cloud(
                "ghost",
                CloudAppPayload {
                    name: "n".to_owned(),
                    subtitle: None,
                    url: "https://x.example".to_owned(),
                    requires_tunnel: false,
                },
            ),
            Err(AppsError::NotFound { .. })
        ));
        // A system id is not a cloud app — the wrong-kind 404 wins over the bad url.
        assert!(matches!(
            editor.cloud(
                "sys-x",
                CloudAppPayload {
                    name: "n".to_owned(),
                    subtitle: None,
                    url: "javascript:alert(1)".to_owned(),
                    requires_tunnel: false,
                },
            ),
            Err(AppsError::NotFound { .. })
        ));
    }

    /// A self-hosted replace gates before editing: a seeded app is `409`, a
    /// non-self-hosted id is `404`; an editable app rewrites its `launch_path` and
    /// still rejects a non-origin-relative one as `400 InvalidUrl`.
    #[test]
    fn editor_self_hosted_replace_gates_and_edits() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "seeded", true);
        seeded_self_hosted(&store, "editable", false);
        create_cloud(&store, "cloud-x").expect("seed cloud");
        let editor = AppsEditor::new(store);

        assert!(matches!(
            editor.self_hosted("seeded", Some("/launch.html".to_owned())),
            Err(AppsError::NotEditable { .. })
        ));
        assert!(matches!(
            editor.self_hosted("cloud-x", Some("/launch.html".to_owned())),
            Err(AppsError::NotFound { .. })
        ));
        let (_registration, config) = editor
            .self_hosted("editable", Some("/launch.html".to_owned()))
            .expect("replace");
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        assert!(matches!(
            editor.self_hosted("editable", Some("https://evil.example/x".to_owned())),
            Err(AppsError::InvalidUrl { .. })
        ));
    }

    /// A self-hosted install derives the slug id from the name, normalizes an empty
    /// subtitle to `None`, records the staged folder, and starts the listener —
    /// discarding nothing on success.
    #[tokio::test]
    // See `creator_creates_cloud_apps`: the fake installer's `Arc` is non-Send/Sync
    // only in test; the production binding uses the `Send + Sync` service.
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_installs_a_self_hosted_app_and_starts_its_listener() {
        let installer = Arc::new(FakeInstaller::new("mint-abc"));
        let creator =
            AppsCreator::new(FakeAppsStore::default(), Arc::clone(&installer), Vec::new());
        let (registration, config) = creator
            .self_hosted(
                "My App".to_owned(),
                Some(String::new()),
                bytes::Bytes::new(),
            )
            .await
            .expect("install");
        assert_eq!(registration.id, "my-app", "the id is the slugified name");
        assert_eq!(registration.kind, AppKind::SelfHosted);
        assert_eq!(
            registration.subtitle, None,
            "an empty subtitle clears to None"
        );
        assert_eq!(
            config.content_folder, "mint-abc",
            "the staged folder verbatim"
        );
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        assert_eq!(
            installer.started.borrow().as_slice(),
            ["my-app"],
            "the listener is started for the installed id",
        );
        assert!(
            installer.discarded.borrow().is_empty(),
            "nothing is discarded on success",
        );
    }

    /// A name that slugs to nothing is a `400 InvalidName` before anything is staged
    /// or started.
    #[tokio::test]
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_self_hosted_rejects_a_nameless_slug_before_staging() {
        let installer = Arc::new(FakeInstaller::new("mint"));
        let creator =
            AppsCreator::new(FakeAppsStore::default(), Arc::clone(&installer), Vec::new());
        let result = creator
            .self_hosted("!!!".to_owned(), None, bytes::Bytes::new())
            .await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert!(
            installer.started.borrow().is_empty() && installer.discarded.borrow().is_empty(),
            "a name that slugs to nothing never stages or starts",
        );
    }

    /// When the store rejects the insert (a taken slug → `400 InvalidName`), the
    /// just-staged bundle is unwound (`discard`) and the listener is never started.
    #[tokio::test]
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_self_hosted_discards_the_bundle_when_the_insert_fails() {
        let store = FakeAppsStore::default();
        // A pre-existing app owns the slug, so the store insert reports a taken id.
        seeded_self_hosted(&store, "my-app", false);
        let installer = Arc::new(FakeInstaller::new("mint-xyz"));
        let creator = AppsCreator::new(store, Arc::clone(&installer), Vec::new());
        let result = creator
            .self_hosted("My App".to_owned(), None, bytes::Bytes::new())
            .await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert_eq!(
            installer.discarded.borrow().as_slice(),
            ["mint-xyz"],
            "the staged folder is unwound when the row can't be written",
        );
        assert!(
            installer.started.borrow().is_empty(),
            "a failed insert never starts the listener",
        );
    }

    /// A self-hosted delete brackets the store delete: the listener is stopped
    /// (while the row still holds the id) and the serving folder discarded (by
    /// `content_folder`) once the row is gone; a cloud delete drives no teardown.
    #[test]
    #[allow(clippy::arc_with_non_send_sync)]
    fn deleter_self_hosted_teardown_brackets_the_store_delete() {
        let store = FakeAppsStore::default();
        // A non-seeded (removable) self-hosted app; `seeded_self_hosted` sets its
        // `content_folder` to the id.
        seeded_self_hosted(&store, "my-app", false);
        create_cloud(&store, "cloud-x").expect("seed cloud");
        let installer = Arc::new(FakeInstaller::new("unused"));
        let deleter = AppsDeleter::new(store, Arc::clone(&installer));

        deleter.delete("my-app").expect("delete self-hosted");
        assert_eq!(
            installer.stopped.borrow().as_slice(),
            ["my-app"],
            "the listener is stopped",
        );
        assert_eq!(
            installer.discarded.borrow().as_slice(),
            ["my-app"],
            "the serving folder is discarded by content_folder",
        );

        deleter.delete("cloud-x").expect("delete cloud");
        assert_eq!(
            installer.stopped.borrow().len(),
            1,
            "a cloud delete drives no self-hosted teardown",
        );
        assert_eq!(installer.discarded.borrow().len(), 1);
    }

    #[test]
    fn launcher_smart_app_requires_covering_its_client_scopes() {
        let reg = smart_registration();
        // A grant covering the SMART client's scopes → nothing missing.
        assert!(launcher(
            "patient/Observation.rs openid",
            &["patient/Observation.r", "openid"]
        )
        .missing_launch_scopes(&reg)
        .expect("resolve")
        .is_empty());

        // A grant missing one → it comes back (in the order the port declared).
        let missing = launcher("openid", &["patient/Observation.r", "openid"])
            .missing_launch_scopes(&reg)
            .expect("resolve");
        assert_eq!(
            scopes_rust::render_scopes(&missing),
            vec!["patient/Observation.r".to_owned()],
        );
    }

    #[test]
    fn launcher_non_smart_app_needs_only_the_umbrella() {
        // A non-SMART app (no `client_id`) short-circuits to no missing scopes even
        // with an empty grant — the SMART port is never consulted (so the required
        // set below is irrelevant).
        let reg = registration("system-app", AppKind::System);
        assert!(reg.client_id.is_none());
        assert!(launcher("", &["patient/Observation.r"])
            .missing_launch_scopes(&reg)
            .expect("resolve")
            .is_empty());
    }

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
    /// functions by their crate-visible `app…`-prefixed signature (the four
    /// `apps_*_scopes` + `app_launcher_scopes`; the grantable fn is `pub`, and no
    /// capability method is `app…`-named) keeps an honest addition honest — and,
    /// unlike matching a call body, survives rustfmt's line wrapping.
    #[test]
    fn every_capability_scope_fn_is_registered_in_the_grantable_vocabulary() {
        const SOURCE: &str = include_str!("capabilities.rs");
        // Assembled from fragments so this needle's own literal doesn't appear
        // contiguously in the counted source (only the scope-fn signatures do).
        let needle = concat!("pub(crate) fn ", "app");
        let scope_fns = SOURCE.matches(needle).count();
        // One `declared` entry per capability scope function. Update BOTH when
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
