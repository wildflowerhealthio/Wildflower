//! The [`AppsDeleter`] capability — the `wildflower/Apps.d` door to removing an app
//! (`DELETE /apps/{id}`, any kind). Holds its `*_scopes()` mapping (read by both
//! its binding and [`grantable_apps_scopes`](super::grantable_apps_scopes) so
//! enforced and grantable can't drift) and its store-focused tests.

use std::sync::Arc;

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions;
use crate::domain::{AppsError, AppsStore, SelfHostedInstaller};

/// Remove an app — `wildflower/Apps.d`. Shared by the capability's
/// `FixedScopeCapability` binding and
/// [`grantable_apps_scopes`](super::grantable_apps_scopes) so enforced and
/// grantable can't drift.
pub(crate) fn apps_deleter_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::DELETE,
    )]
}

/// Removal — `DELETE /apps/{id}` (any kind, resolved from the registration). Gated
/// by `wildflower/Apps.d`. Holds the store + the self-hosted installer (a
/// self-hosted delete stops the listener before the row is freed and discards the
/// folder after).
pub(crate) struct AppsDeleter<S: AppsStore, I: SelfHostedInstaller> {
    store: S,
    installer: Arc<I>,
}

impl<S: AppsStore, I: SelfHostedInstaller> AppsDeleter<S, I> {
    pub(crate) fn new(store: S, installer: Arc<I>) -> Self {
        Self { store, installer }
    }

    /// Remove a cloud app or an uploaded self-hosted app; unknown id `404`, a
    /// system / seeded self-hosted app `409`. The handler answers `204 No Content`,
    /// so the removed pair is discarded.
    ///
    /// A self-hosted app's teardown **brackets** the store delete: stop the listener
    /// *before* the row (and its id) is freed — so a same-slug reinstall can't
    /// interleave and get its fresh listener torn down — then discard the serving
    /// folder *after* the row is gone. A cloud / system app has no host-side state,
    /// so the installer is untouched. A `false` from the store means the row
    /// vanished between the read and the delete (it was just read under the same
    /// store, so it can't legitimately have gone) — a logged `Infrastructure` 500,
    /// never a misleading 404.
    pub(crate) fn delete(&self, id: &str) -> Result<(), AppsError> {
        let (_registration, configuration) = actions::get_app(&self.store, id)?;
        if !configuration.is_removable() {
            // A system app, or a migration-seeded self-hosted app (patient-browser).
            return Err(AppsError::NotEditable { id: id.to_owned() });
        }

        let self_hosted = configuration.as_self_hosted();
        if self_hosted.is_some() {
            // Stop the listener while the row still holds the id.
            self.installer.stop_listener(id);
        }
        let did_delete = self.store.delete_app(id)?;
        if !did_delete {
            return Err(AppsError::infrastructure(
                "row vanished between find_app and delete_app",
                format!("id={id}"),
            ));
        }
        if let Some(config) = self_hosted {
            // Remove the serving folder now the row is gone.
            self.installer.discard(&config.content_folder);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::actions::test_fake::{
        create_cloud, seeded_self_hosted, FakeAppsStore, FakeInstaller,
    };

    #[test]
    // See `AppsCreator`'s tests: the fake installer's `Arc` is non-Send/Sync only in
    // test; the production binding uses the `Send + Sync` service.
    #[allow(clippy::arc_with_non_send_sync)]
    fn deleter_removes_and_gates_on_removability() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "cloud-x").expect("seed cloud");
        seeded_self_hosted(&store, "seeded-x", true);
        let deleter = AppsDeleter::new(store, Arc::new(FakeInstaller::new("folder")));
        deleter.delete("cloud-x").expect("delete cloud");
        // A seeded self-hosted app is protected (409); an unknown id is 404.
        assert!(matches!(
            deleter.delete("seeded-x"),
            Err(AppsError::NotEditable { .. })
        ));
        assert!(matches!(
            deleter.delete("nope"),
            Err(AppsError::NotFound { .. })
        ));
    }

    /// A self-hosted delete brackets the store delete: the listener is stopped
    /// (while the row still holds the id) and the serving folder discarded (by
    /// `content_folder`) once the row is gone; a cloud delete drives no teardown.
    #[test]
    #[allow(clippy::arc_with_non_send_sync)]
    fn deleter_self_hosted_teardown_brackets_the_store_delete() {
        let store = FakeAppsStore::default();
        // A non-seeded (removable) self-hosted app; `seeded_self_hosted` sets its
        // `content_folder` to the id.
        seeded_self_hosted(&store, "my-app", false);
        create_cloud(&store, "cloud-x").expect("seed cloud");
        let installer = Arc::new(FakeInstaller::new("unused"));
        let deleter = AppsDeleter::new(store, Arc::clone(&installer));

        deleter.delete("my-app").expect("delete self-hosted");
        assert_eq!(
            installer.stopped.borrow().as_slice(),
            ["my-app"],
            "the listener is stopped",
        );
        assert_eq!(
            installer.discarded.borrow().as_slice(),
            ["my-app"],
            "the serving folder is discarded by content_folder",
        );

        deleter.delete("cloud-x").expect("delete cloud");
        assert_eq!(
            installer.stopped.borrow().len(),
            1,
            "a cloud delete drives no self-hosted teardown",
        );
        assert_eq!(installer.discarded.borrow().len(), 1);
    }
}
