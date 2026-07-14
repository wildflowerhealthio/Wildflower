//! [`AppConfiguration`] — a per-kind app configuration whose kind isn't known at
//! the call site: the payload half of an app when a read resolves an id without
//! knowing its kind up front (`find_app`). One variant per kind, each wrapping the
//! concrete configuration. The shared half is the [`AppRegistration`] the store
//! hands back alongside it, so a whole app is the `(AppRegistration,
//! AppConfiguration)` pair `find_app` returns — there is no combined "app" type; the
//! launch / delete seams operate on the pair directly in the HTTP layer.
//!
//! Its `kind` is the variant (one source of truth per kind), `is_removable`
//! delegates to the variant's [`CommonAppConfig`] impl, and the `as_*` accessors
//! narrow to a concrete configuration for the per-kind detail reads.

use super::{
    AppKind, CloudAppConfiguration, CommonAppConfig, SelfHostedAppConfiguration,
    SystemAppConfiguration,
};

/// A per-kind app configuration of runtime-resolved kind — the payload half of the
/// `(AppRegistration, AppConfiguration)` pair a `find_app` read returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppConfiguration {
    /// A system app's `system_app_configurations` payload.
    System(SystemAppConfiguration),
    /// A cloud app's `cloud_app_configurations` payload.
    Cloud(CloudAppConfiguration),
    /// A self-hosted app's `self_hosted_app_configurations` payload.
    SelfHosted(SelfHostedAppConfiguration),
}

impl AppConfiguration {
    /// Which kind this configuration is — the variant's [`CommonAppConfig::KIND`].
    #[must_use]
    pub fn kind(&self) -> AppKind {
        match self {
            AppConfiguration::System(_) => SystemAppConfiguration::KIND,
            AppConfiguration::Cloud(_) => CloudAppConfiguration::KIND,
            AppConfiguration::SelfHosted(_) => SelfHostedAppConfiguration::KIND,
        }
    }

    /// Whether the owner can remove this app — delegates to the variant's
    /// [`CommonAppConfig`] rule.
    #[must_use]
    pub fn is_removable(&self) -> bool {
        match self {
            AppConfiguration::System(config) => config.is_removable(),
            AppConfiguration::Cloud(config) => config.is_removable(),
            AppConfiguration::SelfHosted(config) => config.is_removable(),
        }
    }

    /// The cloud configuration, `None` for other kinds.
    #[must_use]
    pub fn as_cloud(&self) -> Option<&CloudAppConfiguration> {
        match self {
            AppConfiguration::Cloud(config) => Some(config),
            _ => None,
        }
    }

    /// The self-hosted configuration, `None` for other kinds.
    #[must_use]
    pub fn as_self_hosted(&self) -> Option<&SelfHostedAppConfiguration> {
        match self {
            AppConfiguration::SelfHosted(config) => Some(config),
            _ => None,
        }
    }

    /// The system configuration, `None` for other kinds.
    #[must_use]
    pub fn as_system(&self) -> Option<&SystemAppConfiguration> {
        match self {
            AppConfiguration::System(config) => Some(config),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    fn cloud() -> AppConfiguration {
        AppConfiguration::Cloud(CloudAppConfiguration {
            url: AppUrl::External("https://example.com/launch".to_owned()),
        })
    }

    fn self_hosted(seeded: bool) -> AppConfiguration {
        AppConfiguration::SelfHosted(SelfHostedAppConfiguration {
            port: 8081,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded,
            launch_path: None,
        })
    }

    fn system() -> AppConfiguration {
        AppConfiguration::System(SystemAppConfiguration {
            url: AppUrl::OriginRelative("/docs".to_owned()),
        })
    }

    /// The kind is the variant — one source of truth per kind.
    #[test]
    fn kind_derives_from_the_variant() {
        assert_eq!(system().kind(), AppKind::System);
        assert_eq!(self_hosted(true).kind(), AppKind::SelfHosted);
        assert_eq!(cloud().kind(), AppKind::Cloud);
    }

    /// The delegating verdict and narrowing accessors match their kind only.
    #[test]
    fn verdict_and_accessors_follow_the_variant() {
        let cloud = cloud();
        assert!(cloud.is_removable());
        assert!(cloud.as_cloud().is_some());
        assert!(cloud.as_self_hosted().is_none());

        assert!(
            !self_hosted(true).is_removable(),
            "a seeded self-hosted app is protected"
        );

        let system = system();
        assert!(!system.is_removable());
        assert!(system.as_cloud().is_none());
        assert!(system.as_system().is_some());
    }
}
