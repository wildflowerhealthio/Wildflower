//! Shared HTTP state — the two store handles, the loopback origin used to
//! build launch URLs, the host portion the internal-app listeners bind on,
//! and the tunnel-launch resolver.

use std::sync::Arc;

use shared_structures_rust::tunnel_service::TunnelService;

use crate::db::{AppsStore, InternalAppsStore};
use crate::LaunchSink;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    /// The externals catalogue — read + write, editable through the admin
    /// API.
    pub(crate) store: AppsStore,
    /// The internals catalogue — read-only at runtime, seeded by migration.
    pub(crate) internal_apps: InternalAppsStore,
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down. `LaunchApp` redirects non-tunnel apps here; a `requiresTunnel`
    /// launch that can't reach the tunnel falls back here with
    /// `?tunnel=unavailable` so the SPA can surface a banner.
    pub(crate) loopback_origin: String,
    /// Host portion (no scheme, no port) the host binds each internal-app
    /// listener on — combined with each internal row's `port` to render the
    /// `http://{host}:{port}/` launch target.
    pub(crate) internal_apps_loopback_host: String,
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
        internal_apps: InternalAppsStore,
        loopback_origin: impl Into<String>,
        internal_apps_loopback_host: impl Into<String>,
        tunnel: Arc<dyn TunnelService>,
    ) -> Self {
        Self {
            store,
            internal_apps,
            loopback_origin: loopback_origin.into(),
            internal_apps_loopback_host: internal_apps_loopback_host.into(),
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
