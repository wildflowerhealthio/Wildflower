//! Wire **representations** for the per-kind editor surface — the JSON detail
//! shapes the `GET`/`POST`/`PUT /cloud-apps…`, `…/self-hosted-apps…`, and
//! `GET /system-apps/{id}` routes serialize. Each is built from the
//! `(AppRegistration, …Configuration)` pair the store hands back
//! (`From<(&AppRegistration, &…Configuration)>`): the shared registration facts plus
//! the kind's payload and — for the editable kinds — the `isRemovable` verdict.
//!
//! These are the wire seam, not domain types: they live here (beside the routes
//! that speak them), while the domain keeps the plain-data configurations. The
//! uniform `GET /apps` list item is the domain [`AppRegistration`](crate::domain::AppRegistration)
//! itself (serialized directly), so it is not duplicated here.
//!
//! Flat (not a `provenance` union): each shape's `kind` is fixed, so a client that
//! called the cloud route always gets `kind: "cloud"`. On the wire everything is
//! camelCase; the boolean verdicts are `isSmart` / `isRemovable`, and the placement
//! flag is `onHomescreen`.

use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::{
    AppBehaviour, AppKind, AppRegistration, AppUrl, CloudAppConfiguration,
    SelfHostedAppConfiguration, SystemAppConfiguration,
};

/// The `GET`/`POST`/`PUT /cloud-apps…` wire shape — the registration fields plus
/// the stored `url` template and `isRemovable`. Built from the cloud
/// `(registration, configuration)` pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub on_homescreen: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub is_smart: bool,
    pub requires_tunnel: bool,
    /// The stored launch URL template (`{origin}` / `{launch}` tokens), serialized
    /// as its canonical string.
    #[schema(value_type = String)]
    pub url: AppUrl,
    /// Always `true` for a cloud app; carried for a uniform editor contract.
    pub is_removable: bool,
}

impl From<(&AppRegistration, &CloudAppConfiguration)> for CloudAppDetail {
    fn from((registration, config): (&AppRegistration, &CloudAppConfiguration)) -> Self {
        Self {
            id: registration.id.clone(),
            kind: registration.kind,
            on_homescreen: registration.on_homescreen,
            name: registration.name.clone(),
            subtitle: registration.subtitle.clone(),
            local_only: registration.local_only,
            is_smart: registration.is_smart(),
            requires_tunnel: registration.requires_tunnel,
            url: config.url.clone(),
            is_removable: config.is_removable(),
        }
    }
}

/// The `GET`/`POST`/`PUT /self-hosted-apps…` wire shape — the registration fields
/// plus `launchPath` (absent for a root-served bundle), `seeded`, and
/// `isRemovable`. The public `subdomain` / loopback `port` / on-disk
/// `content_folder` are host-internal and stay off the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelfHostedAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub on_homescreen: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub is_smart: bool,
    pub requires_tunnel: bool,
    /// The stored SMART launch path (origin-relative, with `{origin}` / `{launch}`
    /// tokens), or absent for a root-served (`index.html`) app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
    /// `true` for a migration-seeded app (edit/delete-protected).
    pub seeded: bool,
    /// Whether the owner can remove this app (`!seeded`).
    pub is_removable: bool,
}

impl From<(&AppRegistration, &SelfHostedAppConfiguration)> for SelfHostedAppDetail {
    fn from((registration, config): (&AppRegistration, &SelfHostedAppConfiguration)) -> Self {
        Self {
            id: registration.id.clone(),
            kind: registration.kind,
            on_homescreen: registration.on_homescreen,
            name: registration.name.clone(),
            subtitle: registration.subtitle.clone(),
            local_only: registration.local_only,
            is_smart: registration.is_smart(),
            requires_tunnel: registration.requires_tunnel,
            launch_path: config.launch_path.clone(),
            seeded: config.seeded,
            is_removable: config.is_removable(),
        }
    }
}

/// The read-only `GET /system-apps/{id}` wire shape — the registration fields plus
/// the display-only `url` template. A system app is never editable, so it carries
/// no `isRemovable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub on_homescreen: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub is_smart: bool,
    pub requires_tunnel: bool,
    /// The stored launch URL template (`{origin}` token), serialized as its
    /// canonical string. Display-only — a system app is never editable.
    #[schema(value_type = String)]
    pub url: AppUrl,
}

impl From<(&AppRegistration, &SystemAppConfiguration)> for SystemAppDetail {
    fn from((registration, config): (&AppRegistration, &SystemAppConfiguration)) -> Self {
        Self {
            id: registration.id.clone(),
            kind: registration.kind,
            on_homescreen: registration.on_homescreen,
            name: registration.name.clone(),
            subtitle: registration.subtitle.clone(),
            local_only: registration.local_only,
            is_smart: registration.is_smart(),
            requires_tunnel: registration.requires_tunnel,
            url: config.url.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(kind: AppKind, client_id: Option<&str>) -> AppRegistration {
        AppRegistration {
            id: "app-x".to_owned(),
            kind,
            position: 3,
            on_homescreen: true,
            name: "App X".to_owned(),
            subtitle: Some("A subtitle".to_owned()),
            local_only: kind != AppKind::Cloud,
            client_id: client_id.map(str::to_owned),
            requires_tunnel: kind == AppKind::Cloud,
        }
    }

    #[test]
    fn cloud_detail_projects_registration_configuration_and_removable() {
        let reg = registration(AppKind::Cloud, Some("client"));
        let config = CloudAppConfiguration {
            url: AppUrl::External("https://example.com/launch".to_owned()),
        };
        let json = serde_json::to_value(CloudAppDetail::from((&reg, &config))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "app-x",
                "kind": "cloud",
                "onHomescreen": true,
                "name": "App X",
                "subtitle": "A subtitle",
                "localOnly": false,
                "isSmart": true,
                "requiresTunnel": true,
                "url": "https://example.com/launch",
                "isRemovable": true,
            }),
        );
    }

    #[test]
    fn self_hosted_detail_reflects_seeded_and_launch_path() {
        let reg = registration(AppKind::SelfHosted, None);
        let config = SelfHostedAppConfiguration {
            port: 8082,
            content_folder: "zip-app".to_owned(),
            subdomain: "zip-app".to_owned(),
            seeded: true,
            launch_path: Some("/launch.html".to_owned()),
        };
        let json = serde_json::to_value(SelfHostedAppDetail::from((&reg, &config))).unwrap();
        assert_eq!(json["kind"], "self-hosted");
        assert_eq!(json["seeded"], true);
        assert_eq!(json["isRemovable"], false);
        assert_eq!(json["launchPath"], "/launch.html");
        assert_eq!(json["isSmart"], false);
    }

    #[test]
    fn system_detail_has_no_removable() {
        let reg = registration(AppKind::System, None);
        let config = SystemAppConfiguration {
            url: AppUrl::OriginRelative("/docs".to_owned()),
        };
        let json = serde_json::to_value(SystemAppDetail::from((&reg, &config))).unwrap();
        assert_eq!(json["kind"], "system");
        assert_eq!(json["url"], "{origin}/docs");
        assert_eq!(json["isSmart"], false);
        assert!(
            json.get("isRemovable").is_none(),
            "system detail has no isRemovable"
        );
    }
}
