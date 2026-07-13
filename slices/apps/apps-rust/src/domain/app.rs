//! [`App`] — the thin enum at the cross-kind seams: one whole app (a per-kind
//! detail type wrapping its [`AppRegistration`] + payload). Under
//! class-table-inheritance the uniform `GET /apps` list speaks [`AppRegistration`]
//! directly, so `App` is no longer the currency of every read — it survives only
//! where a kind must be resolved at runtime: the launch dispatch (which target a
//! launch renders) and `DELETE`'s removability check.
//!
//! Not itself stored — it's composed by the detail read ([`find_app_on`](crate::db))
//! from the registration + the one child payload its `kind` names. The variant IS
//! the kind, so an `App` can't claim one kind while carrying another's payload. Its
//! accessors delegate to the wrapped registration; the per-kind verdicts (`smart` /
//! `removable`) come from the detail's [`AppRecord`] impl.

use super::{AppKind, AppRecord, AppRegistration, CloudApp, SelfHostedApp, SystemApp};

/// One whole catalogue app — a per-kind detail type. Composed by the store from
/// the `app_registry` row + the one child payload its `kind` names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum App {
    /// A system app — a compiled-shell route (`system_apps`).
    System(SystemApp),
    /// A cloud app — the `cloud_apps` payload.
    Cloud(CloudApp),
    /// A self-hosted app — the `self_hosted_apps` payload.
    SelfHosted(SelfHostedApp),
}

impl App {
    /// The registration (shared facts + placement) shared by every kind.
    #[must_use]
    pub fn registration(&self) -> &AppRegistration {
        match self {
            App::System(app) => &app.registration,
            App::Cloud(app) => &app.registration,
            App::SelfHosted(app) => &app.registration,
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

    /// The home-screen `enabled` flag.
    #[must_use]
    pub fn enabled(&self) -> bool {
        self.registration().enabled
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

    /// Whether this is a SMART app — delegates to the detail's [`AppRecord`] rule.
    #[must_use]
    pub fn smart(&self) -> bool {
        match self {
            App::System(app) => app.smart(),
            App::Cloud(app) => app.smart(),
            App::SelfHosted(app) => app.smart(),
        }
    }

    /// Whether the owner can remove this app — delegates to the detail's
    /// [`AppRecord`] rule.
    #[must_use]
    pub fn removable(&self) -> bool {
        match self {
            App::System(app) => app.removable(),
            App::Cloud(app) => app.removable(),
            App::SelfHosted(app) => app.removable(),
        }
    }

    /// The cloud detail, `None` for other kinds.
    #[must_use]
    pub fn as_cloud(&self) -> Option<&CloudApp> {
        match self {
            App::Cloud(app) => Some(app),
            _ => None,
        }
    }

    /// The self-hosted detail, `None` for other kinds.
    #[must_use]
    pub fn as_self_hosted(&self) -> Option<&SelfHostedApp> {
        match self {
            App::SelfHosted(app) => Some(app),
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
            enabled: true,
            name: "App X".to_owned(),
            subtitle: None,
            local_only: kind != AppKind::Cloud,
            client_id: client_id.map(str::to_owned),
            requires_tunnel: false,
        }
    }

    fn cloud(client_id: Option<&str>) -> App {
        App::Cloud(CloudApp {
            registration: registration("app-x", AppKind::Cloud, client_id),
            url: AppUrl::External("https://example.com/launch".to_owned()),
        })
    }

    fn self_hosted(seeded: bool) -> App {
        App::SelfHosted(SelfHostedApp {
            registration: registration("app-x", AppKind::SelfHosted, None),
            port: 8081,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded,
            launch_path: None,
        })
    }

    fn system() -> App {
        App::System(SystemApp {
            registration: registration("api-docs", AppKind::System, None),
            url: AppUrl::OriginRelative("/docs".to_owned()),
        })
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
    fn verdicts_and_accessors_follow_the_detail() {
        let cloud = cloud(Some("client"));
        assert!(cloud.smart());
        assert!(cloud.removable());
        assert!(cloud.as_cloud().is_some());
        assert!(cloud.as_self_hosted().is_none());
        assert_eq!(cloud.id(), "app-x");

        let seeded = self_hosted(true);
        assert!(!seeded.smart());
        assert!(!seeded.removable(), "a seeded self-hosted app is protected");

        let system = system();
        assert!(!system.smart());
        assert!(!system.removable());
        assert!(system.as_cloud().is_none());
        assert_eq!(system.name(), "App X");
    }
}
