//! [`SelfHostedApp`] — a whole self-hosted app: web assets served from the device
//! on a dedicated, isolated loopback origin (and remotely at
//! `<subdomain>.<public_host>`). Under class-table-inheritance it is its
//! [`AppRegistration`] (shared facts + placement) plus the `self_hosted_apps`
//! payload (`port`, `content_folder`, `subdomain`, `seeded`, `launch_path`),
//! composed by the detail read.
//!
//! Rows come from two sources: the migration seed (`seeded = true`, protected from
//! delete/edit) and runtime uploads (`seeded = false`, removable). The launch URL
//! is rendered on demand via [`launch_url`](Self::launch_url) /
//! [`subdomain_url`](Self::subdomain_url) / [`render_launch`](Self::render_launch).
//! [`SelfHostedAppDetail`] is the editor wire shape (`GET`/`POST`/`PUT
//! /self-hosted-apps…`): the registration fields plus `launchPath` / `seeded` /
//! `removable`.

use serde::Serialize;
use utoipa::ToSchema;

use super::{AppKind, AppRecord, AppRegistration};

/// A whole self-hosted app — its registration plus the `self_hosted_apps` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedApp {
    /// The shared registration facts + homescreen placement.
    pub registration: AppRegistration,
    /// The loopback TCP port the host binds this app on, combined with the
    /// loopback hostname at read time into the `http://{host}:{port}/` launch
    /// target. The column keeps the port stable across reinstalls — see the
    /// port-allocation section of `docs/Apps/Store and Install Explanation.md`.
    pub port: u16,
    /// The on-disk subdirectory (under the host's `self-hosted-apps/` dir) whose
    /// files this app serves. Explicit rather than derived from the app id.
    pub content_folder: String,
    /// The public subdomain label this app is reachable at remotely, rendered as
    /// `https://{subdomain}.{public_host}/` by [`Self::subdomain_url`] and used as
    /// the reverse-proxy routing key.
    pub subdomain: String,
    /// `true` for a migration-seeded app (delete/edit refused with
    /// `409 AppNotEditable`), `false` for one uploaded at runtime (removable).
    pub seeded: bool,
    /// The origin-relative launch path inferred at install (see
    /// `crate::install::infer_launch_path`), or `None` for a root-served
    /// (`index.html`) bundle. When present it's a SMART launcher template with the
    /// same `{origin}` / `{launch}` placeholders the cloud `url` uses, substituted
    /// per request by [`Self::render_launch`].
    pub launch_path: Option<String>,
}

impl AppRecord for SelfHostedApp {
    /// A self-hosted app is a SMART app iff its registration carries a `client_id`.
    fn smart(&self) -> bool {
        self.registration.smart()
    }

    /// Only an uploaded (non-seeded) self-hosted app is removable; a
    /// migration-seeded one is protected.
    fn removable(&self) -> bool {
        !self.seeded
    }
}

impl SelfHostedApp {
    /// Render the loopback launch target `http://{host}:{port}/`. `host` is the
    /// loopback hostname the host binds on. The path is the bare root: each
    /// self-hosted app gets its own origin and is served from `/` on it.
    #[must_use]
    pub fn launch_url(&self, host: &str) -> String {
        format!("http://{host}:{port}/", host = host, port = self.port)
    }

    /// Render the public subdomain launch target
    /// `https://{subdomain}.{public_host}/` — the URL a forwarded (remote) caller
    /// can actually reach. Delegates to the shared
    /// [`shared_structures_rust::subdomain_host::subdomain_url`] so the host's
    /// subdomain reverse proxy and this redirect can't drift on the
    /// `<subdomain>.<public_host>` shape.
    #[must_use]
    pub fn subdomain_url(&self, public_host: &str) -> String {
        shared_structures_rust::subdomain_host::subdomain_url(&self.subdomain, public_host)
    }

    /// Render the concrete launch target for a request.
    ///
    /// `app_base` is this app's own launch origin *with* trailing slash (the
    /// loopback [`Self::launch_url`] or the [`Self::subdomain_url`] the handler
    /// resolves from the request). `served_origin` substitutes `{origin}` — the
    /// FHIR `iss` target, a *different* origin from `app_base` — and `launch_nonce`
    /// substitutes `{launch}`. With no [`Self::launch_path`] the target is the bare
    /// `app_base` (the app's root → `index.html`).
    #[must_use]
    pub fn render_launch(&self, app_base: &str, served_origin: &str, launch_nonce: &str) -> String {
        let Some(template) = &self.launch_path else {
            return app_base.to_owned();
        };
        // `app_base` keeps its trailing `/`; the template is a root-absolute
        // path (`/launch.html…`). Drop the duplicate separator before joining.
        let base = app_base.strip_suffix('/').unwrap_or(app_base);
        format!("{base}{template}")
            .replace("{origin}", served_origin)
            .replace("{launch}", launch_nonce)
    }
}

/// The `GET`/`POST`/`PUT /self-hosted-apps…` wire shape — the registration fields
/// plus `launchPath` (absent for a root-served bundle), `seeded`, and `removable`.
/// Flat (not a `provenance` union): `kind` is always `self-hosted`. The public
/// `subdomain` / loopback `port` / on-disk `content_folder` are host-internal and
/// stay off the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SelfHostedAppDetail {
    pub id: String,
    pub kind: AppKind,
    pub enabled: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub local_only: bool,
    pub smart: bool,
    pub requires_tunnel: bool,
    /// The stored SMART launch path (origin-relative, with `{origin}` / `{launch}`
    /// tokens), or absent for a root-served (`index.html`) app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
    /// `true` for a migration-seeded app (edit/delete-protected).
    pub seeded: bool,
    /// Whether the owner can remove this app (`!seeded`).
    pub removable: bool,
}

impl From<&SelfHostedApp> for SelfHostedAppDetail {
    fn from(app: &SelfHostedApp) -> Self {
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
            launch_path: app.launch_path.clone(),
            seeded: app.seeded,
            removable: app.removable(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(launch_path: Option<&str>, seeded: bool) -> SelfHostedApp {
        SelfHostedApp {
            registration: AppRegistration {
                id: "zip-app".to_owned(),
                kind: AppKind::SelfHosted,
                position: 3,
                enabled: true,
                name: "Zip App".to_owned(),
                subtitle: None,
                local_only: true,
                client_id: None,
                requires_tunnel: false,
            },
            port: 8082,
            content_folder: "zip-app".to_owned(),
            subdomain: "zip-app".to_owned(),
            seeded,
            launch_path: launch_path.map(str::to_owned),
        }
    }

    /// With no launcher the target is the bare origin — the app's root, which
    /// ServeDir resolves to `index.html`.
    #[test]
    fn render_launch_without_template_is_the_bare_origin() {
        let app = app(None, false);
        let base = app.launch_url("127.0.0.1");
        assert_eq!(
            app.render_launch(&base, "http://127.0.0.1:8080", "NONCE"),
            "http://127.0.0.1:8082/",
        );
    }

    /// A `launch.html` launcher hangs its path off the app's own loopback origin
    /// while `{origin}` (the `iss` target) resolves to the *host's* API origin —
    /// two different origins — and `{launch}` gets the nonce.
    #[test]
    fn render_launch_loopback_spans_app_and_api_origins() {
        let app = app(
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
            false,
        );
        let base = app.launch_url("127.0.0.1");
        assert_eq!(
            app.render_launch(&base, "http://127.0.0.1:8080", "NONCE"),
            "http://127.0.0.1:8082/launch.html?launch=NONCE&iss=http://127.0.0.1:8080/fhir-r4",
        );
    }

    /// The forwarded path: the launcher hangs off the app's subdomain origin,
    /// `{origin}` off the public host.
    #[test]
    fn render_launch_forwarded_uses_subdomain_and_public_host() {
        let app = app(
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
            false,
        );
        let base = app.subdomain_url("demo.example.com");
        assert_eq!(
            app.render_launch(&base, "https://demo.example.com", "N"),
            "https://zip-app.demo.example.com/launch.html?launch=N&iss=https://demo.example.com/fhir-r4",
        );
    }

    /// `smart` follows the registration's `client_id`; `removable` is exactly "not
    /// seeded". The detail wire shape reflects both.
    #[test]
    fn capability_verdicts_and_detail_projection() {
        let mut uploaded = app(None, false);
        assert!(!uploaded.smart());
        assert!(uploaded.removable(), "an uploaded app is removable");
        uploaded.registration.client_id = Some("client".to_owned());
        assert!(uploaded.smart());

        let seeded = app(Some("/launch.html"), true);
        assert!(!seeded.removable(), "a seeded app is protected");
        let json = serde_json::to_value(SelfHostedAppDetail::from(&seeded)).unwrap();
        assert_eq!(json["kind"], "self-hosted");
        assert_eq!(json["seeded"], true);
        assert_eq!(json["removable"], false);
        assert_eq!(json["launchPath"], "/launch.html");
    }
}
