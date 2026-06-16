//! Open-time configuration for the apps slice, mirroring
//! `tunnel-rust`'s `TunnelConfig` and `gatekeeper-rust`'s
//! `GatekeeperConfig`. The shared database is passed separately into
//! [`setup_apps`](crate::setup_apps), not via this config.

/// What [`setup_apps`](crate::setup_apps) needs to stand up the slice: the
/// loopback origin used as the launch redirect target (until a real tunnel
/// seam reads `servedOrigin` from tunnel-rust).
#[derive(Debug, Clone, Default)]
pub struct AppsConfig {
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the
    /// tunnel is down. Used by `LaunchApp` to build redirect targets and to
    /// validate that a resolved custom-app URL is launchable.
    pub loopback_origin: String,
}
