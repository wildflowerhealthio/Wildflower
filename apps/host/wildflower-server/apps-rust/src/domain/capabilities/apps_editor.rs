//! The edit capability — [`AppsEditor`], gated by `wildflower/Apps.u`
//! ([`apps_editor_scopes`](super::apps_editor_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, AppPayload};
use crate::domain::{AppRegistration, AppsError, AppsStore};

/// Edit an app's content / home-screen placement — `wildflower/Apps.u`.
pub(crate) fn apps_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::UPDATE,
    )]
}

/// Content + home-screen edits — `PUT /apps/{id}`, `PUT /home-screen`. Gated by
/// `wildflower/Apps.u`. Separate from [`AppsCreator`](super::AppsCreator) /
/// [`AppsDeleter`](super::AppsDeleter) so an edit handler structurally can't create
/// or delete.
pub(crate) struct AppsEditor<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsEditor<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Replace an app's content; an unknown id is `404`. Resolves the app before
    /// validating any field (a bad url on an unknown id is still a `404`), then
    /// overlays the edited fields onto the current registration — the store writes
    /// only the editable subset, so placement stays untouched.
    pub(crate) fn update_app(
        &self,
        id: &str,
        payload: AppPayload,
    ) -> Result<AppRegistration, AppsError> {
        let current = self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?;
        let (name, subtitle, url) =
            actions::validate_app_fields(payload.name, payload.subtitle, payload.url)?;
        let edited = AppRegistration {
            name,
            subtitle,
            url,
            requires_tunnel: payload.requires_tunnel,
            ..current
        };
        self.store.replace_app(&edited)?.ok_or_else(|| {
            AppsError::infrastructure("app vanished between find and replace", format!("id={id}"))
        })
    }

    /// Atomically reorder + enable/disable the whole registry; a non-permutation
    /// body is `400 InvalidHomeScreen`.
    pub(crate) fn update_home_screen(
        &self,
        entries: &[(String, bool)],
    ) -> Result<Vec<AppRegistration>, AppsError> {
        self.store
            .replace_placements(entries)?
            .ok_or_else(|| AppsError::InvalidHomeScreen {
                message: "home-screen body must list every app exactly once".to_owned(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::{create_app, FakeAppsStore};

    #[test]
    fn editor_replaces_content_and_reorders() {
        let store = FakeAppsStore::default();
        create_app(&store, "app-x").expect("seed app");
        let editor = AppsEditor::new(store);
        let registration = editor
            .update_app(
                "app-x",
                AppPayload {
                    name: "Renamed".to_owned(),
                    subtitle: None,
                    url: "https://example.com/x".to_owned(),
                    requires_tunnel: false,
                },
            )
            .expect("replace");
        assert_eq!(registration.name, "Renamed");
        assert_eq!(registration.url.to_string(), "https://example.com/x");
        // A full-registry permutation reorders; a partial body is InvalidHomeScreen.
        assert!(matches!(
            editor.update_home_screen(&[("nope".to_owned(), true)]),
            Err(AppsError::InvalidHomeScreen { .. })
        ));
    }

    /// A replace resolves the app before validating any field: an unknown id is
    /// `404` even with a bad url (the field is never reached).
    #[test]
    fn editor_replace_of_an_unknown_id_is_not_found() {
        let editor = AppsEditor::new(FakeAppsStore::default());
        assert!(matches!(
            editor.update_app(
                "ghost",
                AppPayload {
                    name: "n".to_owned(),
                    subtitle: None,
                    url: "javascript:alert(1)".to_owned(),
                    requires_tunnel: false,
                },
            ),
            Err(AppsError::NotFound { .. })
        ));
    }
}
