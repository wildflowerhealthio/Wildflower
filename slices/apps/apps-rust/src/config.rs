//! Open-time configuration for the apps slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_apps`](crate::setup_apps), not via this config.

use url::Url;

/// What [`setup_apps`](crate::setup_apps) needs to stand up the slice: the
/// origins a launch's `{origin}` resolves to (see
/// [`AppsState`](crate::live_bindings::state::AppsState)).
#[derive(Debug, Clone)]
pub struct AppsConfig {
    /// e.g. `http://127.0.0.1:8080/` — the base URL a loopback caller reaches
    /// the server at. A non-tunnel loopback launch resolves `{origin}` to its
    /// origin.
    pub loopback_base_url: Url,
    /// e.g. `https://ruth.relay.wildflowerhealth.io` — the server's public
    /// origin, from its domain. A `requires_tunnel` launch resolves `{origin}`
    /// to it.
    pub public_origin: Url,
}
