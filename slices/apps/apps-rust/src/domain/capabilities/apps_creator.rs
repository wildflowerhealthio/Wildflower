//! The create capability — [`AppsCreator`], gated by `wildflower/Apps.c`
//! ([`apps_creator_scopes`](super::apps_creator_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, CloudAppPayload};
use crate::domain::{
    AppKind, AppRegistration, AppsError, AppsStore, CloudAppConfiguration, CloudInsertError,
};
use crate::id_utils::mint_app_id;

/// Register a new cloud app — `wildflower/Apps.c`.
pub(crate) fn apps_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::CREATE,
    )]
}

/// Registration of new apps — `POST /cloud-apps`. Gated by `wildflower/Apps.c`.
/// Holds the store, lifted from the state.
pub(crate) struct AppsCreator<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsCreator<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Create a cloud app: mint the id, validate the content, synthesize the
    /// `(registration, configuration)`, and insert. A [`CloudInsertError::IdTaken`]
    /// means the server-minted id was already taken (a vanishingly-unlikely 21-char
    /// collision), surfaced as a logged [`AppsError::Infrastructure`] rather than
    /// silently returning the existing row.
    pub(crate) fn create_cloud_app(
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeAppsStore;

    #[test]
    fn creator_creates_cloud_apps() {
        let creator = AppsCreator::new(FakeAppsStore::default());
        let (registration, config) = creator
            .create_cloud_app(CloudAppPayload {
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
}
