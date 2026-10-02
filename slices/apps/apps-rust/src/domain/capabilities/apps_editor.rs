//! The edit capability — [`AppsEditor`], gated by `wildflower/Apps.u`
//! ([`apps_editor_scopes`](super::apps_editor_scopes)).

use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, CloudAppPayload};
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration,
};

/// Edit an app's content / home-screen placement — `wildflower/Apps.u`.
pub(crate) fn apps_editor_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::UPDATE,
    )]
}

/// Content + home-screen edits — `PUT /cloud-apps/{id}`, `PUT /home-screen`. Gated by `wildflower/Apps.u`. Separate from
/// [`AppsCreator`](super::AppsCreator) / [`AppsDeleter`](super::AppsDeleter) so an
/// edit handler structurally can't create or delete.
pub(crate) struct AppsEditor<S: AppsStore> {
    store: S,
}

impl<S: AppsStore> AppsEditor<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Replace a cloud app's content; a non-cloud id is `404`. Resolves the kind
    /// before validating any field (a bad url on a non-cloud id is still a `404`),
    /// then overlays the edited fields onto the current registration — the store
    /// writes only the editable subset, so placement stays untouched.
    pub(crate) fn update_cloud_app(
        &self,
        id: &str,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        let (current, configuration) = self
            .store
            .find_app(id)?
            .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })?;
        if !matches!(configuration, AppConfiguration::Cloud(_)) {
            return Err(AppsError::NotFound { id: id.to_owned() });
        }
        let (name, subtitle, url) =
            actions::validate_cloud_fields(payload.name, payload.subtitle, payload.url)?;
        let edited = AppRegistration {
            name,
            subtitle,
            requires_tunnel: payload.requires_tunnel,
            ..current
        };
        self.store
            .replace_cloud_app(&edited, &CloudAppConfiguration { url })?
            .ok_or_else(|| {
                AppsError::infrastructure(
                    "cloud app vanished between find and replace",
                    format!("id={id}"),
                )
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
    use crate::domain::test_fake::{create_cloud, system, FakeAppsStore};

    #[test]
    fn editor_replaces_content_and_reorders() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "cloud-x").expect("seed cloud");
        let editor = AppsEditor::new(store);
        let (registration, _config) = editor
            .update_cloud_app(
                "cloud-x",
                CloudAppPayload {
                    name: "Renamed".to_owned(),
                    subtitle: None,
                    url: "https://example.com/x".to_owned(),
                    requires_tunnel: false,
                },
            )
            .expect("replace");
        assert_eq!(registration.name, "Renamed");
        // A full-registry permutation reorders; a partial body is InvalidHomeScreen.
        assert!(matches!(
            editor.update_home_screen(&[("nope".to_owned(), true)]),
            Err(AppsError::InvalidHomeScreen { .. })
        ));
    }

    /// A cloud replace resolves the kind before validating any field: an unknown
    /// id and a wrong-kind id are both `404`, and the wrong-kind `404` wins even
    /// over a bad url (the field is never reached).
    #[test]
    fn editor_cloud_replace_unknown_or_wrong_kind_is_not_found() {
        let store = FakeAppsStore::default();
        system(&store, "sys-x");
        let editor = AppsEditor::new(store);
        assert!(matches!(
            editor.update_cloud_app(
                "ghost",
                CloudAppPayload {
                    name: "n".to_owned(),
                    subtitle: None,
                    url: "https://x.example".to_owned(),
                    requires_tunnel: false,
                },
            ),
            Err(AppsError::NotFound { .. })
        ));
        // A system id is not a cloud app — the wrong-kind 404 wins over the bad url.
        assert!(matches!(
            editor.update_cloud_app(
                "sys-x",
                CloudAppPayload {
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
