//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_tunnel`](crate::setup_tunnel), not via this config.

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// loopback origin used as the `servedOrigin` fallback and the loopback port the
/// tunnel forwards.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down.
    pub loopback_origin: String,
    /// The loopback server port the tunnel forwards to the relay.
    pub local_port: u16,
}
