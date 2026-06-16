//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_tunnel`](crate::setup_tunnel), not via this config.

use crate::db::SettingsSeed;

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// loopback origin used as the `servedOrigin` fallback and the loopback port the
/// tunnel forwards.
#[derive(Debug, Clone, Default)]
pub struct TunnelConfig {
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down.
    pub loopback_origin: String,
    /// The loopback server port the tunnel forwards to the relay.
    pub local_port: u16,
    /// Build-time connection defaults seeded into a fresh row at startup (only
    /// where unconfigured), so settings survive a reinstall. The composition
    /// root populates this from the build environment.
    pub seed: SettingsSeed,
}
