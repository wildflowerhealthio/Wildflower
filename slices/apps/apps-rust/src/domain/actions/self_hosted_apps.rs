//! Self-hosted-app actions — the `/self-hosted-apps` detail read, upload install,
//! and launch-path replace.
//!
//! Unlike cloud, a self-hosted create's id (its slug), subdomain, and loopback port
//! are **store-allocated in-transaction** (uniqueness-suffixed slug, lowest-free
//! port), so the action keeps a dedicated [`NewSelfHostedUpload`] create spec rather
//! than a caller-built registration whose id/position/subdomain the store would only
//! overwrite. The pure allocation *logic* is lifted to the domain
//! ([`choose_self_hosted_slug`](crate::domain) / `lowest_free_port`), fed the taken
//! sets the store reads in the same transaction.

use super::all_kinds_apps::get_app;
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, NewSelfHostedUpload,
    SelfHostedAppConfiguration, UploadInsertError,
};

/// The self-hosted pair for `GET`/`PUT /self-hosted-apps/{id}` —
/// [`AppsError::NotFound`] when no *self-hosted* app has this id.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_self_hosted_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::SelfHosted(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

/// Install an uploaded self-hosted app. Returns the inserted self-hosted pair read
/// back in-txn, or maps the store's allocation-failure signal onto the wire
/// vocabulary: a slug clash is a name problem the caller can retry differently
/// ([`InvalidName`](AppsError::InvalidName)), an exhausted port space is a server
/// resource fault no rename fixes (a logged
/// [`Infrastructure`](AppsError::Infrastructure) 500 — it must not read as a `400`).
///
/// The slug/port are store-allocated, so this keeps its [`NewSelfHostedUpload`]
/// spec. The filesystem staging (extract → move → start the listener) stays in the
/// handler; this action is only the store insert + its semantic mapping.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when no unique slug was found;
/// [`AppsError::Infrastructure`] on a store write failure or an exhausted port
/// space.
pub(crate) fn create_self_hosted_app(
    store: &impl AppsStore,
    upload: &NewSelfHostedUpload,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    store
        .insert_self_hosted_app(upload)?
        .map_err(|error| match error {
            UploadInsertError::SlugSpaceExhausted => AppsError::InvalidName {
                message: "could not allocate a unique id for this name".to_owned(),
            },
            UploadInsertError::PortSpaceExhausted => AppsError::infrastructure(
                "no free loopback port for a new self-hosted app",
                "port space exhausted",
            ),
        })
}

/// Replace a self-hosted app's `launch_path` (`None` / empty → root-served) — the
/// `PUT /self-hosted-apps/{id}` body. An id that isn't a self-hosted app is
/// [`NotFound`](AppsError::NotFound); a **seeded** self-hosted app is edit-protected
/// ([`NotEditable`](AppsError::NotEditable), `409`); only then is the path validated
/// (`400` on a non-origin-relative value). Overlays the new `launch_path` onto the
/// current configuration and hands the store the pair.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::NotEditable`] / [`AppsError::InvalidUrl`] /
/// [`AppsError::Infrastructure`].
pub(crate) fn replace_self_hosted_app(
    store: &impl AppsStore,
    id: &str,
    launch_path: Option<String>,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    let (current_registration, configuration) = get_app(store, id)?;
    let current_config = match configuration {
        AppConfiguration::SelfHosted(config) if config.seeded => {
            // A migration-seeded app (patient-browser) is read-only, same 409 as
            // delete.
            return Err(AppsError::NotEditable { id: id.to_owned() });
        }
        AppConfiguration::SelfHosted(config) => config,
        _ => return Err(AppsError::NotFound { id: id.to_owned() }),
    };
    let launch_path = validate_launch_path(launch_path)?;
    let edited = SelfHostedAppConfiguration {
        launch_path,
        ..current_config
    };
    store
        .replace_self_hosted_app(&current_registration, &edited)?
        .ok_or_else(|| {
            AppsError::infrastructure(
                "self-hosted app vanished between find and replace",
                format!("id={id}"),
            )
        })
}

/// Validate a `launchPath` value. A cleared value (`None` / empty) passes through
/// as `None`. A non-empty path must be origin-relative — start with a single `/`
/// (not `//`, a protocol-relative authority) — so it hangs safely off the app's
/// own origin at launch; anything else is a `400 InvalidUrl`.
fn validate_launch_path(value: Option<String>) -> Result<Option<String>, AppsError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(AppsError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fake::{create_cloud, new_upload, seeded_self_hosted, FakeAppsStore};
    use super::*;
    use crate::domain::UploadInsertError;

    #[test]
    fn create_self_hosted_app_returns_the_installed_app() {
        let store = FakeAppsStore::default();
        let (registration, _config) =
            create_self_hosted_app(&store, &new_upload("my-app")).expect("insert");
        assert_eq!(registration.id, "my-app");
    }

    #[test]
    fn create_self_hosted_maps_slug_exhaustion_to_invalid_name() {
        let store = FakeAppsStore {
            upload_failure: Some(UploadInsertError::SlugSpaceExhausted),
            ..FakeAppsStore::default()
        };
        assert!(matches!(
            create_self_hosted_app(&store, &new_upload("my-app")),
            Err(AppsError::InvalidName { .. })
        ));
    }

    #[test]
    fn create_self_hosted_maps_port_exhaustion_to_infrastructure() {
        let store = FakeAppsStore {
            upload_failure: Some(UploadInsertError::PortSpaceExhausted),
            ..FakeAppsStore::default()
        };
        // A server resource fault, not a name problem — must not read as a 400.
        assert!(matches!(
            create_self_hosted_app(&store, &new_upload("my-app")),
            Err(AppsError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_on_a_seeded_app_is_not_editable() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(matches!(
            replace_self_hosted_app(&store, "patient-browser", Some("/launch.html".to_owned())),
            Err(AppsError::NotEditable { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_on_a_cloud_id_is_not_found() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        assert!(matches!(
            replace_self_hosted_app(&store, "app-x", Some("/launch.html".to_owned())),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_edits_and_validates() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "my-app", false);
        let (_registration, config) =
            replace_self_hosted_app(&store, "my-app", Some("/launch.html".to_owned()))
                .expect("replace");
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        // A non-origin-relative path is rejected.
        assert!(matches!(
            replace_self_hosted_app(
                &store,
                "my-app",
                Some("https://evil.example/launch".to_owned()),
            ),
            Err(AppsError::InvalidUrl { .. })
        ));
    }
}
