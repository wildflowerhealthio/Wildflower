//! `SelfHostedApp` — the `self_hosted_apps` child row: a locally-served app's
//! dedicated loopback `port`. The catalogue fields (name / subtitle / enabled)
//! live on the parent [`App`](super::App) registry row; this child carries only
//! what the launch handler needs to render the loopback / subdomain target.
//!
//! Not editable through the cloud-admin surface — the host binds the listener
//! that serves the files, and the migration is the only writer. The launch URL
//! is rendered on demand via [`Self::launch_url`] / [`Self::subdomain_url`].

/// A locally-served app's loopback binding. Field names match the SQL column
/// names so `sql_row!` in the `db/` layer derives `TryFrom<&Row>` off the same
/// struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedApp {
    /// Stable id — also the on-disk subdirectory name under the host's
    /// `installed-apps/` dir (e.g. `patient-browser`). Matches the parent
    /// registry row's id.
    pub id: String,
    /// The loopback TCP port the host binds this app on. Combined with the
    /// host-supplied loopback hostname at read time to produce the
    /// `http://{host}:{port}/` launch target. The host is the source of truth
    /// for the binding; the column makes the port stable across reinstalls (a
    /// SMART-on-FHIR origin-stability property).
    pub port: u16,
}

impl SelfHostedApp {
    /// Render the loopback launch target `http://{host}:{port}/`. `host` is the
    /// loopback hostname the host binds on. The path is the bare root: each
    /// self-hosted app gets its own origin and is served from `/` on it.
    #[must_use]
    pub fn launch_url(&self, host: &str) -> String {
        format!("http://{host}:{port}/", host = host, port = self.port)
    }

    /// Render the public subdomain launch target `https://{id}.{public_host}/` —
    /// the URL a forwarded (remote) caller can actually reach. Delegates to the
    /// shared [`shared_structures_rust::subdomain_host::subdomain_url`] so the
    /// host's subdomain reverse proxy (which splits inbound forwarded hosts via
    /// the same module's `try_split_subdomain`) and this redirect can't drift on
    /// the `<id>.<public_host>` shape.
    #[must_use]
    pub fn subdomain_url(&self, public_host: &str) -> String {
        shared_structures_rust::subdomain_host::subdomain_url(&self.id, public_host)
    }
}
