//! `SelfHostedApp` — the `self_hosted_apps` child row: a locally-served app's
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
pub struct SelfHostedApp {
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
}
