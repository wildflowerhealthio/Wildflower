//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_tunnel`](crate::setup_tunnel), not via this config.

use url::Url;

use crate::domain::SettingsSeed;

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// loopback origin used as the `servedOrigin` fallback and the loopback port the
/// tunnel forwards to.
///
/// No `Default` — `loopback_origin` is a [`Url`], which has no meaningful
/// default; the host always constructs this with every field set.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// e.g. `http://127.0.0.1:8080/` — the origin clients reach when the tunnel
    /// is down, as a typed [`Url`]. The daemon takes its bare origin string
    /// (via [`shared_structures_rust::origin_string`]) at construction.
    pub loopback_base_url: Url,
    /// The port of the server's tunnel listener on `127.0.0.1`, which rathole
    /// forwards each tunnel connection to. It is a listener of its own, apart
    /// from the loopback API port, so the server can tell a tunnel connection
    /// from a local one by where it arrived.
    pub tunnel_listener_port: u16,
    /// Build-time connection defaults seeded into a fresh row at startup (only
    /// where unconfigured), so settings survive a reinstall. The composition
    /// root populates this from the build environment.
    pub seed: SettingsSeed,
}
