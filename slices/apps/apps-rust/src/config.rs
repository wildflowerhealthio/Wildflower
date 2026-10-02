//! Open-time configuration for the apps slice, mirroring
//! `tunnel-rust`'s `TunnelConfig` and `gatekeeper-rust`'s
//! `GatekeeperConfig`. The shared database is passed separately into
//! [`setup_apps`](crate::setup_apps), not via this config.

use url::Url;

/// What [`setup_apps`](crate::setup_apps) needs to stand up the slice: the
/// loopback base URL clients reach when the tunnel is down. The launch handler
/// derives the non-tunnel redirect *origin* from it (see
/// [`AppsState::loopback_origin`](crate::live_bindings::state::AppsState)).
#[derive(Debug, Clone)]
pub struct AppsConfig {
    /// e.g. `http://127.0.0.1:8080/` — the base URL clients reach when the
    /// tunnel is down. A non-tunnel launch resolves `{origin}` to its origin.
    pub loopback_base_url: Url,
}
