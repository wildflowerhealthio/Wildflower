//! The delete capability — [`AppsDeleter`], gated by `wildflower/Apps.d`
//! ([`apps_deleter_scopes`](super::apps_deleter_scopes)).

use wildflowerhealthio_scopes::{Permission, Scope, WildflowerResource};

use crate::domain::{AppsError, AppsStore};

/// Remove an app — `wildflower/Apps.d`.
pub(crate) fn apps_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::DELETE,
    )]
}

/// Removal — `DELETE /apps/{id}`. Gated by `wildflower/Apps.d`. Holds the store,
/// lifted from the state.
pub(crate) struct AppsDeleter<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsDeleter<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Remove an app; an unknown id is `404`. The handler answers
    /// `204 No Content`.
    pub(crate) fn delete_by_id(&self, id: &str) -> Result<(), AppsError> {
        if self.store.delete_app(id)? {
            Ok(())
        } else {
            Err(AppsError::NotFound { id: id.to_owned() })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{create_app, FakeAppsStore};

    #[test]
    fn deleter_removes_and_reports_an_unknown_id() {
        let store = FakeAppsStore::default();
        create_app(&store, "app-x").expect("seed app");
        let deleter = AppsDeleter::new(store);
        deleter.delete_by_id("app-x").expect("delete app");
        assert!(matches!(
            deleter.delete_by_id("app-x"),
            Err(AppsError::NotFound { .. })
        ));
        assert!(matches!(
            deleter.delete_by_id("nope"),
            Err(AppsError::NotFound { .. })
        ));
    }
}
