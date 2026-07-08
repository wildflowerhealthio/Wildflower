//! Shared HTTP state — the store handle (serving every apps table), the
//! loopback base URL the non-tunnel launch origin + self-hosted hostname derive
//! from, the owner-auth gate for loopback launches, the tunnel-launch resolver,
//! and the on-device webview seam.

use std::sync::Arc;

use shared_structures_rust::tunnel_service::TunnelService;
use url::Url;

use crate::db::AppsStore;
use crate::http::launch_cookies::LaunchCookies;
use crate::http::owner_auth::OwnerAuth;
use crate::OnDeviceWebviewHandle;

/// Shared state threaded through the apps handlers. Held in an `Arc` and
/// extracted via `State<Arc<AppsState>>` per the tunnel-rust pattern.
pub struct AppsState {
    /// The apps store — serves the parent registry plus the cloud + self-hosted
    /// children.
    pub(crate) store: AppsStore,
    /// The base URL clients reach when the tunnel is down. The non-tunnel launch
    /// origin ([`Self::loopback_origin`]) and the self-hosted listeners' hostname
    /// ([`Self::loopback_hostname`]) both derive from it, so they can't drift. A
    /// `requires_tunnel` launch does **not** fall back here (it fails `503`
    /// instead — there's no reachable origin for it).
    pub(crate) loopback_base_url: Url,
    /// Authorizes a loopback launch (the on-device popup is an owner-only
    /// side-effect). A forwarded launch skips this; see [`OwnerAuth`].
    pub(crate) owner_auth: Arc<dyn OwnerAuth>,
    /// The tunnel service a `requires_tunnel` launch resolves its origin
    /// through. The host wires the real tunnel slice; tests use a stub.
    pub(crate) tunnel: Arc<dyn TunnelService>,
    /// The on-device launch seam — a loopback launch hands the resolved URL to
    /// it (the Tauri host opens a native webview popup). A host with no native
    /// popup supplies a no-op handle (only forwarded callers reach such a host,
    /// so it's never invoked).
    pub(crate) on_device_webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    /// Re-scopes the caller's owner session onto a **forwarded self-hosted**
    /// app's public host, so the `302` plants a session the app's own subdomain
    /// can carry (the host-only `wf_auth` can't reach it). The host wires the
    /// gatekeeper cookie builder; a host with no cookie-auth path wires a no-op.
    pub(crate) launch_cookies: Arc<dyn LaunchCookies>,
}

impl AppsState {
    #[must_use]
    pub fn new(
        store: AppsStore,
        loopback_base_url: Url,
        owner_auth: Arc<dyn OwnerAuth>,
        tunnel: Arc<dyn TunnelService>,
        webview_handle: Arc<dyn OnDeviceWebviewHandle>,
        launch_cookies: Arc<dyn LaunchCookies>,
    ) -> Self {
        Self {
            store,
            loopback_base_url,
            owner_auth,
            tunnel,
            on_device_webview_handle: webview_handle,
            launch_cookies,
        }
    }

    /// The loopback origin string for `{origin}` substitution and the non-tunnel
    /// redirect target — e.g. `http://127.0.0.1:8080` (no trailing slash).
    /// Derived from [`Self::loopback_base_url`] so it can't drift from the
    /// hostname.
    pub(crate) fn loopback_origin(&self) -> String {
        self.loopback_base_url.origin().ascii_serialization()
    }

    /// The hostname (no scheme, no port) the self-hosted listeners bind on —
    /// e.g. `127.0.0.1`. Derived from [`Self::loopback_base_url`]. Falls back to
    /// `127.0.0.1` only if the URL somehow carries no host (a non-special scheme
    /// the loopback URL never uses).
    pub(crate) fn loopback_hostname(&self) -> String {
        self.loopback_base_url
            .host_str()
            .unwrap_or("127.0.0.1")
            .to_owned()
    }
}
