//! Cloud-app actions — the `/cloud-apps` detail read, create, and content replace,
//! plus the [`CloudAppContent`] input the HTTP layer builds from its `CloudAppBody`
//! before calling in. The create/replace both validate the same editable content
//! ([`validate_cloud_fields`]) and synthesize the `(registration, configuration)`
//! the store persists.

use super::all_kinds_apps::get_app;
use crate::domain::{
    AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError, AppsStore,
    CloudAppConfiguration, CloudInsertError,
};

/// The editable content of a cloud app — the fields `POST /cloud-apps` (create) and
/// `PUT /cloud-apps/{id}` (replace) both carry. The HTTP layer maps its `CloudAppBody`
/// onto this before calling in; the action validates the fields and synthesizes the
/// `(registration, configuration)` it persists (the placement — `position` /
/// `on_homescreen` — is never part of content; `PUT /home-screen` owns it).
pub(crate) struct CloudAppContent {
    pub name: String,
    /// `None` means "no subtitle"; an empty string clears it.
    pub subtitle: Option<String>,
    /// The launch URL template, validated through the write-side [`AppUrl`] filter.
    pub url: String,
    pub requires_tunnel: bool,
}

/// The cloud pair for `GET`/`PUT /cloud-apps/{id}` — [`AppsError::NotFound`] when
/// no *cloud* app has this id (an unknown id, or one of another kind).
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_cloud_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::Cloud(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

/// Create a cloud app from the server-minted `id` and the raw [`CloudAppContent`].
/// Validates the content, synthesizes the `(registration, configuration)`, and
/// persists it. A [`CloudInsertError::IdTaken`] means the (server-minted) id was
/// already taken — a vanishingly-unlikely 21-char-random collision, so it surfaces
/// as a logged [`Infrastructure`](AppsError::Infrastructure) 500 rather than silently
/// returning the existing row.
///
/// # Errors
///
/// [`AppsError::InvalidName`] / [`AppsError::InvalidUrl`] on a bad field;
/// [`AppsError::Infrastructure`] on a store write failure or an id collision.
pub(crate) fn create_cloud_app(
    store: &impl AppsStore,
    id: String,
    content: CloudAppContent,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    let (name, subtitle, url) = validate_cloud_fields(content.name, content.subtitle, content.url)?;
    let registration = AppRegistration {
        id,
        kind: AppKind::Cloud,
        // The store assigns the tail `position`; this is a placeholder.
        position: 0,
        on_homescreen: true,
        name,
        subtitle,
        local_only: false,
        client_id: None,
        requires_tunnel: content.requires_tunnel,
    };
    let config = CloudAppConfiguration { url };
    store
        .insert_cloud_app(&registration, &config)?
        .map_err(|error| match error {
            CloudInsertError::IdTaken => {
                tracing::error!("app id collision on {}", registration.id);
                AppsError::infrastructure("insert_cloud_app id collision", "id already exists")
            }
        })
}

/// Replace a cloud app's *content* (the [`CloudAppContent`] fields) — the
/// `PUT /cloud-apps/{id}` body. Resolves the kind before validating any field: an id
/// that isn't a cloud app (unknown, or another kind) is [`NotFound`](AppsError::NotFound);
/// only then is the field validated (`400` on a bad name / url). Overlays the edited
/// fields onto the current registration and hands the store the pair; the store
/// writes only the editable subset, so `on_homescreen` / position (the placement
/// single-writer's) stay untouched.
///
/// # Errors
///
/// [`AppsError::NotFound`] when no cloud app has this id;
/// [`AppsError::InvalidName`] / [`AppsError::InvalidUrl`] on a bad field;
/// [`AppsError::Infrastructure`] on a store failure.
pub(crate) fn replace_cloud_app(
    store: &impl AppsStore,
    id: &str,
    content: CloudAppContent,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    // A non-cloud (or unknown) id is a 404 for this per-kind path, resolved before
    // any field is validated (a bad url on a non-cloud id is still a 404).
    let (current, configuration) = get_app(store, id)?;
    if !matches!(configuration, AppConfiguration::Cloud(_)) {
        return Err(AppsError::NotFound { id: id.to_owned() });
    }
    let (name, subtitle, url) = validate_cloud_fields(content.name, content.subtitle, content.url)?;
    // Overlay the editable fields onto the current registration; the store persists
    // only that subset, so the placeholder placement values ride along harmlessly.
    let edited = AppRegistration {
        name,
        subtitle,
        requires_tunnel: content.requires_tunnel,
        ..current
    };
    store
        .replace_cloud_app(&edited, &CloudAppConfiguration { url })?
        .ok_or_else(|| {
            AppsError::infrastructure(
                "cloud app vanished between find and replace",
                format!("id={id}"),
            )
        })
}

/// Validate the editable cloud fields: the name must be non-empty and the url must
/// parse through the write-side [`AppUrl`] filter. An empty subtitle (`""`) clears
/// it. `on_homescreen` has no place here — homescreen curation owns it.
fn validate_cloud_fields(
    name: String,
    subtitle: Option<String>,
    url: String,
) -> Result<(String, Option<String>, AppUrl), AppsError> {
    if name.is_empty() {
        return Err(AppsError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.parse::<AppUrl>().map_err(|e| AppsError::InvalidUrl {
        message: e.to_string(),
    })?;
    Ok((name, subtitle.filter(|s| !s.is_empty()), url))
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, system, FakeAppsStore};
    use super::*;

    fn content(name: &str, url: &str) -> CloudAppContent {
        CloudAppContent {
            name: name.to_owned(),
            subtitle: None,
            url: url.to_owned(),
            requires_tunnel: false,
        }
    }

    #[test]
    fn get_cloud_app_maps_wrong_kind_to_not_found() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(
            matches!(
                get_cloud_app(&store, "api-docs"),
                Err(AppsError::NotFound { .. })
            ),
            "a system id is not a cloud app — 404, not a mismatch",
        );
    }

    #[test]
    fn create_cloud_app_inserts_then_reports_a_taken_id_as_infrastructure() {
        let store = FakeAppsStore::default();
        let (registration, _config) = create_cloud(&store, "app-x").expect("insert");
        assert_eq!(registration.id, "app-x");
        assert!(registration.on_homescreen);
        // A second insert on the same (server-minted) id is a logged 500.
        assert!(matches!(
            create_cloud(&store, "app-x"),
            Err(AppsError::Infrastructure { .. })
        ));
    }

    #[test]
    fn create_cloud_app_validates_its_fields() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            create_cloud_app(&store, "app-x".to_owned(), content("", "https://x.example")),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            create_cloud_app(
                &store,
                "app-x".to_owned(),
                content("Name", "javascript:alert(1)"),
            ),
            Err(AppsError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn replace_cloud_app_unknown_id_is_not_found() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            replace_cloud_app(&store, "ghost", content("n", "https://x.example")),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_cloud_app_rewrites_a_cloud_app() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        let (registration, _config) = replace_cloud_app(
            &store,
            "app-x",
            content("Renamed", "https://example.com/new"),
        )
        .expect("replace");
        assert_eq!(registration.name, "Renamed");
        assert_eq!(
            store.find_app("app-x").unwrap().unwrap().0.name,
            "Renamed",
            "the store now holds the rewritten row",
        );
    }

    /// A per-kind path resolves the kind before validating fields: a cloud replace
    /// of a system id is `404` (not a cloud app), even when its url is also bad —
    /// the kind mismatch wins, and can no longer be expressed as a `409`.
    #[test]
    fn replace_cloud_app_on_a_system_id_is_not_found_before_url_validation() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(
            matches!(
                replace_cloud_app(&store, "api-docs", content("n", "javascript:alert(1)")),
                Err(AppsError::NotFound { .. }),
            ),
            "the wrong-kind 404 must win over the bad url",
        );
    }

    #[test]
    fn replace_cloud_app_validates_the_cloud_fields() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        assert!(matches!(
            replace_cloud_app(&store, "app-x", content("", "https://x.example")),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            replace_cloud_app(&store, "app-x", content("n", "javascript:alert(1)")),
            Err(AppsError::InvalidUrl { .. })
        ));
    }
}
