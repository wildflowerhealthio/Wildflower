//! The in-memory [`AppsStore`] fake shared by every action file's unit tests, plus
//! the small data builders they seed it with. Modelling the real primitive
//! semantics — `insert_cloud_app` reports a duplicate id as
//! [`CloudInsertError::IdTaken`], `find_app` / `replace_*` report an absent id as
//! `None`, `delete_app` reports a miss as `false`, `replace_placements` reports a
//! non-permutation as `None` — it stores `(registration, configuration)` pairs with
//! no diesel and no database, so the actions' semantic mapping is exercised directly.
//! The `SQLite` adapter's own coverage lives in `crate::db`.

use std::cell::RefCell;

use super::cloud_apps::{create_cloud_app, CloudAppPayload};
use crate::domain::{
    is_exact_registry_permutation, AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError,
    AppsStore, CloudAppConfiguration, CloudInsertError, SelfHostedAppConfiguration,
    SelfHostedAppConfigurationPayload, SelfHostedInstaller, StagedBundle, SystemAppConfiguration,
};

#[derive(Default)]
pub(super) struct FakeAppsStore {
    pub(super) apps: RefCell<Vec<(AppRegistration, AppConfiguration)>>,
}

impl FakeAppsStore {
    pub(super) fn seed(&self, registration: AppRegistration, configuration: AppConfiguration) {
        self.apps.borrow_mut().push((registration, configuration));
    }

    fn next_position(&self) -> i64 {
        self.apps
            .borrow()
            .iter()
            .map(|(reg, _)| reg.position)
            .max()
            .map_or(0, |m| m + 1)
    }

    fn id_taken(&self, id: &str) -> bool {
        self.apps.borrow().iter().any(|(reg, _)| reg.id == id)
    }
}

impl AppsStore for FakeAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut apps = self.apps.borrow().clone();
        apps.sort_by_key(|(reg, _)| reg.position);
        Ok(apps.iter().map(|(reg, _)| reg.clone()).collect())
    }

    fn find_app(&self, id: &str) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
        Ok(self
            .apps
            .borrow()
            .iter()
            .find(|(reg, _)| reg.id == id)
            .cloned())
    }

    fn list_self_hosted_apps(
        &self,
    ) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        Ok(self
            .apps
            .borrow()
            .iter()
            .filter_map(|(reg, configuration)| match configuration {
                AppConfiguration::SelfHosted(config) => Some((reg.clone(), config.clone())),
                _ => None,
            })
            .collect())
    }

    fn insert_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError> {
        if self.id_taken(&registration.id) {
            return Ok(Err(CloudInsertError::IdTaken));
        }
        // The store owns `position`; everything else is the caller's.
        let stored = AppRegistration {
            position: self.next_position(),
            ..registration.clone()
        };
        self.seed(stored.clone(), AppConfiguration::Cloud(config.clone()));
        Ok(Ok((stored, config.clone())))
    }

    fn insert_self_hosted_app(
        &self,
        registration: &AppRegistration,
        payload: &SelfHostedAppConfigurationPayload,
        reserved_ports: &[u16],
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        // The id is used verbatim; a clash is a client-fixable `400 InvalidName` —
        // mirrors the real store.
        if self.id_taken(&registration.id) {
            return Err(AppsError::InvalidName {
                message: "an app with this name already exists".to_owned(),
            });
        }
        // The store owns `position` (tail) and `port` (lowest-free, skipping the
        // reserved set) and writes `seeded = false`; the payload supplies the rest.
        let mut port = 8082 + u16::try_from(self.apps.borrow().len()).unwrap_or(0);
        while reserved_ports.contains(&port) {
            port += 1;
        }
        let stored_reg = AppRegistration {
            position: self.next_position(),
            ..registration.clone()
        };
        let stored_config = SelfHostedAppConfiguration {
            port,
            content_folder: payload.content_folder.clone(),
            subdomain: payload.subdomain.clone(),
            seeded: false,
            launch_path: payload.launch_path.clone(),
        };
        self.seed(
            stored_reg.clone(),
            AppConfiguration::SelfHosted(stored_config.clone()),
        );
        Ok((stored_reg, stored_config))
    }

    fn replace_cloud_app(
        &self,
        registration: &AppRegistration,
        config: &CloudAppConfiguration,
    ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
        let mut apps = self.apps.borrow_mut();
        let Some((stored_reg, configuration)) =
            apps.iter_mut().find(|(reg, _)| reg.id == registration.id)
        else {
            return Ok(None);
        };
        let AppConfiguration::Cloud(stored_config) = configuration else {
            return Ok(None);
        };
        // Editable subset only — never placement / kind / client_id / local_only.
        stored_reg.name = registration.name.clone();
        stored_reg.subtitle = registration.subtitle.clone();
        stored_reg.requires_tunnel = registration.requires_tunnel;
        stored_config.url = config.url.clone();
        Ok(Some((stored_reg.clone(), stored_config.clone())))
    }

    fn replace_self_hosted_app(
        &self,
        registration: &AppRegistration,
        payload: &SelfHostedAppConfigurationPayload,
    ) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
        let mut apps = self.apps.borrow_mut();
        let Some((stored_reg, configuration)) =
            apps.iter_mut().find(|(reg, _)| reg.id == registration.id)
        else {
            return Ok(None);
        };
        let AppConfiguration::SelfHosted(stored_config) = configuration else {
            return Ok(None);
        };
        // Only `launch_path` is written; the payload's immutable `content_folder` /
        // `subdomain` are ignored, mirroring the real store.
        stored_reg.name = registration.name.clone();
        stored_reg.subtitle = registration.subtitle.clone();
        stored_config.launch_path = payload.launch_path.clone();
        Ok(Some((stored_reg.clone(), stored_config.clone())))
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        let mut apps = self.apps.borrow_mut();
        let before = apps.len();
        apps.retain(|(reg, _)| reg.id != id);
        Ok(apps.len() != before)
    }

    fn replace_placements(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Option<Vec<AppRegistration>>, AppsError> {
        let mut apps = self.apps.borrow_mut();
        // Reuse the real permutation rule (rather than re-deriving it) so this oracle
        // can't drift from the production check.
        let current: std::collections::HashSet<String> =
            apps.iter().map(|(reg, _)| reg.id.clone()).collect();
        let body: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        if !is_exact_registry_permutation(&current, &body) {
            return Ok(None);
        }
        for (position, (id, on_homescreen)) in entries.iter().enumerate() {
            let new_position = i64::try_from(position).expect("home-screen length fits i64");
            if let Some((reg, _)) = apps.iter_mut().find(|(reg, _)| reg.id == *id) {
                reg.position = new_position;
                reg.on_homescreen = *on_homescreen;
            }
        }
        apps.sort_by_key(|(reg, _)| reg.position);
        Ok(Some(apps.iter().map(|(reg, _)| reg.clone()).collect()))
    }
}

pub(super) fn registration(id: &str, kind: AppKind) -> AppRegistration {
    AppRegistration {
        id: id.to_owned(),
        kind,
        position: 0,
        on_homescreen: true,
        name: id.to_owned(),
        subtitle: None,
        local_only: kind != AppKind::Cloud,
        client_id: None,
        requires_tunnel: false,
    }
}

/// Create a cloud app through the action with a caller-chosen id (the HTTP layer
/// mints it in production) and default content.
pub(super) fn create_cloud(
    store: &FakeAppsStore,
    id: &str,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    create_cloud_app(
        store,
        || id.to_owned(),
        CloudAppPayload {
            name: id.to_owned(),
            subtitle: None,
            url: "https://example.com/launch".to_owned(),
            requires_tunnel: false,
        },
    )
}

pub(super) fn seeded_self_hosted(store: &FakeAppsStore, id: &str, seeded: bool) {
    let mut reg = registration(id, AppKind::SelfHosted);
    reg.position = store.next_position();
    store.seed(
        reg,
        AppConfiguration::SelfHosted(SelfHostedAppConfiguration {
            port: 8081,
            content_folder: id.to_owned(),
            subdomain: id.to_owned(),
            seeded,
            launch_path: None,
        }),
    );
}

pub(super) fn system(store: &FakeAppsStore, id: &str) {
    let mut reg = registration(id, AppKind::System);
    reg.position = store.next_position();
    store.seed(
        reg,
        AppConfiguration::System(SystemAppConfiguration {
            url: AppUrl::OriginRelative("/docs".to_owned()),
        }),
    );
}

/// The in-memory [`SelfHostedInstaller`] fake shared by the install and delete action
/// tests. It stages a canned bundle and records the `discard` / `start_listener` /
/// `stop_listener` calls it's driven with, so a test can assert both *which* platform
/// work an action drove and (via the recorded order) that a delete stopped before it
/// discarded.
pub(super) struct FakeInstaller {
    staged: StagedBundle,
    pub(super) discarded: RefCell<Vec<String>>,
    pub(super) started: RefCell<Vec<String>>,
    pub(super) stopped: RefCell<Vec<String>>,
}

impl FakeInstaller {
    pub(super) fn new(content_folder: &str) -> Self {
        Self {
            staged: StagedBundle {
                content_folder: content_folder.to_owned(),
                launch_path: Some("/launch.html".to_owned()),
            },
            discarded: RefCell::new(Vec::new()),
            started: RefCell::new(Vec::new()),
            stopped: RefCell::new(Vec::new()),
        }
    }
}

impl SelfHostedInstaller for FakeInstaller {
    async fn stage(&self, _bundle: bytes::Bytes) -> Result<StagedBundle, AppsError> {
        Ok(self.staged.clone())
    }

    fn discard(&self, content_folder: &str) {
        self.discarded.borrow_mut().push(content_folder.to_owned());
    }

    async fn start_listener(
        &self,
        id: &str,
        _config: &SelfHostedAppConfiguration,
    ) -> Result<(), AppsError> {
        self.started.borrow_mut().push(id.to_owned());
        Ok(())
    }

    fn stop_listener(&self, id: &str) {
        self.stopped.borrow_mut().push(id.to_owned());
    }
}
