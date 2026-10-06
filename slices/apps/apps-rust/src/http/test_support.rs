//! Shared fixtures for the `/apps` handler tests — the route modules build
//! state the same way, so it lives here rather than being copied into each. Request-builder helpers (`post`/`get`/…) stay per-test
//! module.

use std::sync::Arc;

use scopes_rust::Scope;
use shared_structures_rust::test_utils::RecordingStubWebviewHandle;
use url::Url;

use crate::db::SqliteAppsStore;
use crate::domain::{AppRegistration, AppsError};
use crate::live_bindings::state::AppsState;
use crate::ports::{AppLaunchScopes, NoAppLaunchScopes};
use crate::OnDeviceWebviewHandle;

/// The server's public origin, which every launch's `{origin}` resolves to.
pub(crate) const PUBLIC_ORIGIN: &str = "https://dev1.example.com";

/// An [`AppLaunchScopes`] fake that requires a fixed scope set for any SMART app —
/// drives the per-app SMART launch check. The launch capability only consults it
/// for a SMART app (a `client_id`), so a non-SMART launch never reaches it.
pub(crate) struct FixedLaunchScopes {
    required: Vec<Scope>,
}

impl FixedLaunchScopes {
    /// Requires the given (space-separated) scopes for every SMART launch.
    pub(crate) fn requiring(scopes: &str) -> Arc<dyn AppLaunchScopes> {
        Arc::new(FixedLaunchScopes {
            required: scopes.split_whitespace().map(Scope::from).collect(),
        })
    }
}

impl AppLaunchScopes for FixedLaunchScopes {
    fn required_scopes(&self, _registration: &AppRegistration) -> Result<Vec<Scope>, AppsError> {
        Ok(self.required.clone())
    }
}

/// Build apps state over a fresh in-memory store with a specific on-device
/// webview handle and launch-scope seam, using the shared public origin. The most general fixture; the others below pin one of the
/// knobs.
pub(crate) fn state_full(
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    launch_scopes: Arc<dyn AppLaunchScopes>,
) -> Arc<AppsState> {
    let store = SqliteAppsStore::open_in_memory().expect("store");
    Arc::new(AppsState::new(
        store,
        Url::parse(PUBLIC_ORIGIN).expect("public origin is a hardcoded valid URL"),
        webview_handle,
        launch_scopes,
    ))
}

/// Apps state with a throwaway recording handle — for tests that don't inspect
/// what the handle received.
pub(crate) fn state() -> Arc<AppsState> {
    state_with_sink(Arc::new(RecordingStubWebviewHandle::default()))
}

/// Apps state with a caller-provided handle — so a loopback launch's resolved
/// URL can be read back off the handle.
pub(crate) fn state_with_sink(webview_handle: Arc<dyn OnDeviceWebviewHandle>) -> Arc<AppsState> {
    state_full(webview_handle, Arc::new(NoAppLaunchScopes))
}

/// Apps state with a caller-provided handle and a specific [`AppLaunchScopes`]
/// seam — drives the per-app SMART launch check.
pub(crate) fn state_with_launch_scopes(
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    launch_scopes: Arc<dyn AppLaunchScopes>,
) -> Arc<AppsState> {
    state_full(webview_handle, launch_scopes)
}
