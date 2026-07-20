//! The read capability — [`AppsReader`], gated by `wildflower/Apps.r`
//! ([`apps_reader_scopes`](super::apps_reader_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
    SelfHostedAppConfiguration, SystemAppConfiguration,
};

/// Read the catalogue + per-kind detail — `wildflower/Apps.r`.
pub(crate) fn apps_reader_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::READ,
    )]
}

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
        match self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?
        {
            (registration, AppConfiguration::Cloud(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
    }

    /// A self-hosted app's editor detail, or `404` if no self-hosted app has the id.
    pub(crate) fn self_hosted(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        match self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?
        {
            (registration, AppConfiguration::SelfHosted(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
    }

    /// A system app's read-only detail, or `404` if no system app has the id.
    pub(crate) fn system(
        &self,
        id: &str,
    ) -> Result<(AppRegistration, SystemAppConfiguration), AppsError> {
        match self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?
        {
            (registration, AppConfiguration::System(config)) => Ok((registration, config)),
            _ => Err(AppsError::NotFound { id: id.to_owned() }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::actions::test_fake::{
        create_cloud, seeded_self_hosted, system, FakeAppsStore,
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
        // A per-kind read of the wrong kind is a 404 (the inlined find_app resolves
        // the runtime kind and the arm falls through).
        assert!(matches!(
            reader.cloud("sys-x"),
            Err(AppsError::NotFound { .. })
        ));
        // An unknown id is likewise a 404.
        assert!(matches!(
            reader.cloud("ghost"),
            Err(AppsError::NotFound { .. })
        ));
    }
}
