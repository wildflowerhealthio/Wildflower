//! Shared HTTP state — the store handle, the loopback origin used to build
//! launch URLs, and the tunnel-launch resolver port.

use std::sync::Arc;

use shared_structures_rust::tunnel_service::TunnelService;

use crate::db::AppsStore;
use crate::LaunchSink;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    pub(crate) store: AppsStore,
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down. `LaunchApp` redirects non-tunnel apps here; a `requiresTunnel`
    /// launch that can't reach the tunnel falls back here with
    /// `?tunnel=unavailable` so the SPA can surface a banner.
    pub(crate) loopback_origin: String,
    /// The tunnel service a `requires_tunnel` launch resolves its origin
    /// through. The host wires the real tunnel slice; tests use a stub.
    pub(crate) tunnel: Arc<dyn TunnelService>,
    /// Optional launch side-effect seam. When present (the Tauri host), a
    /// launch hands the resolved URL to the sink and `204`s instead of
    /// returning a `302`. `None` (web/standalone) keeps the redirect path.
    pub(crate) launch_sink: Option<Arc<dyn LaunchSink>>,
}

impl AppsState {
    pub fn new(
        store: AppsStore,
        loopback_origin: impl Into<String>,
        tunnel: Arc<dyn TunnelService>,
    ) -> Self {
        Self {
            store,
            loopback_origin: loopback_origin.into(),
            tunnel,
            launch_sink: None,
        }
    }

    /// Install the host's [`LaunchSink`] — a launch then opens the resolved
    /// URL through the sink and `204`s rather than returning a `302`.
    #[must_use]
    pub fn with_launch_sink(mut self, sink: Arc<dyn LaunchSink>) -> Self {
        self.launch_sink = Some(sink);
        self
    }
}
