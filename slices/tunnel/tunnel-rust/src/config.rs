//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_tunnel`](crate::setup_tunnel), not via this config.

use tokio::sync::mpsc;
use url::Url;

use crate::domain::{SettingsSeed, TunnelConnection};

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// loopback origin used as the `servedOrigin` fallback and where the tunnel
/// hands its connections.
///
/// No `Default` — `loopback_origin` is a [`Url`], which has no meaningful
/// default; the host always constructs this with every field set.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// e.g. `http://127.0.0.1:8080/` — the origin clients reach when the tunnel
    /// is down, as a typed [`Url`]. The daemon takes its bare origin string
    /// (via [`shared_structures_rust::origin_string`]) at construction.
    pub loopback_base_url: Url,
    /// The server's tunnel listener, which the rathole client hands each
    /// tunnel connection to. It is a listener of its own, apart from the
    /// loopback API port, so the server can tell a tunnel connection from a
    /// local one by where it arrived.
    pub tunnel_connection_sender: mpsc::Sender<TunnelConnection>,
    /// Build-time connection defaults seeded into a fresh row at startup (only
    /// where unconfigured), so settings survive a reinstall. The composition
    /// root populates this from the build environment.
    pub seed: SettingsSeed,
}
