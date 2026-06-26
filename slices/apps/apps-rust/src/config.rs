//! Open-time configuration for the apps slice, mirroring
//! `tunnel-rust`'s `TunnelConfig` and `gatekeeper-rust`'s
//! `GatekeeperConfig`. The shared database is passed separately into
//! [`setup_apps`](crate::setup_apps), not via this config.

/// What [`setup_apps`](crate::setup_apps) needs to stand up the slice: the
/// loopback origin used as the non-tunnel launch redirect target, plus the
/// loopback hostname the internal-apps listeners bind on.
#[derive(Debug, Clone, Default)]
pub struct AppsConfig {
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the
    /// tunnel is down; a non-tunnel launch redirects here.
    pub loopback_origin: String,
    /// The hostname portion (no scheme, no port) the host binds each
    /// internal-app listener on — e.g. `127.0.0.1`. The apps slice combines
    /// it with each internal-app row's `port` to render the launch target
    /// (`http://{hostname}:{port}/`). The host is the source of truth; the
    /// slice does not parse [`Self::loopback_origin`] to derive it because the
    /// host already has the canonical value (it binds the listeners).
    pub loopback_hostname: String,
}
