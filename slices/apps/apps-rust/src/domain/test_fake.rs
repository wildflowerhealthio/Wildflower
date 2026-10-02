//! The in-memory [`AppsStore`] fake shared by the scope-gated
//! [`capabilities`](crate::domain::capabilities) unit tests, plus the small data
//! builders they seed it with.
//! Modelling the real primitive semantics — `insert_app` reports a duplicate id as
//! [`AppInsertError::IdTaken`], `find_app` / `replace_app` report an absent id as
//! `None`, `delete_app` reports a miss as `false`, `replace_placements` reports a
//! non-permutation as `None` — it stores registrations with no diesel and no
//! database, so the capabilities' semantic mapping is exercised directly. The
//! `SQLite` adapter's own coverage lives in `crate::db`.

use std::cell::RefCell;

use crate::domain::{
    is_exact_registry_permutation, AppInsertError, AppRegistration, AppUrl, AppsError, AppsStore,
};

#[derive(Default)]
pub(crate) struct FakeAppsStore {
    pub(crate) apps: RefCell<Vec<AppRegistration>>,
}

impl FakeAppsStore {
    fn next_position(&self) -> i64 {
        self.apps
            .borrow()
            .iter()
            .map(|reg| reg.position)
            .max()
            .map_or(0, |m| m + 1)
    }

    fn id_taken(&self, id: &str) -> bool {
        self.apps.borrow().iter().any(|reg| reg.id == id)
    }
}

impl AppsStore for FakeAppsStore {
    fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
        let mut apps = self.apps.borrow().clone();
        apps.sort_by_key(|reg| reg.position);
        Ok(apps)
    }

    fn find_app(&self, id: &str) -> Result<Option<AppRegistration>, AppsError> {
        Ok(self.apps.borrow().iter().find(|reg| reg.id == id).cloned())
    }

    fn insert_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Result<AppRegistration, AppInsertError>, AppsError> {
        if self.id_taken(&registration.id) {
            return Ok(Err(AppInsertError::IdTaken));
        }
        // The store owns `position`; everything else is the caller's.
        let stored = AppRegistration {
            position: self.next_position(),
            ..registration.clone()
        };
        self.apps.borrow_mut().push(stored.clone());
        Ok(Ok(stored))
    }

    fn replace_app(
        &self,
        registration: &AppRegistration,
    ) -> Result<Option<AppRegistration>, AppsError> {
        let mut apps = self.apps.borrow_mut();
        let Some(stored) = apps.iter_mut().find(|reg| reg.id == registration.id) else {
            return Ok(None);
        };
        // Editable subset only — never placement / client_id / local_only.
        stored.name = registration.name.clone();
        stored.subtitle = registration.subtitle.clone();
        stored.url = registration.url.clone();
        stored.requires_tunnel = registration.requires_tunnel;
        Ok(Some(stored.clone()))
    }

    fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
        let mut apps = self.apps.borrow_mut();
        let before = apps.len();
        apps.retain(|reg| reg.id != id);
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
            apps.iter().map(|reg| reg.id.clone()).collect();
        let body: Vec<&str> = entries.iter().map(|(id, _)| id.as_str()).collect();
        if !is_exact_registry_permutation(&current, &body) {
            return Ok(None);
        }
        for (position, (id, on_homescreen)) in entries.iter().enumerate() {
            let new_position = i64::try_from(position).expect("home-screen length fits i64");
            if let Some(reg) = apps.iter_mut().find(|reg| reg.id == *id) {
                reg.position = new_position;
                reg.on_homescreen = *on_homescreen;
            }
        }
        apps.sort_by_key(|reg| reg.position);
        Ok(Some(apps.clone()))
    }
}

pub(crate) fn registration(id: &str) -> AppRegistration {
    AppRegistration {
        id: id.to_owned(),
        position: 0,
        on_homescreen: true,
        name: id.to_owned(),
        subtitle: None,
        url: "https://example.com/launch"
            .parse::<AppUrl>()
            .expect("a valid seed launch url"),
        local_only: false,
        client_id: None,
        requires_tunnel: false,
    }
}

/// Seed an app straight through the store port with a caller-chosen id (the
/// HTTP layer mints it in production) and default content — the registration the
/// capability tests build a store from.
pub(crate) fn create_app(store: &FakeAppsStore, id: &str) -> Result<AppRegistration, AppsError> {
    store.insert_app(&registration(id))?.map_err(|_| {
        AppsError::infrastructure("test seed app id already taken", format!("id={id}"))
    })
}
