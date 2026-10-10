//! The shared apps runtime state — the router state every handler is built over,
//! and the composition point that names the concrete [`SqliteAppsStore`] adapter.
//! It also holds the public origin every launch's `{origin}` resolves to, the
//! on-device webview seam, and the host-seam ports (per-app launch scopes, launch
//! contexts).
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
use crate::ports::{AppLaunchScopes, LaunchContextMinter};
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
    /// The server's public origin. Every launch resolves `{origin}` to it
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
    /// Mints the SMART `launch` value a SMART app's launch URL carries (see
    /// [`LaunchContextMinter`]). The host wires a gatekeeper-backed adapter;
    /// tests use a fake.
    pub(crate) launch_context_minter: Arc<dyn LaunchContextMinter>,
}

impl AppsState {
    #[must_use]
    pub fn new(
        store: SqliteAppsStore,
        public_origin: Url,
        webview_handle: Arc<dyn OnDeviceWebviewHandle>,
        launch_scopes: Arc<dyn AppLaunchScopes>,
        launch_context_minter: Arc<dyn LaunchContextMinter>,
    ) -> Self {
        Self {
            store,
            public_origin,
            on_device_webview_handle: webview_handle,
            launch_scopes,
            launch_context_minter,
        }
    }

    /// The public origin string for a launch's `{origin}` —
    /// e.g. `https://ruth.relay.wildflowerhealth.io` (no trailing slash).
    pub(crate) fn public_origin(&self) -> String {
        wildflowerhealthio_shared_structures::origin_string(&self.public_origin)
    }
}
