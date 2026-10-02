//! The create capability — [`AppsCreator`], gated by `wildflower/Apps.c`
//! ([`apps_creator_scopes`](super::apps_creator_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, AppPayload};
use crate::domain::{AppInsertError, AppRegistration, AppsError, AppsStore};
use crate::id_utils::mint_app_id;

/// Register a new app — `wildflower/Apps.c`.
pub(crate) fn apps_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::CREATE,
    )]
}

/// Registration of new apps — `POST /apps`. Gated by `wildflower/Apps.c`.
/// Holds the store, lifted from the state.
pub(crate) struct AppsCreator<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsCreator<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Create an app: mint the id, validate the content, synthesize the
    /// registration, and insert. An [`AppInsertError::IdTaken`] means the
    /// server-minted id was already taken (a vanishingly-unlikely 21-char
    /// collision), surfaced as a logged [`AppsError::Infrastructure`] rather than
    /// silently returning the existing row.
    pub(crate) fn create_app(&self, payload: AppPayload) -> Result<AppRegistration, AppsError> {
        let id = mint_app_id();
        let (name, subtitle, url) =
            actions::validate_app_fields(payload.name, payload.subtitle, payload.url)?;
        let registration = AppRegistration {
            id,
            // The store assigns the tail `position`; this is a placeholder.
            position: 0,
            on_homescreen: true,
            name,
            subtitle,
            url,
            local_only: false,
            client_id: None,
            requires_tunnel: payload.requires_tunnel,
        };
        self.store
            .insert_app(&registration)?
            .map_err(|error| match error {
                AppInsertError::IdTaken => {
                    tracing::error!("app id collision on {}", registration.id);
                    AppsError::infrastructure("insert_app id collision", "id already exists")
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::FakeAppsStore;

    #[test]
    fn creator_creates_apps() {
        let creator = AppsCreator::new(FakeAppsStore::default());
        let registration = creator
            .create_app(AppPayload {
                name: "My App".to_owned(),
                subtitle: None,
                url: "https://example.com/launch".to_owned(),
                requires_tunnel: false,
            })
            .expect("create");
        assert!(!registration.id.is_empty());
        assert!(registration.url.to_string().contains("example.com"));
    }
}
