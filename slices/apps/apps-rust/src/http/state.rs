//! Shared HTTP state — the store handle, the loopback origin used to build
//! launch URLs, and the tunnel-launch resolver port.

use std::sync::Arc;

use crate::db::AppsStore;
use crate::tunnel_seam::TunnelLaunchResolver;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    pub(crate) store: AppsStore,
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down. `LaunchApp` redirects non-tunnel apps here; a `requiresTunnel`
    /// launch that can't reach the tunnel falls back here with
    /// `?tunnel=unavailable` so the SPA can surface a banner.
    pub(crate) loopback_origin: String,
    /// Resolves a `requires_tunnel` launch to the live verified public origin.
    /// The host wires the real tunnel control seam; tests use
    /// [`crate::tunnel_seam::TunnelUnavailable`].
    pub(crate) tunnel: Arc<dyn TunnelLaunchResolver>,
}

impl AppsState {
    pub fn new(
        store: AppsStore,
        loopback_origin: impl Into<String>,
        tunnel: Arc<dyn TunnelLaunchResolver>,
    ) -> Self {
        Self {
            store,
            loopback_origin: loopback_origin.into(),
            tunnel,
        }
    }
}
