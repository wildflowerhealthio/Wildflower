//! [`App`] — the thin enum at the cross-kind seams: one whole app as a
//! `(AppRegistration, …Configuration)` **pair**, one variant per kind. The store
//! speaks concrete registrations, configurations, and pairs; `App` exists only
//! where the configuration type can't be known at the call site — the launch
//! dispatch (which target a launch renders) and `DELETE`'s removability check. The
//! uniform `GET /apps` list speaks [`AppRegistration`] directly, so `App` is not the
//! currency of every read.
//!
//! Each variant carries both halves — the shared [`AppRegistration`] and the one
//! [`configuration`](AppBehaviour) its `kind` names — so the variant IS the kind and
//! an `App` can't claim one kind while carrying another's payload. Its accessors
//! delegate to the wrapped registration; `is_removable` comes from the
//! configuration's [`AppBehaviour`] impl.

use super::{
    AppBehaviour, AppKind, AppRegistration, CloudAppConfiguration, SelfHostedAppConfiguration,
    SystemAppConfiguration,
};

/// One whole catalogue app — a `(registration, configuration)` pair, one variant
/// per kind. Composed by the store from the `app_registrations` row + the one
/// configuration row its `kind` names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum App {
    /// A system app — its registration + the `system_app_configurations` payload.
    System(AppRegistration, SystemAppConfiguration),
    /// A cloud app — its registration + the `cloud_app_configurations` payload.
    Cloud(AppRegistration, CloudAppConfiguration),
    /// A self-hosted app — its registration + the `self_hosted_app_configurations`
    /// payload.
    SelfHosted(AppRegistration, SelfHostedAppConfiguration),
}

impl App {
    /// The registration (shared facts + placement) every kind carries.
    #[must_use]
    pub fn registration(&self) -> &AppRegistration {
        match self {
            App::System(registration, _)
            | App::Cloud(registration, _)
            | App::SelfHosted(registration, _) => registration,
        }
    }

    /// The stable app id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.registration().id
    }

    /// The display name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.registration().name
    }

    /// The subtitle, `None` when absent.
    #[must_use]
    pub fn subtitle(&self) -> Option<&str> {
        self.registration().subtitle.as_deref()
    }

    /// The declared no-egress flag.
    #[must_use]
    pub fn local_only(&self) -> bool {
        self.registration().local_only
    }

    /// Whether the app's tile shows on the home screen.
    #[must_use]
    pub fn on_homescreen(&self) -> bool {
        self.registration().on_homescreen
    }

    /// The home-screen display position.
    #[must_use]
    pub fn position(&self) -> i64 {
        self.registration().position
    }

    /// How this app's launch target resolves — the variant's kind.
    #[must_use]
    pub fn kind(&self) -> AppKind {
        self.registration().kind
    }

    /// Whether this is a SMART app — the registration's `client_id`-derived fact.
    #[must_use]
    pub fn is_smart(&self) -> bool {
        self.registration().is_smart()
    }

    /// Whether the owner can remove this app — delegates to the configuration's
    /// [`AppBehaviour`] rule.
    #[must_use]
    pub fn is_removable(&self) -> bool {
        match self {
            App::System(_, config) => config.is_removable(),
            App::Cloud(_, config) => config.is_removable(),
            App::SelfHosted(_, config) => config.is_removable(),
        }
    }

    /// The cloud configuration, `None` for other kinds.
    #[must_use]
    pub fn as_cloud(&self) -> Option<&CloudAppConfiguration> {
        match self {
            App::Cloud(_, config) => Some(config),
            _ => None,
        }
    }

    /// The self-hosted configuration, `None` for other kinds.
    #[must_use]
    pub fn as_self_hosted(&self) -> Option<&SelfHostedAppConfiguration> {
        match self {
            App::SelfHosted(_, config) => Some(config),
            _ => None,
        }
    }

    /// The system configuration, `None` for other kinds.
    #[must_use]
    pub fn as_system(&self) -> Option<&SystemAppConfiguration> {
        match self {
            App::System(_, config) => Some(config),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    fn registration(id: &str, kind: AppKind, client_id: Option<&str>) -> AppRegistration {
        AppRegistration {
            id: id.to_owned(),
            kind,
            position: 0,
            on_homescreen: true,
            name: "App X".to_owned(),
            subtitle: None,
            local_only: kind != AppKind::Cloud,
            client_id: client_id.map(str::to_owned),
            requires_tunnel: false,
        }
    }

    fn cloud(client_id: Option<&str>) -> App {
        App::Cloud(
            registration("app-x", AppKind::Cloud, client_id),
            CloudAppConfiguration {
                url: AppUrl::External("https://example.com/launch".to_owned()),
            },
        )
    }

    fn self_hosted(seeded: bool) -> App {
        App::SelfHosted(
            registration("app-x", AppKind::SelfHosted, None),
            SelfHostedAppConfiguration {
                port: 8081,
                content_folder: "app-x".to_owned(),
                subdomain: "app-x".to_owned(),
                seeded,
                launch_path: None,
            },
        )
    }

    fn system() -> App {
        App::System(
            registration("api-docs", AppKind::System, None),
            SystemAppConfiguration {
                url: AppUrl::OriginRelative("/docs".to_owned()),
            },
        )
    }

    /// The kind is the variant — one source of truth per kind.
    #[test]
    fn kind_derives_from_the_variant() {
        assert_eq!(system().kind(), AppKind::System);
        assert_eq!(self_hosted(true).kind(), AppKind::SelfHosted);
        assert_eq!(cloud(None).kind(), AppKind::Cloud);
    }

    /// The delegating verdicts and narrowing accessors match their kind only.
    #[test]
    fn verdicts_and_accessors_follow_the_configuration() {
        let cloud = cloud(Some("client"));
        assert!(cloud.is_smart());
        assert!(cloud.is_removable());
        assert!(cloud.as_cloud().is_some());
        assert!(cloud.as_self_hosted().is_none());
        assert_eq!(cloud.id(), "app-x");

        let seeded = self_hosted(true);
        assert!(!seeded.is_smart());
        assert!(
            !seeded.is_removable(),
            "a seeded self-hosted app is protected"
        );

        let system = system();
        assert!(!system.is_smart());
        assert!(!system.is_removable());
        assert!(system.as_cloud().is_none());
        assert!(system.as_system().is_some());
        assert_eq!(system.name(), "App X");
    }
}
