//! [`SystemAppConfiguration`] — the `system_app_configurations` payload for a
//! system app: a compiled-shell route (API View, API Docs) the user can never add,
//! register, or delete. Just the per-kind data (`url`, the `{origin}`-relative
//! launch template); the shared catalogue facts + placement live on the paired
//! [`AppRegistration`](super::AppRegistration), and a whole system app is the
//! `(AppRegistration, SystemAppConfiguration)` pair. The DB is authoritative, so
//! shipping a change to a system app is a migration.
//!
//! Every system app is `{origin}`-relative (an on-device target served by this
//! host), so [`SystemAppConfiguration::url`] parses to
//! [`AppUrl::OriginRelative`](super::AppUrl::OriginRelative). The read-only editor
//! wire shape ([`SystemAppDetail`](crate::http::wire_representations::SystemAppDetail))
//! is built from the pair at the HTTP seam.

use super::app_url::AppUrl;
use super::{AppKind, CommonAppConfig};

/// The `system_app_configurations` payload — the `{origin}`-relative launch
/// template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemAppConfiguration {
    /// The launch URL template. Always `{origin}`-relative.
    pub url: AppUrl,
}

impl CommonAppConfig for SystemAppConfiguration {
    const KIND: AppKind = AppKind::System;

    /// A system app is source-defined and never user-removable.
    fn is_removable(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_system_configuration_is_never_removable() {
        let config = SystemAppConfiguration {
            url: AppUrl::OriginRelative("/docs".to_owned()),
        };
        assert!(!config.is_removable());
    }
}
