//! `InternalApp` — a static, locally-served app whose launch target is a
//! dedicated loopback origin owned by the host. One row per internal app.
//!
//! Internal apps are **not** editable through the public `/apps` admin
//! surface: the table has no `url` column for the wire to write, and the
//! host is what binds the listener that serves the files. The seed migration
//! is the only writer today; future internals land as additional migrations.
//!
//! The launch URL is rendered on demand via [`Self::launch_url`] /
//! [`Self::subdomain_url`] (the "internal vs external" distinction is a
//! storage-side fact); `GET /apps` projects the row via [`Self::to_list_entry`].
//! `requires_tunnel` doesn't apply — internal apps are loopback-only by
//! construction.

use serde::{Deserialize, Serialize};

use super::AppListEntry;

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
    /// [`AppsConfig::loopback_hostname`](crate::AppsConfig)). The
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
    /// subdomain reverse proxy (which splits inbound forwarded hosts via the
    /// same module's `try_split_subdomain`) and this redirect can't drift on the
    /// `<id>.<public_host>` shape.
    #[must_use]
    pub fn subdomain_url(&self, public_host: &str) -> String {
        shared_structures_rust::subdomain_host::subdomain_url(&self.id, public_host)
    }

    /// Project to the `GET /apps` catalogue row ([`AppListEntry`]) so internals
    /// and externals return in one uniform list. The list row carries **no**
    /// launch `url` — the launch endpoint resolves the real, provenance-aware
    /// target at request time — so this builds the projection directly rather
    /// than materializing a placeholder [`AppUrl`](super::AppUrl) every caller
    /// would discard. `requires_tunnel` is always false (internal apps are
    /// loopback-only).
    #[must_use]
    pub fn to_list_entry(&self) -> AppListEntry {
        AppListEntry {
            id: self.id.clone(),
            enabled: self.enabled,
            name: self.name.clone(),
            subtitle: self.subtitle.clone(),
            requires_tunnel: false,
        }
    }
}
