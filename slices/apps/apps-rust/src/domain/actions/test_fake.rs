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
    AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError, AppsStore,
    CloudAppConfiguration, CloudInsertError, SelfHostedAppConfiguration, SystemAppConfiguration,
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
        config: &SelfHostedAppConfiguration,
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
        // reserved set); every other field on the caller's pair is used as given.
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
            ..config.clone()
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
        config: &SelfHostedAppConfiguration,
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
        stored_reg.name = registration.name.clone();
        stored_reg.subtitle = registration.subtitle.clone();
        stored_config.launch_path = config.launch_path.clone();
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
        let current: std::collections::HashSet<String> =
            apps.iter().map(|(reg, _)| reg.id.clone()).collect();
        let body: std::collections::HashSet<&str> =
            entries.iter().map(|(id, _)| id.as_str()).collect();
        let is_permutation = entries.len() == current.len()
            && body.len() == entries.len()
            && body.iter().all(|id| current.contains(*id));
        if !is_permutation {
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
        id.to_owned(),
        CloudAppPayload {
            name: id.to_owned(),
            subtitle: None,
            url: "https://example.com/launch".to_owned(),
            requires_tunnel: false,
        },
    )
}

/// A caller-built self-hosted upload pair (id = subdomain = `slug`, non-seeded,
/// `position` / `port` placeholders the store overrides) — the shape the HTTP layer
/// hands the store.
pub(super) fn new_upload(slug: &str) -> (AppRegistration, SelfHostedAppConfiguration) {
    (
        registration(slug, AppKind::SelfHosted),
        SelfHostedAppConfiguration {
            port: 0,
            content_folder: format!("{slug}-folder"),
            subdomain: slug.to_owned(),
            seeded: false,
            launch_path: None,
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
