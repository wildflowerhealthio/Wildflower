//! The read capability — [`AppsReader`], gated by `wildflower/Apps.r`
//! ([`apps_reader_scopes`](super::apps_reader_scopes)).

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::{AppRegistration, AppsError, AppsStore};

/// Read the catalogue + an app's detail — `wildflower/Apps.r`.
pub(crate) fn apps_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::READ,
    )]
}

/// Read access to the catalogue — `GET /apps` (the registry) and `GET /apps/{id}`
/// (one app). Gated by `wildflower/Apps.r`. Generic over the store port so the
/// read logic is exercised against the in-memory fake.
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

    /// One app, or `404` if no app has the id.
    pub(crate) fn get(&self, id: &str) -> Result<AppRegistration, AppsError> {
        self.store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{create_app, FakeAppsStore};

    #[test]
    fn reader_lists_and_reads_through_the_store() {
        let store = FakeAppsStore::default();
        create_app(&store, "app-x").expect("seed app");
        create_app(&store, "app-y").expect("seed app");
        let reader = AppsReader::new(store);
        assert_eq!(reader.list().expect("list").len(), 2);
        assert_eq!(reader.get("app-x").expect("app").id, "app-x");
        assert!(matches!(
            reader.get("ghost"),
            Err(AppsError::NotFound { .. })
        ));
    }
}
