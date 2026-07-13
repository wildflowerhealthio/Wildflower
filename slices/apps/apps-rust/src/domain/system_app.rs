//! [`SystemApp`] — a whole system app: a compiled-shell route (API View, API
//! Docs) the user can never add, register, or delete. Under class-table-inheritance
//! it is an ordinary seeded row like any other kind — its [`AppRegistration`]
//! (id / name / subtitle / `local_only` / placement) plus the `system_apps`
//! payload (`url`, its `{origin}`-relative launch template). The former compiled-in
//! `SYSTEM_APPS` const is gone: the DB is authoritative, so shipping a change to a
//! system app is a migration.
//!
//! Every system app is `{origin}`-relative (an on-device target served by this
//! host), so [`SystemApp::url`] parses to
//! [`AppUrl::OriginRelative`](super::AppUrl::OriginRelative). [`SystemAppDetail`]
//! is the read-only `GET /system-apps/{id}` wire shape.

use serde::Serialize;
use utoipa::ToSchema;

use super::app_url::AppUrl;
use super::{AppKind, AppRecord, AppRegistration};

/// A whole system app — its registration plus the `system_apps` payload (`url`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemApp {
    /// The shared registration facts + homescreen placement.
    pub registration: AppRegistration,
    /// The launch URL template. Always `{origin}`-relative.
    pub url: AppUrl,
}

impl AppRecord for SystemApp {
    /// A system app is never a SMART app.
    fn smart(&self) -> bool {
        false
    }

    /// A system app is source-defined and never user-removable.
    fn removable(&self) -> bool {
        false
    }
}

/// The read-only `GET /system-apps/{id}` wire shape — the registration fields plus
/// the display-only `url` template. Flat: `kind` is always `system`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub enabled: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub smart: bool,
    pub requires_tunnel: bool,
    /// The stored launch URL template (`{origin}` token), serialized as its
    /// canonical string. Display-only — a system app is never editable.
    #[schema(value_type = String)]
    pub url: AppUrl,
}

impl From<&SystemApp> for SystemAppDetail {
    fn from(app: &SystemApp) -> Self {
        let reg = &app.registration;
        Self {
            id: reg.id.clone(),
            kind: reg.kind,
            enabled: reg.enabled,
            name: reg.name.clone(),
            subtitle: reg.subtitle.clone(),
            local_only: reg.local_only,
            smart: reg.smart(),
            requires_tunnel: reg.requires_tunnel,
            url: app.url.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system() -> SystemApp {
        SystemApp {
            registration: AppRegistration {
                id: "api-docs".to_owned(),
                kind: AppKind::System,
                position: 2,
                enabled: true,
                name: "API Docs".to_owned(),
                subtitle: Some("View API documentation in your browser.".to_owned()),
                local_only: true,
                client_id: None,
                requires_tunnel: false,
            },
            url: AppUrl::OriginRelative("/docs".to_owned()),
        }
    }

    #[test]
    fn never_smart_never_removable() {
        let app = system();
        assert!(!app.smart());
        assert!(!app.removable());
    }

    #[test]
    fn detail_projects_registration_and_url() {
        let json = serde_json::to_value(SystemAppDetail::from(&system())).unwrap();
        assert_eq!(json["kind"], "system");
        assert_eq!(json["name"], "API Docs");
        assert_eq!(json["localOnly"], true);
        assert_eq!(json["smart"], false);
        assert_eq!(json["url"], "{origin}/docs");
        assert!(
            json.get("removable").is_none(),
            "system detail has no removable"
        );
    }
}
