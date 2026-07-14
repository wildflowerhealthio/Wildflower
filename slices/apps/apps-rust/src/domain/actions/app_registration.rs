//! Registration-wide actions — the ones that read or rewrite the shared
//! `app_registrations` rows across every kind: the uniform `GET /apps` catalogue and
//! the atomic `PUT /home-screen` placement rewrite.

use crate::domain::{AppRegistration, AppsError, AppsStore};

/// The `GET /apps` catalogue — every app's registration, in display order.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] if the store read fails.
pub(crate) fn list_registrations(
    store: &impl AppsStore,
) -> Result<Vec<AppRegistration>, AppsError> {
    store.list_registrations()
}

/// Atomically reorder + show/hide the whole homescreen. The body must list every
/// registry app exactly once (its order is the new display order); a
/// non-permutation is [`InvalidHomeScreen`](AppsError::InvalidHomeScreen). Returns
/// the resulting registry in its new order.
///
/// # Errors
///
/// [`AppsError::InvalidHomeScreen`] when `entries` isn't an exact permutation of
/// the live registry; [`AppsError::Infrastructure`] on a store failure.
pub(crate) fn replace_placements(
    store: &impl AppsStore,
    entries: &[(String, bool)],
) -> Result<Vec<AppRegistration>, AppsError> {
    store
        .replace_placements(entries)?
        .ok_or_else(|| AppsError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, FakeAppsStore};
    use super::*;

    #[test]
    fn replace_placements_permutation_returns_the_reordered_registry() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "a").expect("insert");
        create_cloud(&store, "b").expect("insert");
        let updated =
            replace_placements(&store, &[("b".to_owned(), true), ("a".to_owned(), false)])
                .expect("permutation");
        let ids: Vec<&str> = updated.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"], "the registry comes back reordered");
        assert!(
            !store.find_app("a").unwrap().unwrap().0.on_homescreen,
            "a hidden"
        );
    }

    #[test]
    fn replace_placements_non_permutation_is_invalid_home_screen() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "a").expect("insert");
        create_cloud(&store, "b").expect("insert");
        // A subset isn't an exact permutation.
        assert!(matches!(
            replace_placements(&store, &[("a".to_owned(), true)]),
            Err(AppsError::InvalidHomeScreen { .. })
        ));
    }
}
