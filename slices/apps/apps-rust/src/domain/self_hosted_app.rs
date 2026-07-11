//! [`SelfHostedApp`] — a self-hosted app: web assets served from the device on a
//! dedicated, isolated loopback origin (and remotely at
//! `<subdomain>.<public_host>`). The standalone `self_hosted_apps` row, carrying
//! every one of its own columns: the shared catalogue fields (`id` / `name` /
//! `subtitle` / `local_only` / `client_id`) plus the payload (`port`,
//! `content_folder`, `subdomain`, `seeded`, `launch_path`). The table it lives in
//! IS its provenance; the home-screen ordering + `enabled` flag live in the
//! separate `home_screen` table (see [`App`](super::App)).
//!
//! Rows come from two sources: the migration seed (`seeded = true`, protected
//! from delete through the admin surface) and runtime uploads through the create
//! surface (`seeded = false`, removable). The launch URL is rendered on demand
//! via [`SelfHostedApp::launch_url`] / [`SelfHostedApp::subdomain_url`].
//!
//! Diesel maps this type straight to/from the `self_hosted_apps` table: the
//! derives plus the [`PortColumn`](crate::db::columns::PortColumn) mapping on
//! `port` (a `u16` stored as `INTEGER`). A plain-data row type — the catalogue
//! verdicts (`smart` / `removable`) are the behavioural
//! [`AppRecord`](super::AppRecord) impl below.

use diesel::prelude::{Insertable, Queryable, Selectable};

use super::AppRecord;
use crate::db::columns::PortColumn;
use crate::db::schema::self_hosted_apps;

/// A stored self-hosted app — the `self_hosted_apps` row: a locally-served app's
/// loopback binding and launch-render inputs plus its shared catalogue fields.
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = self_hosted_apps)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct SelfHostedApp {
    /// Stable id, globally unique across all kinds. The seeds happen to match the
    /// `subdomain`, but they're independent columns.
    pub id: String,
    pub name: String,
    /// `None` means "no subtitle"; the wire serializes it as an absent field.
    pub subtitle: Option<String>,
    /// The declared no-egress flag (a UI badge this pass).
    pub local_only: bool,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Its presence is what [`AppRecord::smart`] reports.
    pub client_id: Option<String>,
    /// The loopback TCP port the host binds this app on, combined with the
    /// loopback hostname at read time into the `http://{host}:{port}/` launch
    /// target. Mapped to/from the `INTEGER` column via
    /// [`PortColumn`](crate::db::columns::PortColumn). The column keeps the port
    /// stable across reinstalls — see the port-allocation section of
    /// `docs/Apps/Store and Install Explanation.md`.
    #[diesel(serialize_as = PortColumn, deserialize_as = PortColumn)]
    pub port: u16,
    /// The on-disk subdirectory (under the host's `self-hosted-apps/` dir) whose
    /// files this app serves, e.g. `patient-browser`. Explicit rather than
    /// derived from the app id, so the content location is decoupled from
    /// identity.
    pub content_folder: String,
    /// The public subdomain label this app is reachable at remotely, rendered as
    /// `https://{subdomain}.{public_host}/` by [`Self::subdomain_url`] and used as
    /// the reverse-proxy routing key. Explicit rather than derived from the id.
    pub subdomain: String,
    /// `true` for a migration-seeded app (delete is refused with
    /// `409 AppNotEditable`), `false` for one uploaded at runtime (removable).
    pub seeded: bool,
    /// The origin-relative launch path inferred at install (see
    /// `crate::install::infer_launch_path`), or `None` for a root-served
    /// (`index.html`) bundle. When present it's a SMART launcher template with the
    /// same `{origin}` / `{launch}` placeholders the cloud `url` uses, substituted
    /// per request by [`Self::render_launch`]. See `docs/Apps/Explanation.md`.
    pub launch_path: Option<String>,
}

impl AppRecord for SelfHostedApp {
    /// A self-hosted app is a SMART app iff it carries a `client_id`.
    fn smart(&self) -> bool {
        self.client_id.is_some()
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
    /// subdomain reverse proxy (which splits inbound forwarded hosts via the same
    /// module's `try_split_subdomain`) and this redirect can't drift on the
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

#[cfg(test)]
mod tests {
    use super::*;

    fn app(launch_path: Option<&str>) -> SelfHostedApp {
        SelfHostedApp {
            id: "zip-app".to_owned(),
            name: "Zip App".to_owned(),
            subtitle: None,
            local_only: true,
            client_id: None,
            port: 8082,
            content_folder: "zip-app".to_owned(),
            subdomain: "zip-app".to_owned(),
            seeded: false,
            launch_path: launch_path.map(str::to_owned),
        }
    }

    /// With no launcher the target is the bare origin — the app's root, which
    /// ServeDir resolves to `index.html`. Unchanged from before the field.
    #[test]
    fn render_launch_without_template_is_the_bare_origin() {
        let app = app(None);
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
        let app = app(Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"));
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
        let app = app(Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"));
        let base = app.subdomain_url("demo.example.com");
        assert_eq!(
            app.render_launch(&base, "https://demo.example.com", "N"),
            "https://zip-app.demo.example.com/launch.html?launch=N&iss=https://demo.example.com/fhir-r4",
        );
    }

    /// `smart` follows `client_id`; `removable` is exactly "not seeded".
    #[test]
    fn capability_verdicts_follow_client_id_and_seeded() {
        let mut uploaded = app(None);
        assert!(!uploaded.smart());
        assert!(uploaded.removable(), "an uploaded app is removable");
        uploaded.client_id = Some("client".to_owned());
        assert!(uploaded.smart());

        let mut seeded = app(None);
        seeded.seeded = true;
        assert!(!seeded.removable(), "a seeded app is protected");
    }
}
