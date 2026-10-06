//! The shared apps runtime state — the router state every handler is built over,
//! and the composition point that names the concrete [`SqliteAppsStore`] adapter.
//! It also holds the loopback base URL the non-tunnel launch origin derives from,
//! the public origin a `requires_tunnel` launch resolves to, the on-device
//! webview seam, and the host-seam port (per-app launch scopes).
//!
//! It lives at the crate root (not under [`crate::http`]) deliberately: the
//! scope-gated [`capabilities`](crate::domain::capabilities) in `domain/` are
//! built from it through the per-capability bindings in the parent
//! [`live_bindings`](super) module, and `domain/` must not depend on
//! `crate::http` (gatekeeper/databases style; see
//! `docs/Authorization/Scope-Gated Endpoints How-To.md`).

use std::sync::Arc;

use url::Url;

use crate::db::SqliteAppsStore;
use crate::ports::AppLaunchScopes;
use crate::OnDeviceWebviewHandle;

/// Shared state threaded through the apps handlers. Holds the **concrete**
/// [`SqliteAppsStore`] adapter (not `Arc<dyn AppsStore>` or a generic): the port
/// abstraction is the [`crate::domain::AppsStore`] trait the capabilities are
/// generic over, so the state and axum wiring stay monomorphic. Held in an `Arc` and extracted via
/// `State<Arc<AppsState>>` (launch glue) or lifted into a `Scoped<…>` capability
/// (every data-touching admin handler) per the tunnel-rust / gatekeeper pattern.
pub struct AppsState {
    /// The apps store — serves the `app_registrations` registry.
    pub(crate) store: SqliteAppsStore,
    /// The base URL a loopback caller reaches the server at. The non-tunnel
    /// loopback launch origin ([`Self::loopback_origin`]) derives from it.
    pub(crate) loopback_base_url: Url,
    /// The server's public origin. A `requires_tunnel` launch resolves to it
    /// ([`Self::public_origin`]).
    pub(crate) public_origin: Url,
    /// The on-device launch seam — a loopback launch hands the resolved URL to
    /// it (the Tauri host opens a native webview popup). A host with no native
    /// popup supplies a no-op handle (only forwarded callers reach such a host,
    /// so it's never invoked).
    pub(crate) on_device_webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    /// Resolves a **SMART** app's required launch scopes (its OAuth client's
    /// allowed scopes) for the per-app launch check (see [`AppLaunchScopes`]). The
    /// host wires a gatekeeper-backed adapter; tests use a fake / no-op.
    pub(crate) launch_scopes: Arc<dyn AppLaunchScopes>,
}

impl AppsState {
    #[must_use]
    pub fn new(
        store: SqliteAppsStore,
        loopback_base_url: Url,
        public_origin: Url,
        webview_handle: Arc<dyn OnDeviceWebviewHandle>,
        launch_scopes: Arc<dyn AppLaunchScopes>,
    ) -> Self {
        Self {
            store,
            loopback_base_url,
            public_origin,
            on_device_webview_handle: webview_handle,
            launch_scopes,
        }
    }

    /// The loopback origin string for a non-tunnel loopback launch's `{origin}`
    /// — e.g. `http://127.0.0.1:8080` (no trailing slash). Derived from
    /// [`Self::loopback_base_url`].
    pub(crate) fn loopback_origin(&self) -> String {
        shared_structures_rust::origin_string(&self.loopback_base_url)
    }

    /// The public origin string for a `requires_tunnel` launch's `{origin}` —
    /// e.g. `https://ruth.relay.wildflowerhealth.io` (no trailing slash).
    pub(crate) fn public_origin(&self) -> String {
        shared_structures_rust::origin_string(&self.public_origin)
    }
}
