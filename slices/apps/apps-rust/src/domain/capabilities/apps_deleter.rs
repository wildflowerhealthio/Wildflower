//! The delete capability — [`AppsDeleter`], gated by `wildflower/Apps.d`
//! ([`apps_deleter_scopes`](super::apps_deleter_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{AppsError, AppsStore};

/// Remove an app — `wildflower/Apps.d`.
pub(crate) fn apps_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::DELETE,
    )]
}

/// Removal — `DELETE /apps/{id}` (any kind, resolved from the registration). Gated
/// by `wildflower/Apps.d`. Holds the store, lifted from the state.
pub(crate) struct AppsDeleter<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsDeleter<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Remove a cloud app; unknown id `404`, a system app `409`. The handler
    /// answers `204 No Content`, so the removed pair is discarded.
    ///
    /// A `false` from the store means the row vanished between the read and the
    /// delete (it was just read under the same store, so it can't legitimately have
    /// gone) — a logged `Infrastructure` 500, never a misleading 404.
    pub(crate) fn delete_by_id(&self, id: &str) -> Result<(), AppsError> {
        let (_registration, configuration) = self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?;
        if !configuration.is_removable() {
            return Err(AppsError::NotEditable { id: id.to_owned() });
        }

        let did_delete = self.store.delete_app(id)?;
        if !did_delete {
            return Err(AppsError::infrastructure(
                "row vanished between find_app and delete_app",
                format!("id={id}"),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{create_cloud, system, FakeAppsStore};

    #[test]
    fn deleter_removes_and_gates_on_removability() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "cloud-x").expect("seed cloud");
        system(&store, "sys-x");
        let deleter = AppsDeleter::new(store);
        deleter.delete_by_id("cloud-x").expect("delete cloud");
        // A system app is protected (409); an unknown id is 404.
        assert!(matches!(
            deleter.delete_by_id("sys-x"),
            Err(AppsError::NotEditable { .. })
        ));
        assert!(matches!(
            deleter.delete_by_id("nope"),
            Err(AppsError::NotFound { .. })
        ));
    }
}
