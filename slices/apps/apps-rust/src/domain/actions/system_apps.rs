//! System-app actions — the read-only `GET /system-apps/{id}` detail. System apps
//! are seeded and can't be created, edited, or deleted, so there is no create /
//! replace here.

use super::all_kinds_apps::get_app;
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, SystemAppConfiguration,
};

/// The system pair for `GET /system-apps/{id}` — [`AppsError::NotFound`] when no
/// *system* app has this id.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_system_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, SystemAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::System(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, system, FakeAppsStore};
    use super::*;

    #[test]
    fn get_system_app_returns_a_system_app_and_rejects_other_kinds() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        create_cloud(&store, "app-x").expect("insert");
        assert_eq!(
            get_system_app(&store, "api-docs").expect("found").0.id,
            "api-docs",
        );
        assert!(
            matches!(
                get_system_app(&store, "app-x"),
                Err(AppsError::NotFound { .. })
            ),
            "a cloud id is not a system app — 404",
        );
    }
}
