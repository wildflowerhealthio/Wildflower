//! `SelfHostedAppRow` — the `self_hosted_apps` child row: a locally-served app's
//! dedicated loopback `port`, its on-disk `content_folder`, and its public
//! `subdomain` label. The catalogue fields (name / subtitle / enabled) live on
//! the parent [`App`](super::App) registry row; this child carries only what the
//! host needs to serve the files and what the launch handler needs to render the
//! loopback / subdomain target.
//!
//! The host binds the listener that serves the files. Rows come from two
//! sources: the migration seed (`seeded = true`, protected from delete through
//! the admin surface) and runtime uploads through the create surface
//! (`seeded = false`, removable). The launch URL is rendered on demand via
//! [`Self::launch_url`] / [`Self::subdomain_url`].

/// A locally-served app's loopback binding. Field names match the SQL column
/// names so `sql_row!` in the `db/` layer derives `TryFrom<&Row>` off the same
/// struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedAppRow {
    /// Stable id, matching the parent registry row's id. Identity only — the
    /// served folder and the public subdomain are their own columns, so nothing
    /// assumes they equal the id.
    pub id: String,
    /// The loopback TCP port the host binds this app on. Combined with the
    /// host-supplied loopback hostname at read time to produce the
    /// `http://{host}:{port}/` launch target. The host is the source of truth
    /// for the binding; the column makes the port stable across reinstalls (a
    /// SMART-on-FHIR origin-stability property).
    pub port: u16,
    /// The on-disk subdirectory (under the host's `self-hosted-apps/` dir) whose
    /// files this app serves, e.g. `patient-browser`. Explicit rather than
    /// derived from `id`, so the content location is decoupled from identity.
    pub content_folder: String,
    /// The public subdomain label this app is reachable at remotely, rendered as
    /// `https://{subdomain}.{public_host}/` by [`Self::subdomain_url`] and used as
    /// the reverse-proxy routing key. Explicit rather than derived from `id`.
    pub subdomain: String,
    /// `true` for a migration-seeded app (delete is refused with
    /// `409 AppNotEditable`), `false` for one uploaded at runtime (removable).
    pub seeded: bool,
    /// The origin-relative launch path inferred at install (see
    /// `crate::install::infer_launch_path`), or `None` when the bundle ships
    /// no `launch.html` and is served from its bare root (`index.html`).
    ///
    /// When present it carries the SMART launcher path and the same
    /// `{origin}` / `{launch}` placeholders the cloud templates use — e.g.
    /// `/launch.html?launch={launch}&iss={origin}/fhir-r4`. [`Self::render_launch`]
    /// substitutes them at launch: `{origin}` is the *served* (FHIR) origin the
    /// caller reaches, while the path itself hangs off the app's *own* origin.
    pub launch_path: Option<String>,
}

impl SelfHostedAppRow {
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
    /// `app_base` is this app's own launch origin *with* its trailing slash —
    /// the loopback [`Self::launch_url`] or the [`Self::subdomain_url`] the
    /// launch handler already resolves from the request's provenance.
    /// `served_origin` is the origin the caller reaches the *host's* API on
    /// (loopback `http://127.0.0.1:8080` or the public host), substituted for
    /// `{origin}` — the FHIR `iss` target, which is a different origin from the
    /// per-app `app_base`. `launch_nonce` is substituted for `{launch}`.
    ///
    /// With no [`Self::launch_path`] the target is the bare `app_base` (the
    /// app's root → `index.html`), unchanged from before this field existed.
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

    fn app(launch_path: Option<&str>) -> SelfHostedAppRow {
        SelfHostedAppRow {
            id: "zip-app".to_owned(),
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
}
