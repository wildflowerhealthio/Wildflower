//! Self-hosted-app actions — the `/self-hosted-apps` detail read, upload install,
//! and launch-path replace.
//!
//! Like cloud, a self-hosted create takes a caller-built `(registration, config)`
//! pair; the store owns only the display `position` and the loopback `port`
//! (lowest-free, over the caller's `reserved_ports`), overriding those two
//! placeholders while using the `registration.id` verbatim as id / subdomain. Unlike
//! cloud, the store maps its own failure onto the wire vocabulary — a taken id is a
//! `400 InvalidName`, an exhausted port space a `500` — so this create is a thin
//! pass-through. The pure port-allocation *logic* lives in the domain
//! ([`lowest_free_port`](crate::domain)), fed the taken set the store reads in the
//! same transaction.

use super::all_kinds_apps::get_app;
use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, SelfHostedAppConfiguration,
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

/// Install an uploaded self-hosted app from the caller-built (handler-synthesized)
/// pair: the store overrides `position` / `port`, uses the id verbatim, and maps its
/// own failures onto the wire vocabulary — a taken slug is a name clash the caller
/// can resolve by renaming ([`InvalidName`](AppsError::InvalidName), a `400`), an
/// exhausted port space a logged [`Infrastructure`](AppsError::Infrastructure) `500`.
/// The filesystem staging (extract → move → start the listener) stays in the handler;
/// this action is only the store insert.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when the slug is already taken;
/// [`AppsError::Infrastructure`] on a store write failure or an exhausted port
/// space.
pub(crate) fn create_self_hosted_app(
    store: &impl AppsStore,
    registration: &AppRegistration,
    config: &SelfHostedAppConfiguration,
    reserved_ports: &[u16],
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    store.insert_self_hosted_app(registration, config, reserved_ports)
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

    #[test]
    fn create_self_hosted_app_returns_the_installed_app() {
        let store = FakeAppsStore::default();
        let (registration, config) = new_upload("my-app");
        let (registration, _config) =
            create_self_hosted_app(&store, &registration, &config, &[]).expect("insert");
        assert_eq!(registration.id, "my-app");
    }

    /// A second create with an already-taken slug is a client-fixable
    /// `400 InvalidName` (the taken-id → wire mapping the store now owns; the
    /// `Infrastructure` port-exhaustion path is covered by the store's own tests).
    #[test]
    fn create_self_hosted_on_a_taken_slug_is_invalid_name() {
        let store = FakeAppsStore::default();
        let (registration, config) = new_upload("my-app");
        create_self_hosted_app(&store, &registration, &config, &[]).expect("insert");
        assert!(matches!(
            create_self_hosted_app(&store, &registration, &config, &[]),
            Err(AppsError::InvalidName { .. })
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
