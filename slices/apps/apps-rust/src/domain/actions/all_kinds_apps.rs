//! Actions that resolve an app of **any** kind by id — the reads and the delete that
//! the uniform `/apps/{id}` surface (launch, delete) drives, dispatching on the
//! runtime-resolved kind rather than a per-kind path.

use crate::domain::{AppConfiguration, AppRegistration, AppsError, AppsStore};

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

/// Delete a removable app, returning the removed `(registration, configuration)` so
/// the caller can run any kind-specific teardown (a self-hosted app's listener +
/// files). The **removability policy lives here**, not in the HTTP handler: an
/// unknown id is [`NotFound`](AppsError::NotFound); a non-removable app (a system
/// app, or a *seeded* self-hosted app — [`AppConfiguration::is_removable`]) is
/// [`NotEditable`](AppsError::NotEditable) `409`. A `false` from the store means the
/// row vanished between the read and the delete — it was just read under the same
/// store, so it can't legitimately have gone; surface it as a logged
/// [`Infrastructure`](AppsError::Infrastructure) 500, never a misleading 404.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::NotEditable`] / [`AppsError::Infrastructure`].
pub(crate) fn delete_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, AppConfiguration), AppsError> {
    let (registration, configuration) = get_app(store, id)?;
    if !configuration.is_removable() {
        // A system app, or a migration-seeded self-hosted app (patient-browser).
        return Err(AppsError::NotEditable { id: id.to_owned() });
    }
    let did_delete = store.delete_app(id)?;
    if !did_delete {
        return Err(AppsError::infrastructure(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ));
    }
    Ok((registration, configuration))
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, seeded_self_hosted, system, FakeAppsStore};
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
    fn delete_app_removes_a_removable_app_then_reports_a_miss_as_infrastructure() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        let (registration, _configuration) = delete_app(&store, "app-x").expect("delete succeeds");
        assert_eq!(registration.id, "app-x");
        assert!(matches!(
            get_app(&store, "app-x"),
            Err(AppsError::NotFound { .. })
        ));
        // A second delete resolves the id first — the row is gone, so it's a 404,
        // never a vanished-row 500.
        assert!(matches!(
            delete_app(&store, "app-x"),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn delete_app_refuses_a_system_or_seeded_self_hosted_app() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(
            matches!(
                delete_app(&store, "api-docs"),
                Err(AppsError::NotEditable { .. })
            ),
            "a system app is not removable",
        );
        assert!(
            matches!(
                delete_app(&store, "patient-browser"),
                Err(AppsError::NotEditable { .. }),
            ),
            "a seeded self-hosted app is not removable",
        );
    }
}
