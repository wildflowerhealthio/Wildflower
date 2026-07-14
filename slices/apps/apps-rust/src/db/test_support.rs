//! Shared `#[cfg(test)]` builders for the db query-body tests — the small helpers the
//! per-kind test modules seed a real in-memory [`SqliteAppsStore`] with. Centralized
//! here (rather than duplicated per file) the way `domain::actions` keeps its
//! fixtures in `test_fake`.

use super::SqliteAppsStore;
use crate::domain::{
    AppKind, AppRegistration, AppUrl, AppsError, AppsStore, CloudAppConfiguration,
    SelfHostedAppConfiguration,
};

/// A caller-built cloud registration (the shape the HTTP layer hands the store):
/// kind `cloud`, on the home screen, `position` a placeholder the store overrides.
/// `name` defaults to the id.
pub(super) fn cloud_registration(id: &str) -> AppRegistration {
    AppRegistration {
        id: id.to_owned(),
        kind: AppKind::Cloud,
        position: 0,
        on_homescreen: true,
        name: id.to_owned(),
        subtitle: None,
        local_only: false,
        client_id: None,
        requires_tunnel: false,
    }
}

pub(super) fn cloud_config(url: AppUrl) -> CloudAppConfiguration {
    CloudAppConfiguration { url }
}

pub(super) fn external(url: &str) -> AppUrl {
    AppUrl::External(url.to_owned())
}

/// A caller-built self-hosted upload pair (the shape the HTTP layer hands the store):
/// id = subdomain = `slug`, non-seeded, `position` / `port` placeholders the store
/// overrides. `content_folder` defaults to `<slug>-folder`.
pub(super) fn new_upload(name: &str, slug: &str) -> (AppRegistration, SelfHostedAppConfiguration) {
    (
        AppRegistration {
            id: slug.to_owned(),
            kind: AppKind::SelfHosted,
            position: 0,
            on_homescreen: true,
            name: name.to_owned(),
            subtitle: None,
            local_only: true,
            client_id: None,
            requires_tunnel: false,
        },
        SelfHostedAppConfiguration {
            port: 0,
            content_folder: format!("{slug}-folder"),
            subdomain: slug.to_owned(),
            seeded: false,
            launch_path: None,
        },
    )
}

/// Insert an upload pair with no reserved ports — the common no-customization path —
/// returning the stored pair.
pub(super) fn insert_upload(
    store: &SqliteAppsStore,
    name: &str,
    slug: &str,
) -> (AppRegistration, SelfHostedAppConfiguration) {
    let (registration, config) = new_upload(name, slug);
    store
        .insert_self_hosted_app(&registration, &config, &[])
        .expect("inserted")
}

/// The `launch_path` of a self-hosted `(registration, configuration)` pair.
pub(super) fn launch_path(pair: &(AppRegistration, SelfHostedAppConfiguration)) -> Option<String> {
    pair.1.launch_path.clone()
}

/// The `context: source` text of an [`AppsError::Infrastructure`], for asserting on
/// the invariant a corrupt-registry read names.
pub(super) fn error_text(error: &AppsError) -> String {
    match error {
        AppsError::Infrastructure { context, source } => format!("{context}: {source}"),
        other => format!("{other:?}"),
    }
}
