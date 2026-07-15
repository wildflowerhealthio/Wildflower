//! Self-hosted-app actions — the `/self-hosted-apps` detail read, upload install,
//! and launch-path replace.
//!
//! [`install_self_hosted_app`] owns the whole install: it derives the slug (the id /
//! subdomain) from the name, drives the [`SelfHostedInstaller`] port to stage the
//! uploaded bundle onto disk, synthesizes the registration + create payload (with the
//! fixed self-hosted defaults), hands them to the store — which uses the id verbatim,
//! allocates the `port` / `position`, writes `seeded = false`, and maps a taken id to
//! `400 InvalidName` — and then starts the listener, unwinding the staged files if the
//! insert fails. The HTTP handler only shapes the multipart body into a
//! [`SelfHostedAppPayload`] + a native installer; all the sequencing / validation /
//! synthesis lives here.

use bytes::Bytes;

use super::all_kinds_apps::get_app;
use crate::domain::{
    AppConfiguration, AppKind, AppRegistration, AppsError, AppsStore, SelfHostedAppConfiguration,
    SelfHostedAppConfigurationPayload, SelfHostedInstaller,
};

/// The raw data `POST /self-hosted-apps` hands the install action — the multipart
/// fields plus the ports the allocation must skip, with no defaults or derived values
/// (the action slugifies the name, stages the bundle, synthesizes the pair, and
/// normalizes the subtitle).
pub(crate) struct SelfHostedAppPayload {
    pub name: String,
    /// `None` (or empty) means "no subtitle".
    pub subtitle: Option<String>,
    /// The uploaded zip, handed to the installer's `stage` verbatim.
    pub bundle: Bytes,
    /// Ports the port allocation must skip (the host's own loopback API port).
    pub reserved_ports: Vec<u16>,
}

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

/// Install an uploaded self-hosted app end-to-end: derive the slug (id / subdomain)
/// from the name, stage the bundle via the `installer` (extract → move into place),
/// synthesize the registration + create payload with the fixed self-hosted defaults
/// (`kind` / `on_homescreen` / `local_only`; `position` a placeholder, `port` and
/// `seeded = false` the store's), insert it, and bring the listener online. A failed
/// insert unwinds the staged files ([`discard`](SelfHostedInstaller::discard)).
/// The store uses the id verbatim and maps a clash to [`InvalidName`](AppsError::InvalidName)
/// (a name the caller can change), an exhausted port space to a logged
/// [`Infrastructure`](AppsError::Infrastructure) `500`.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when the name slugs to nothing or the slug is already
/// taken; [`AppsError::InvalidZip`] on a bad bundle; [`AppsError::Infrastructure`] on
/// a staging / listener / store failure.
pub(crate) async fn install_self_hosted_app(
    store: &impl AppsStore,
    installer: &impl SelfHostedInstaller,
    payload: SelfHostedAppPayload,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    // The slug is the name reduced to a DNS label; a name that slugs to nothing is a
    // `400 InvalidName` before anything is staged.
    let slug = slugify(&payload.name).ok_or_else(|| AppsError::InvalidName {
        message: "name must contain at least one letter or digit".to_owned(),
    })?;

    // Stage the bundle onto disk (extract + move into place) so a committed row always
    // points at present files.
    let staged = installer.stage(payload.bundle).await?;

    // Synthesize the registration + create payload the store persists — the slug is the
    // id and subdomain, `position` is a placeholder the store overrides, and an empty
    // subtitle clears to `None`. The store owns `port` and writes `seeded = false`.
    let registration = AppRegistration {
        id: slug.clone(),
        kind: AppKind::SelfHosted,
        position: 0,
        on_homescreen: true,
        name: payload.name,
        subtitle: payload.subtitle.filter(|s| !s.is_empty()),
        local_only: true,
        client_id: None,
        requires_tunnel: false,
    };
    let create = SelfHostedAppConfigurationPayload {
        content_folder: staged.content_folder,
        subdomain: slug,
        launch_path: staged.launch_path,
    };

    // Insert; unwind the just-staged files if the row can't be written.
    let (registration, config) =
        match store.insert_self_hosted_app(&registration, &create, &payload.reserved_ports) {
            Ok(pair) => pair,
            Err(error) => {
                installer.discard(&create.content_folder);
                return Err(error);
            }
        };

    // The row is committed and the files are in place — bring the listener online.
    installer.start_listener(&registration.id, &config).await?;
    Ok((registration, config))
}

/// Reduce an app name to a DNS label: lowercase, each run of non-alphanumerics
/// collapsed to a single `-`, trimmed, and capped at the 63-char label limit (a cut
/// at the boundary can land on a `-`, so a trailing one is stripped again). `None`
/// when nothing survives — the name has no usable slug. The label becomes the app's
/// id **and** its public subdomain, so it must be a valid DNS label.
fn slugify(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            pending_dash = false;
        } else if !pending_dash {
            slug.push('-');
            pending_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    let mut result: String = trimmed.chars().take(63).collect();
    while result.ends_with('-') {
        result.pop();
    }
    (!result.is_empty()).then_some(result)
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
    // The store writes only `launch_path`; carry the immutable `content_folder` /
    // `subdomain` from the current config to fill the shared payload.
    let payload = SelfHostedAppConfigurationPayload {
        content_folder: current_config.content_folder,
        subdomain: current_config.subdomain,
        launch_path,
    };
    store
        .replace_self_hosted_app(&current_registration, &payload)?
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
    use super::super::test_fake::{create_cloud, seeded_self_hosted, FakeAppsStore, FakeInstaller};
    use super::*;

    fn payload(name: &str) -> SelfHostedAppPayload {
        SelfHostedAppPayload {
            name: name.to_owned(),
            subtitle: None,
            bundle: bytes::Bytes::new(),
            reserved_ports: Vec::new(),
        }
    }

    #[tokio::test]
    async fn install_self_hosted_app_stages_synthesizes_inserts_and_starts() {
        let store = FakeAppsStore::default();
        let installer = FakeInstaller::new("mint-abc");
        let (registration, config) = install_self_hosted_app(
            &store,
            &installer,
            SelfHostedAppPayload {
                subtitle: Some(String::new()),
                ..payload("My App")
            },
        )
        .await
        .expect("installed");

        assert_eq!(registration.id, "my-app", "the id is the slugified name");
        assert_eq!(registration.kind, AppKind::SelfHosted);
        assert!(registration.local_only);
        assert!(registration.on_homescreen);
        assert_eq!(
            registration.subtitle, None,
            "an empty subtitle normalizes to None"
        );
        assert_eq!(config.subdomain, "my-app");
        assert_eq!(
            config.content_folder, "mint-abc",
            "the staged folder, recorded verbatim"
        );
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        assert!(!config.seeded);
        assert_eq!(
            installer.started.borrow().as_slice(),
            ["my-app"],
            "the listener is started for the installed id",
        );
        assert!(
            installer.discarded.borrow().is_empty(),
            "nothing is discarded on success",
        );
    }

    #[tokio::test]
    async fn install_self_hosted_app_allocates_the_lowest_free_port() {
        let store = FakeAppsStore::default();
        // The seeded app sits at 8081, below the upload range.
        seeded_self_hosted(&store, "patient-browser", true);

        let installer = FakeInstaller::new("first-abc");
        let (_, first) = install_self_hosted_app(&store, &installer, payload("First"))
            .await
            .expect("installed");
        assert_eq!(first.port, 8082, "the first upload takes the range floor");

        let installer = FakeInstaller::new("second-abc");
        let (_, second) = install_self_hosted_app(&store, &installer, payload("Second"))
            .await
            .expect("installed");
        assert_eq!(second.port, 8083);

        // Deleting the first upload frees its port; the next install reuses it
        // (lowest-free, not tail-append) so origins stay stable across reinstall.
        store.delete_app("first").expect("deleted");
        let installer = FakeInstaller::new("third-abc");
        let (_, third) = install_self_hosted_app(&store, &installer, payload("Third"))
            .await
            .expect("installed");
        assert_eq!(third.port, 8082, "a freed port is reused lowest-first");
    }

    #[tokio::test]
    async fn install_self_hosted_app_rejects_a_nameless_slug_before_staging() {
        let store = FakeAppsStore::default();
        let installer = FakeInstaller::new("mint");
        let result = install_self_hosted_app(&store, &installer, payload("!!!")).await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert!(
            installer.started.borrow().is_empty() && installer.discarded.borrow().is_empty(),
            "a name that slugs to nothing never stages or starts",
        );
    }

    #[tokio::test]
    async fn install_self_hosted_app_discards_the_bundle_when_the_insert_fails() {
        let store = FakeAppsStore::default();
        // A pre-existing app owns the slug, so the store insert reports a taken id.
        seeded_self_hosted(&store, "my-app", false);
        let installer = FakeInstaller::new("mint-xyz");
        let result = install_self_hosted_app(&store, &installer, payload("My App")).await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert_eq!(
            installer.discarded.borrow().as_slice(),
            ["mint-xyz"],
            "the staged folder is unwound when the row can't be written",
        );
        assert!(
            installer.started.borrow().is_empty(),
            "a failed insert never starts the listener",
        );
    }

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("My Cool App!!"), Some("my-cool-app".to_owned()));
        assert_eq!(slugify("  Trim  Me  "), Some("trim-me".to_owned()));
        assert_eq!(
            slugify("under_score/slash"),
            Some("under-score-slash".to_owned())
        );
        assert_eq!(
            slugify("Already-Slugged"),
            Some("already-slugged".to_owned())
        );
    }

    #[test]
    fn slugify_returns_none_when_nothing_survives() {
        assert_eq!(slugify(""), None);
        assert_eq!(slugify("   "), None);
        assert_eq!(slugify("!!!"), None);
    }

    #[test]
    fn slugify_caps_at_dns_label_length_without_trailing_dash() {
        let long = "a".repeat(100);
        let slug = slugify(&long).unwrap();
        assert_eq!(slug.len(), 63);
        // A name that would cut on a separator at the boundary doesn't leave a
        // trailing dash.
        let boundary = format!("{}-tail", "b".repeat(62));
        let slug = slugify(&boundary).unwrap();
        assert!(slug.len() <= 63);
        assert!(!slug.ends_with('-'));
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
