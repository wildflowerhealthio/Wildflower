//! [`App`] — the thin enum at the list/wire seam: one whole app as it appears in
//! the catalogue, pairing a concrete record ([`CloudApp`] / [`SelfHostedApp`] /
//! [`SystemApp`]) with its `home_screen` placement (`position` + `enabled`). The
//! store hands these back from every read; the launch handler dispatches on the
//! variant, and the wire projects through `From<&App>` for
//! [`AppListEntry`](super::AppListEntry).
//!
//! Not a plain-data struct and not itself stored — it's assembled by the store
//! from the concrete tables + the `home_screen` table. The variant IS the
//! provenance, so an `App` can't claim one kind while carrying another's record.
//! Its accessors delegate to the wrapped record; the shared catalogue verdicts
//! (`smart` / `removable`) come from the record's [`AppRecord`] impl.

use super::{AppRecord, CloudApp, Provenance, SelfHostedApp, SystemApp};

/// One whole catalogue app: its `home_screen` placement plus the concrete record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum App {
    /// A system app — a compiled-in shell route (the record is the `'static`
    /// [`SystemApp`] source; no stored table).
    System {
        position: i64,
        enabled: bool,
        app: SystemApp,
    },
    /// A cloud app — the `cloud_apps` record.
    Cloud {
        position: i64,
        enabled: bool,
        app: CloudApp,
    },
    /// A self-hosted app — the `self_hosted_apps` record.
    SelfHosted {
        position: i64,
        enabled: bool,
        app: SelfHostedApp,
    },
}

impl App {
    /// The stable app id.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            App::System { app, .. } => app.id,
            App::Cloud { app, .. } => &app.id,
            App::SelfHosted { app, .. } => &app.id,
        }
    }

    /// The display name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            App::System { app, .. } => app.name,
            App::Cloud { app, .. } => &app.name,
            App::SelfHosted { app, .. } => &app.name,
        }
    }

    /// The subtitle, `None` when absent.
    #[must_use]
    pub fn subtitle(&self) -> Option<&str> {
        match self {
            App::System { app, .. } => app.subtitle,
            App::Cloud { app, .. } => app.subtitle.as_deref(),
            App::SelfHosted { app, .. } => app.subtitle.as_deref(),
        }
    }

    /// The declared no-egress flag.
    #[must_use]
    pub fn local_only(&self) -> bool {
        match self {
            App::System { app, .. } => app.local_only,
            App::Cloud { app, .. } => app.local_only,
            App::SelfHosted { app, .. } => app.local_only,
        }
    }

    /// The home-screen `enabled` flag.
    #[must_use]
    pub fn enabled(&self) -> bool {
        match self {
            App::System { enabled, .. }
            | App::Cloud { enabled, .. }
            | App::SelfHosted { enabled, .. } => *enabled,
        }
    }

    /// The home-screen display position.
    #[must_use]
    pub fn position(&self) -> i64 {
        match self {
            App::System { position, .. }
            | App::Cloud { position, .. }
            | App::SelfHosted { position, .. } => *position,
        }
    }

    /// How this app's launch target resolves — the variant's provenance.
    #[must_use]
    pub fn provenance(&self) -> Provenance {
        match self {
            App::System { .. } => Provenance::System,
            App::SelfHosted { .. } => Provenance::SelfHosted,
            App::Cloud { .. } => Provenance::Cloud,
        }
    }

    /// Whether this is a SMART app — delegates to the record's [`AppRecord`] rule.
    #[must_use]
    pub fn smart(&self) -> bool {
        match self {
            App::System { app, .. } => app.smart(),
            App::Cloud { app, .. } => app.smart(),
            App::SelfHosted { app, .. } => app.smart(),
        }
    }

    /// Whether the owner can remove this app — delegates to the record's
    /// [`AppRecord`] rule.
    #[must_use]
    pub fn removable(&self) -> bool {
        match self {
            App::System { app, .. } => app.removable(),
            App::Cloud { app, .. } => app.removable(),
            App::SelfHosted { app, .. } => app.removable(),
        }
    }

    /// The cloud record, `None` for other kinds.
    #[must_use]
    pub fn as_cloud(&self) -> Option<&CloudApp> {
        match self {
            App::Cloud { app, .. } => Some(app),
            _ => None,
        }
    }

    /// The self-hosted record, `None` for other kinds.
    #[must_use]
    pub fn as_self_hosted(&self) -> Option<&SelfHostedApp> {
        match self {
            App::SelfHosted { app, .. } => Some(app),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    fn cloud_record(client_id: Option<&str>) -> CloudApp {
        CloudApp {
            id: "app-x".to_owned(),
            name: "App X".to_owned(),
            subtitle: None,
            local_only: false,
            client_id: client_id.map(str::to_owned),
            url: AppUrl::External("https://example.com/launch".to_owned()),
            requires_tunnel: false,
        }
    }

    fn self_hosted_record(seeded: bool) -> SelfHostedApp {
        SelfHostedApp {
            id: "app-x".to_owned(),
            name: "App X".to_owned(),
            subtitle: None,
            local_only: true,
            client_id: None,
            port: 8081,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded,
            launch_path: None,
        }
    }

    fn system_record() -> SystemApp {
        SystemApp {
            id: "api-docs",
            name: "API Docs",
            subtitle: Some("docs"),
            url: "{origin}/docs",
            local_only: true,
        }
    }

    /// The provenance is the variant — one source of truth per kind.
    #[test]
    fn provenance_derives_from_the_variant() {
        assert_eq!(
            App::System {
                position: 0,
                enabled: true,
                app: system_record(),
            }
            .provenance(),
            Provenance::System,
        );
        assert_eq!(
            App::SelfHosted {
                position: 0,
                enabled: true,
                app: self_hosted_record(true),
            }
            .provenance(),
            Provenance::SelfHosted,
        );
        assert_eq!(
            App::Cloud {
                position: 0,
                enabled: true,
                app: cloud_record(None),
            }
            .provenance(),
            Provenance::Cloud,
        );
    }

    /// The delegating verdicts and narrowing accessors match their kind only.
    #[test]
    fn verdicts_and_accessors_follow_the_record() {
        let cloud = App::Cloud {
            position: 3,
            enabled: true,
            app: cloud_record(Some("client")),
        };
        assert!(cloud.smart());
        assert!(cloud.removable());
        assert!(cloud.as_cloud().is_some());
        assert!(cloud.as_self_hosted().is_none());
        assert_eq!(cloud.id(), "app-x");
        assert_eq!(cloud.position(), 3);

        let seeded = App::SelfHosted {
            position: 0,
            enabled: false,
            app: self_hosted_record(true),
        };
        assert!(!seeded.smart());
        assert!(!seeded.removable(), "a seeded self-hosted app is protected");
        assert!(!seeded.enabled());

        let system = App::System {
            position: 1,
            enabled: true,
            app: system_record(),
        };
        assert!(!system.smart());
        assert!(!system.removable());
        assert!(system.as_cloud().is_none());
        assert_eq!(system.name(), "API Docs");
        assert_eq!(system.subtitle(), Some("docs"));
    }
}
