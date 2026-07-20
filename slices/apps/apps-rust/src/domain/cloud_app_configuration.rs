//! [`CloudAppConfiguration`] — the `cloud_app_configurations` payload for a cloud
//! app: assets served from a remote origin, reaching PHI back through the tunnel.
//! Just the per-kind data (`url`); the shared catalogue facts + placement live on
//! the paired [`AppRegistration`](super::AppRegistration), and a whole cloud app is
//! the `(AppRegistration, CloudAppConfiguration)` pair the store speaks. The
//! removability verdict is the [`CommonAppConfig`] impl (always removable for a
//! cloud app).
//!
//! The `url` is a launch template: `{origin}` is replaced with the served origin at
//! launch time, `{launch}` with a fresh per-launch nonce (see [`AppUrl`]). It is
//! origin-independent, never a request-resolved redirect target — see
//! `docs/Apps/Explanation.md`. The editor wire shape
//! ([`CloudAppDetail`](crate::http::wire_representations::CloudAppDetail)) is built
//! from the pair at the HTTP seam; the HTTP layer synthesizes the registration +
//! configuration a create/replace needs, so this module carries no "combined app"
//! input spec — only [`CloudInsertError`], the granular reason a cloud insert wrote
//! nothing.

use super::app_url::AppUrl;
use super::{AppKind, CommonAppConfig};

/// The `cloud_app_configurations` payload — the launch URL template. `{origin}` is
/// replaced with the served origin at launch time, `{launch}` with a fresh
/// per-launch nonce (see [`AppUrl`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAppConfiguration {
    /// The launch URL template. See [`AppUrl`] for the accepted shapes.
    pub url: AppUrl,
}

impl CommonAppConfig for CloudAppConfiguration {
    const KIND: AppKind = AppKind::Cloud;

    /// Every cloud app is removable through the admin surface.
    fn is_removable(&self) -> bool {
        true
    }
}

/// Why [`insert_cloud_app`](super::AppsStore::insert_cloud_app) wrote nothing (the
/// transaction was dropped unwritten). The only non-infrastructure way a cloud
/// insert fails: the id was already taken. Distinguished (rather than a bare
/// `None`) so the cloud create capability (`AppsCreator::create_cloud_app`) reports
/// the true cause instead of assuming a collision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudInsertError {
    /// The id was already present in the registry — no row was written.
    IdTaken,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloud_configuration_is_always_removable() {
        let config = CloudAppConfiguration {
            url: AppUrl::External("https://example.com/launch".to_owned()),
        };
        assert!(config.is_removable());
    }
}
