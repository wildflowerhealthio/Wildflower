//! Open-time configuration for the apps slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_apps`](crate::setup_apps), not via this config.

use url::Url;

/// What [`setup_apps`](crate::setup_apps) needs to stand up the slice: the
/// origin a launch's `{origin}` resolves to (see
/// [`AppsState`](crate::live_bindings::state::AppsState)).
#[derive(Debug, Clone)]
pub struct AppsConfig {
    /// e.g. `https://ruth.relay.wildflowerhealth.io` — the server's public
    /// origin, from its domain. Every launch resolves `{origin}` to it.
    pub public_origin: Url,
}
