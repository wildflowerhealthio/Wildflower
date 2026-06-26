//! Shared HTTP state — the store handle (serving both apps tables), the
//! loopback origin used to build launch URLs, the loopback hostname the
//! internal-app listeners bind on, and the tunnel-launch resolver.

use std::sync::Arc;

use shared_structures_rust::tunnel_service::TunnelService;

use crate::db::AppsStore;
use crate::OnDeviceWebviewHandle;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    /// The apps store — serves both the externals (`apps`, read + write through
    /// the admin API) and the read-only internals (`internal_apps`, seeded by
    /// migration).
    pub(crate) store: AppsStore,
    /// e.g. `http://127.0.0.1:8080` — the origin clients reach when the tunnel
    /// is down. `LaunchApp` redirects non-tunnel apps here. A `requires_tunnel`
    /// launch that can't reach the tunnel does **not** fall back here — there's
    /// no reachable origin for it, so the launch fails with
    /// `503 LaunchUnavailable` instead.
    pub(crate) loopback_origin: String,
    /// Hostname portion (no scheme, no port) the host binds each internal-app
    /// listener on — combined with each internal row's `port` to render the
    /// `http://{hostname}:{port}/` launch target.
    pub(crate) loopback_hostname: String,
    /// The tunnel service a `requires_tunnel` launch resolves its origin
    /// through. The host wires the real tunnel slice; tests use a stub.
    pub(crate) tunnel: Arc<dyn TunnelService>,
    /// The on-device launch seam. A loopback launch hands the resolved URL to it
    /// (the Tauri host opens a native webview popup) and `204`s; a forwarded
    /// launch redirects instead. A host with no native popup supplies a no-op
    /// handle (only forwarded callers reach such a host, so it's never invoked).
    pub(crate) on_device_webview_handle: Arc<dyn OnDeviceWebviewHandle>,
}

impl AppsState {
    pub fn new(
        store: AppsStore,
        loopback_origin: impl Into<String>,
        loopback_hostname: impl Into<String>,
        tunnel: Arc<dyn TunnelService>,
        webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    ) -> Self {
        Self {
            store,
            loopback_origin: loopback_origin.into(),
            loopback_hostname: loopback_hostname.into(),
            tunnel,
            on_device_webview_handle: webview_handle,
        }
    }
}
