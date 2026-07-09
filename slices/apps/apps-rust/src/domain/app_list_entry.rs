//! `AppListEntry` — the app-catalogue wire shape, a **union discriminated on
//! `provenance`**, mirroring the database: shared parent-row fields plus each
//! variant's typed child-table fields (`cloud` adds the `url` template +
//! `requires_tunnel`, `self-hosted` adds `launch_path`, `system` adds nothing).
//! It backs `GET /apps` and `PUT /home-screen` and is every create / replace
//! response. The exposed `url` / `launch_path` are stored, origin-independent
//! templates (never request-resolved URLs) — see `docs/Apps/Explanation.md`
//! §"The catalogue is a `provenance`-discriminated union".

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{App, AppKind, AppUrl};

/// One app-catalogue entry on the wire, discriminated on `provenance`. Serialized
/// internally-tagged: every variant carries a `"provenance"` field (`"system"` /
/// `"cloud"` / `"self-hosted"`) alongside its fields, so utoipa renders it as a
/// `oneOf` and the TS client decodes it as a discriminated union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "provenance", rename_all = "kebab-case")]
pub enum AppListEntry {
    /// A system app — a compiled-in shell route. No child table, no extra fields.
    #[serde(rename_all = "camelCase")]
    System {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
    },
    /// A cloud app — carries its stored launch `url` template and the
    /// tunnel-requirement flag from the `cloud_apps` child.
    #[serde(rename_all = "camelCase")]
    Cloud {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
        /// The stored launch URL template (`{origin}` / `{launch}` tokens),
        /// serialized as its canonical string. See [`AppUrl`].
        #[schema(value_type = String)]
        url: AppUrl,
        requires_tunnel: bool,
    },
    /// A self-hosted app — carries its stored `launch_path` (absent for a
    /// root-served bundle) from the `self_hosted_apps` child.
    #[serde(rename_all = "camelCase")]
    SelfHosted {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
        /// The stored SMART launch path (origin-relative, with `{origin}` /
        /// `{launch}` tokens), or absent for a root-served (`index.html`) app.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        launch_path: Option<String>,
    },
}

/// The one projection from the domain [`App`] to its wire entry — the only
/// place `smart` / `removable` reach the wire, so the catalogue, the create /
/// replace responses, and the home-screen response can't drift from each other.
impl From<&App> for AppListEntry {
    fn from(app: &App) -> Self {
        let (id, enabled, name, subtitle, local_only, smart, removable) = (
            app.id.clone(),
            app.enabled,
            app.name.clone(),
            app.subtitle.clone(),
            app.local_only,
            app.smart(),
            app.removable(),
        );
        match &app.kind {
            AppKind::System => AppListEntry::System {
                id,
                enabled,
                name,
                subtitle,
                local_only,
                smart,
                removable,
            },
            AppKind::Cloud(cloud) => AppListEntry::Cloud {
                id,
                enabled,
                name,
                subtitle,
                local_only,
                smart,
                removable,
                url: cloud.url.clone(),
                requires_tunnel: cloud.requires_tunnel,
            },
            AppKind::SelfHosted(self_hosted) => AppListEntry::SelfHosted {
                id,
                enabled,
                name,
                subtitle,
                local_only,
                smart,
                removable,
                launch_path: self_hosted.launch_path.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CloudApp, SelfHostedApp};

    fn base_app(kind: AppKind) -> App {
        App {
            id: "app-x".to_owned(),
            name: "App X".to_owned(),
            subtitle: None,
            enabled: true,
            position: 3,
            local_only: false,
            client_id: None,
            kind,
        }
    }

    fn to_json(app: &App) -> serde_json::Value {
        serde_json::to_value(AppListEntry::from(app)).expect("entry serializes")
    }

    /// A system app projects to the `system` variant with the computed
    /// `smart` / `removable` and the absent subtitle omitted from the JSON.
    #[test]
    fn system_projection_serializes_exactly() {
        let app = base_app(AppKind::System);
        assert_eq!(
            to_json(&app),
            serde_json::json!({
                "provenance": "system",
                "id": "app-x",
                "name": "App X",
                "enabled": true,
                "localOnly": false,
                "smart": false,
                "removable": false,
            }),
        );
    }

    /// A cloud app projects to the `cloud` variant carrying the child fields;
    /// a present `client_id` surfaces as `smart` and a subtitle as `subtitle`.
    #[test]
    fn cloud_projection_serializes_exactly() {
        let mut app = base_app(AppKind::Cloud(CloudApp {
            url: AppUrl::External("https://example.com/launch".to_owned()),
            requires_tunnel: true,
        }));
        app.subtitle = Some("A subtitle".to_owned());
        app.client_id = Some("client".to_owned());
        assert_eq!(
            to_json(&app),
            serde_json::json!({
                "provenance": "cloud",
                "id": "app-x",
                "name": "App X",
                "subtitle": "A subtitle",
                "enabled": true,
                "localOnly": false,
                "smart": true,
                "removable": true,
                "url": "https://example.com/launch",
                "requiresTunnel": true,
            }),
        );
    }

    /// A self-hosted app projects to the `self-hosted` variant: an uploaded
    /// (non-seeded) app is removable and its launch path rides along; a seeded
    /// app is not removable and an absent launch path is omitted.
    #[test]
    fn self_hosted_projection_serializes_exactly() {
        let uploaded = base_app(AppKind::SelfHosted(SelfHostedApp {
            port: 8082,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded: false,
            launch_path: Some("/launch.html?launch={launch}".to_owned()),
        }));
        assert_eq!(
            to_json(&uploaded),
            serde_json::json!({
                "provenance": "self-hosted",
                "id": "app-x",
                "name": "App X",
                "enabled": true,
                "localOnly": false,
                "smart": false,
                "removable": true,
                "launchPath": "/launch.html?launch={launch}",
            }),
        );

        let seeded = base_app(AppKind::SelfHosted(SelfHostedApp {
            port: 8081,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded: true,
            launch_path: None,
        }));
        assert_eq!(
            to_json(&seeded),
            serde_json::json!({
                "provenance": "self-hosted",
                "id": "app-x",
                "name": "App X",
                "enabled": true,
                "localOnly": false,
                "smart": false,
                "removable": false,
            }),
        );
    }
}
