//! [`CloudApp`] — a whole cloud app: assets served from a remote origin, reaching
//! PHI back through the tunnel. Under class-table-inheritance it is its
//! [`AppRegistration`] (the shared catalogue facts + placement, on `app_registry`)
//! plus the `cloud_apps` payload (`url`), composed by the detail read
//! ([`find_app_on`](crate::db)). A plain-data type — the catalogue verdicts
//! (`smart` / `removable`) are the [`AppRecord`] impl below; `smart` sources from
//! the registration's soft `client_id`.
//!
//! [`CloudAppDetail`] is the editor wire shape (`GET`/`POST`/`PUT /cloud-apps…`):
//! the registration fields plus the stored `url` template and `removable` (always
//! true for a cloud app). The `url` is origin-independent (`{origin}` / `{launch}`
//! tokens), never a request-resolved redirect target — see `docs/Apps/Explanation.md`.

use serde::Serialize;
use utoipa::ToSchema;

use super::app_url::AppUrl;
use super::{AppKind, AppRecord, AppRegistration};

/// A whole cloud app — its registration plus the `cloud_apps` payload. The `url`
/// is a launch template: `{origin}` is replaced with the served origin at launch
/// time, `{launch}` with a fresh per-launch nonce (see [`AppUrl`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudApp {
    /// The shared registration facts + homescreen placement.
    pub registration: AppRegistration,
    /// The launch URL template. See [`AppUrl`] for the accepted shapes.
    pub url: AppUrl,
}

impl AppRecord for CloudApp {
    /// A cloud app is a SMART app iff its registration carries a `client_id`.
    fn smart(&self) -> bool {
        self.registration.smart()
    }

    /// Every cloud app is removable through the admin surface.
    fn removable(&self) -> bool {
        true
    }
}

/// The `GET`/`POST`/`PUT /cloud-apps…` wire shape — the registration fields plus
/// the stored `url` template and `removable`. Flat (not a `provenance` union):
/// `kind` is always `cloud`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub enabled: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub smart: bool,
    pub requires_tunnel: bool,
    /// The stored launch URL template (`{origin}` / `{launch}` tokens), serialized
    /// as its canonical string.
    #[schema(value_type = String)]
    pub url: AppUrl,
    /// Always `true` for a cloud app; carried for a uniform editor contract.
    pub removable: bool,
}

impl From<&CloudApp> for CloudAppDetail {
    fn from(app: &CloudApp) -> Self {
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
            removable: app.removable(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cloud(client_id: Option<&str>, requires_tunnel: bool) -> CloudApp {
        CloudApp {
            registration: AppRegistration {
                id: "app-x".to_owned(),
                kind: AppKind::Cloud,
                position: 3,
                enabled: true,
                name: "App X".to_owned(),
                subtitle: Some("A subtitle".to_owned()),
                local_only: false,
                client_id: client_id.map(str::to_owned),
                requires_tunnel,
            },
            url: AppUrl::External("https://example.com/launch".to_owned()),
        }
    }

    #[test]
    fn detail_projects_registration_payload_and_removable() {
        let json =
            serde_json::to_value(CloudAppDetail::from(&cloud(Some("client"), true))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "app-x",
                "kind": "cloud",
                "enabled": true,
                "name": "App X",
                "subtitle": "A subtitle",
                "localOnly": false,
                "smart": true,
                "requiresTunnel": true,
                "url": "https://example.com/launch",
                "removable": true,
            }),
        );
    }

    #[test]
    fn smart_follows_client_id_removable_is_always_true() {
        assert!(cloud(Some("c"), false).smart());
        assert!(!cloud(None, false).smart());
        assert!(cloud(None, false).removable());
    }
}
