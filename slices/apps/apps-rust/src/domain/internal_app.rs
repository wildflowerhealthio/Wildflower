//! `InternalApp` — a static, locally-served app whose launch target is a
//! dedicated loopback origin owned by the host. One row per internal app.
//!
//! Internal apps are **not** editable through the public `/apps` admin
//! surface: the table has no `url` column for the wire to write, and the
//! host is what binds the listener that serves the files. The seed migration
//! is the only writer today; future internals land as additional migrations.
//!
//! At read time the apps slice materializes an internal row into the wire
//! shape ([`AppEntry`](super::AppEntry)) by building `http://{host}:{port}/`
//! from [`AppsConfig::internal_apps_loopback_host`](crate::AppsConfig) and
//! the row's `port`. The wire DTO stays the one shared shape; the "internal
//! vs external" distinction is a storage-side fact.
//!
//! `requires_tunnel` doesn't apply — internal apps are loopback-only by
//! construction.

use serde::{Deserialize, Serialize};

use super::{AppEntry, AppUrl};

/// A locally-served app: the row carries the catalogue fields plus the
/// dedicated loopback `port` the host serves it on. Field names match the
/// SQL column names so `sql_row!` in the `db/` layer can derive
/// `TryFrom<&Row>` and the named-param array off the same struct
/// definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternalApp {
    /// Stable id — also the on-disk subdirectory name under the host's
    /// `installed-apps/` dir (e.g. `patient-browser`).
    pub id: String,
    pub enabled: bool,
    pub name: String,
    /// The descriptive line shown under the app's name. `None` means the
    /// row has no explicit subtitle.
    pub subtitle: Option<String>,
    /// The loopback TCP port the host binds this app on. Combined with the
    /// host-supplied loopback hostname at read time to produce the
    /// `http://{host}:{port}/` launch target. The host is the source of
    /// truth for the binding; the column makes the port stable across
    /// reinstalls (a SMART-on-FHIR origin-stability property).
    pub port: u16,
}

impl InternalApp {
    /// Render the loopback launch target `http://{host}:{port}/`. `host` is
    /// the loopback hostname the host binds on (from
    /// [`AppsConfig::internal_apps_loopback_host`](crate::AppsConfig)). The
    /// path is the bare root: each internal app gets its own origin and is
    /// served from `/` on it.
    #[must_use]
    pub fn launch_url(&self, host: &str) -> String {
        format!("http://{host}:{port}/", host = host, port = self.port)
    }

    /// Render the public subdomain launch target
    /// `https://{id}.{public_host}/` — the URL a forwarded (remote) caller
    /// can actually reach. Delegates to the shared
    /// [`shared_structures_rust::subdomain_host::subdomain_url`] so the host's
    /// subdomain dispatch (which matches inbound forwarded requests via the
    /// same module's `match_subdomain`) and this redirect can't drift on the
    /// `<id>.<public_host>` shape.
    #[must_use]
    pub fn subdomain_url(&self, public_host: &str) -> String {
        shared_structures_rust::subdomain_host::subdomain_url(&self.id, public_host)
    }

    /// Materialize as the shared wire DTO so `GET /apps` can return
    /// internals and externals in one uniform list. `requires_tunnel` is
    /// always false (internal apps are loopback-only). The `url` is built
    /// via [`Self::launch_url`] and stored as an [`AppUrl::External`]
    /// holding the loopback http string — see [`AppUrl::External`]'s
    /// docstring for why that variant is used directly rather than parsed.
    #[must_use]
    pub fn to_app_entry(&self, host: &str) -> AppEntry {
        AppEntry {
            id: self.id.clone(),
            enabled: self.enabled,
            name: self.name.clone(),
            subtitle: self.subtitle.clone(),
            url: AppUrl::External(self.launch_url(host)),
            requires_tunnel: false,
        }
    }
}
