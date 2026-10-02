//! Shared `#[cfg(test)]` builders for the db query-body tests — the small helpers
//! the per-kind test modules seed a real in-memory
//! [`SqliteAppsStore`](super::SqliteAppsStore) with. Centralized here (rather than
//! duplicated per file) the way `domain` keeps its fixtures in `test_fake`.

use crate::domain::{AppKind, AppRegistration, AppUrl, AppsError, CloudAppConfiguration};

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

/// The `context: source` text of an [`AppsError::Infrastructure`], for asserting on
/// the invariant a corrupt-registry read names.
pub(super) fn error_text(error: &AppsError) -> String {
    match error {
        AppsError::Infrastructure { context, source } => format!("{context}: {source}"),
        other => format!("{other:?}"),
    }
}
