//! The cross-kind read that resolves an app of **any** kind by id — the
//! `(registration, configuration)` the uniform `/apps/{id}` surface (launch, delete)
//! and the per-kind editors dispatch on, resolving the runtime kind rather than a
//! per-kind path.

use crate::domain::{AppConfiguration, AppRegistration, AppsError, AppsStore};

/// A single whole app by id as its `(registration, configuration)` pair, or
/// [`AppsError::NotFound`] when absent — the launch dispatch, the per-kind editor
/// reads, and the delete removability check.
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

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, FakeAppsStore};
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
}
