//! Actions that resolve an app of **any** kind by id — the reads and the delete that
//! the uniform `/apps/{id}` surface (launch, delete) drives, dispatching on the
//! runtime-resolved kind rather than a per-kind path.

use crate::domain::{AppConfiguration, AppRegistration, AppsError, AppsStore, SelfHostedInstaller};

/// A single whole app by id as its `(registration, configuration)` pair, or
/// [`AppsError::NotFound`] when absent — the launch dispatch and the delete
/// removability check.
///
/// # Errors
///
/// [`AppsError::NotFound`] when no app has this id; [`AppsError::Infrastructure`]
/// if the store read fails.
pub(crate) fn get_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, AppConfiguration), AppsError> {
    store
        .find_app(id)?
        .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })
}

/// Delete a removable app, driving the whole self-hosted host-side teardown through
/// the [`SelfHostedInstaller`] port so the HTTP handler stays a thin caller. Returns
/// the removed `(registration, configuration)`.
///
/// The **removability policy lives here**: an unknown id is
/// [`NotFound`](AppsError::NotFound); a non-removable app (a system app, or a *seeded*
/// self-hosted app — [`AppConfiguration::is_removable`]) is
/// [`NotEditable`](AppsError::NotEditable) `409`, so a protected app is never torn
/// down. A `false` from the store means the row vanished between the read and the
/// delete — it was just read under the same store, so it can't legitimately have gone;
/// surface it as a logged [`Infrastructure`](AppsError::Infrastructure) 500, never a
/// misleading 404.
///
/// A self-hosted app's teardown **brackets** the store delete: stop the listener
/// *before* the row (and its id) is freed — so a same-slug reinstall can't interleave
/// between the stop and the delete and get its fresh listener torn down — then remove
/// the serving folder *after* the row is gone (harmless if it lingers: it 404s until a
/// reinstall overwrites it). A cloud / system app has no host-side state, so the
/// installer is untouched.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::NotEditable`] / [`AppsError::Infrastructure`].
pub(crate) fn delete_app(
    store: &impl AppsStore,
    installer: &impl SelfHostedInstaller,
    id: &str,
) -> Result<(AppRegistration, AppConfiguration), AppsError> {
    let (registration, configuration) = get_app(store, id)?;
    if !configuration.is_removable() {
        // A system app, or a migration-seeded self-hosted app (patient-browser).
        return Err(AppsError::NotEditable { id: id.to_owned() });
    }

    let self_hosted = configuration.as_self_hosted();
    if self_hosted.is_some() {
        // Stop the listener while the row still holds the id.
        installer.stop_listener(id);
    }
    let did_delete = store.delete_app(id)?;
    if !did_delete {
        return Err(AppsError::infrastructure(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ));
    }
    if let Some(config) = self_hosted {
        // Remove the serving folder now the row is gone.
        installer.discard(&config.content_folder);
    }
    Ok((registration, configuration))
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{
        create_cloud, seeded_self_hosted, system, FakeAppsStore, FakeInstaller,
    };
    use super::*;

    #[test]
    fn get_app_maps_absent_to_not_found_and_present_to_the_app() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            get_app(&store, "ghost"),
            Err(AppsError::NotFound { .. })
        ));
        create_cloud(&store, "app-x").expect("insert");
        assert_eq!(get_app(&store, "app-x").expect("found").0.id, "app-x");
    }

    #[test]
    fn delete_app_removes_a_cloud_app_then_reports_a_miss_and_drives_no_teardown() {
        let store = FakeAppsStore::default();
        let installer = FakeInstaller::new("unused");
        create_cloud(&store, "app-x").expect("insert");
        let (registration, _configuration) =
            delete_app(&store, &installer, "app-x").expect("delete succeeds");
        assert_eq!(registration.id, "app-x");
        assert!(matches!(
            get_app(&store, "app-x"),
            Err(AppsError::NotFound { .. })
        ));
        // A second delete resolves the id first — the row is gone, so it's a 404,
        // never a vanished-row 500.
        assert!(matches!(
            delete_app(&store, &installer, "app-x"),
            Err(AppsError::NotFound { .. })
        ));
        assert!(
            installer.stopped.borrow().is_empty() && installer.discarded.borrow().is_empty(),
            "a cloud delete drives no self-hosted teardown",
        );
    }

    #[test]
    fn delete_app_refuses_a_system_or_seeded_self_hosted_app_without_teardown() {
        let store = FakeAppsStore::default();
        let installer = FakeInstaller::new("unused");
        system(&store, "api-docs");
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(
            matches!(
                delete_app(&store, &installer, "api-docs"),
                Err(AppsError::NotEditable { .. })
            ),
            "a system app is not removable",
        );
        assert!(
            matches!(
                delete_app(&store, &installer, "patient-browser"),
                Err(AppsError::NotEditable { .. }),
            ),
            "a seeded self-hosted app is not removable",
        );
        assert!(
            installer.stopped.borrow().is_empty(),
            "a protected app's listener is never stopped — the gate precedes teardown",
        );
    }

    /// A self-hosted delete drives the installer teardown: the listener is stopped and
    /// the serving folder discarded (by `content_folder`), and the row ends up gone.
    #[test]
    fn delete_app_of_a_self_hosted_app_drives_the_installer_teardown() {
        let store = FakeAppsStore::default();
        let installer = FakeInstaller::new("unused");
        // A non-seeded (removable) self-hosted app; `seeded_self_hosted` sets its
        // `content_folder` to the id.
        seeded_self_hosted(&store, "my-app", false);
        let (registration, _configuration) =
            delete_app(&store, &installer, "my-app").expect("delete succeeds");
        assert_eq!(registration.id, "my-app");
        assert!(
            store.find_app("my-app").unwrap().is_none(),
            "the row is gone once delete completes",
        );
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
    }
}
