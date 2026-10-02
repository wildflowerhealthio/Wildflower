//! The in-memory [`AppsStore`] fake shared by the scope-gated
//! [`capabilities`](crate::domain::capabilities) unit tests, plus the small data
//! builders they seed it with.
//! Modelling the real primitive semantics — `insert_cloud_app` reports a duplicate id
//! as [`CloudInsertError::IdTaken`], `find_app` / `replace_*` report an absent id as
//! `None`, `delete_app` reports a miss as `false`, `replace_placements` reports a
//! non-permutation as `None` — it stores `(registration, configuration)` pairs with
//! no diesel and no database, so the capabilities' semantic mapping is exercised
//! directly. The `SQLite` adapter's own coverage lives in `crate::db`.

use std::cell::RefCell;

use crate::domain::{
    is_exact_registry_permutation, AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError,
    AppsStore, CloudAppConfiguration, CloudInsertError, SystemAppConfiguration,
};

#[derive(Default)]
pub(crate) struct FakeAppsStore {
    pub(crate) apps: RefCell<Vec<(AppRegistration, AppConfiguration)>>,
}

impl FakeAppsStore {
    pub(crate) fn seed(&self, registration: AppRegistration, configuration: AppConfiguration) {
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

pub(crate) fn registration(id: &str, kind: AppKind) -> AppRegistration {
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

/// Seed a cloud app straight through the store port with a caller-chosen id (the
/// HTTP layer mints it in production) and default content — the pair the capability
/// tests build a store from.
pub(crate) fn create_cloud(
    store: &FakeAppsStore,
    id: &str,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    let config = CloudAppConfiguration {
        url: "https://example.com/launch"
            .parse::<AppUrl>()
            .expect("a valid seed launch url"),
    };
    store
        .insert_cloud_app(&registration(id, AppKind::Cloud), &config)?
        .map_err(|_| {
            AppsError::infrastructure("test seed cloud id already taken", format!("id={id}"))
        })
}

pub(crate) fn system(store: &FakeAppsStore, id: &str) {
    let mut reg = registration(id, AppKind::System);
    reg.position = store.next_position();
    store.seed(
        reg,
        AppConfiguration::System(SystemAppConfiguration {
            url: AppUrl::OriginRelative("/docs".to_owned()),
        }),
    );
}
