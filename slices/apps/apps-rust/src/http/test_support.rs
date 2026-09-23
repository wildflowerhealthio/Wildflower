//! Shared fixtures for the `/apps` handler tests — the route modules build
//! state and tunnel stubs the same way, so those live here rather than being
//! copied into each. Request-builder helpers (`post`/`get`/…) stay per-test
//! module.

use std::sync::Arc;

use async_trait::async_trait;
use scopes_rust::Scope;
use shared_structures_rust::test_utils::RecordingStubWebviewHandle;
use shared_structures_rust::tunnel_service::{
    OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
};
use shared_structures_server_rust::ProxyTable;
use url::Url;

use crate::db::SqliteAppsStore;
use crate::domain::{AppRegistration, AppsError};
use crate::live_bindings::state::AppsState;
use crate::ports::{AppLaunchScopes, NoAppLaunchScopes};
use crate::self_hosted_apps_service::SelfHostedAppsService;
use crate::OnDeviceWebviewHandle;

/// The loopback base URL clients reach when the tunnel is down. Its origin
/// (`http://127.0.0.1:8080`) drives `{origin}` substitution and its host
/// (`127.0.0.1`) the self-hosted launch target.
pub(crate) const LOOPBACK_BASE_URL: &str = "http://127.0.0.1:8080/";

/// Parse the fixed loopback base URL — a hardcoded valid URL.
pub(crate) fn loopback_base_url() -> Url {
    Url::parse(LOOPBACK_BASE_URL).expect("loopback base url is a hardcoded valid URL")
}

/// A `TunnelService` stub for a tunnel that's up and verified at `origin` — the
/// success counterpart to the shared [`OfflineTunnel`], which models the
/// can't-reach case (`try_start` fails, state stays `Off`). `public_host` is
/// reported through [`TunnelService::current_public_host`] — the self-hosted
/// launch handler reads it to render the subdomain URL for forwarded callers.
pub(crate) struct StubTunnel {
    origin: String,
    public_host: Option<String>,
}

#[async_trait]
impl TunnelService for StubTunnel {
    fn current_origin(&self) -> String {
        self.origin.clone()
    }
    fn current_public_host(&self) -> Option<String> {
        self.public_host.clone()
    }
    async fn try_start(&self) -> Result<String, String> {
        Ok(self.origin.clone())
    }
    fn subscribe(&self) -> tokio::sync::watch::Receiver<TunnelLiveness> {
        tokio::sync::watch::channel(TunnelLiveness {
            settings_revision: None,
            status: TunnelStatus::Verified,
            origin: self.origin.clone(),
            public_host: self.public_host.clone(),
            error: None,
            dial_attempts: 0,
        })
        .1
    }
}

pub(crate) fn tunnel_at(origin: &str) -> Arc<dyn TunnelService> {
    Arc::new(StubTunnel {
        origin: origin.to_string(),
        public_host: None,
    })
}

/// `TunnelService` with a configured `public_host` but no `try_start` success —
/// the live shape that drives the self-hosted launch's subdomain branch
/// (forwarded caller → `https://<id>.<host>/`) without needing the tunnel up.
pub(crate) fn tunnel_with_public_host(public_host: &str) -> Arc<dyn TunnelService> {
    Arc::new(StubTunnel {
        origin: "http://127.0.0.1:8080".to_owned(),
        public_host: Some(public_host.to_owned()),
    })
}

pub(crate) fn tunnel_unavailable() -> Arc<dyn TunnelService> {
    Arc::new(OfflineTunnel::new("http://127.0.0.1:8080"))
}

/// A `SelfHostedAppsService` over a fresh per-test temp apps dir, a fresh
/// `ProxyTable`, and the given tunnel — enough for the upload/delete handlers to
/// stage files and start/stop listeners. The temp dir is unique per call so
/// parallel tests don't share a staging root; it's left for the OS to reap.
pub(crate) fn self_hosted_service(tunnel: Arc<dyn TunnelService>) -> Arc<SelfHostedAppsService> {
    let apps_dir = std::env::temp_dir().join(format!("wf-apps-test-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&apps_dir).expect("create temp apps dir");
    Arc::new(SelfHostedAppsService::new(
        &loopback_base_url(),
        apps_dir,
        ProxyTable::new(),
        tunnel,
    ))
}

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

/// Build apps state over a fresh in-memory store with a specific `tunnel`,
/// on-device webview handle, and launch-scope seam, using the
/// shared loopback base URL. The most general fixture; the others below pin one or
/// two of the knobs.
pub(crate) fn state_full(
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    launch_scopes: Arc<dyn AppLaunchScopes>,
) -> Arc<AppsState> {
    let store = SqliteAppsStore::open_in_memory().expect("store");
    let self_hosted = self_hosted_service(Arc::clone(&tunnel));
    Arc::new(AppsState::new(
        store,
        loopback_base_url(),
        tunnel,
        webview_handle,
        self_hosted,
        launch_scopes,
    ))
}

/// Apps state with a specific `tunnel` + on-device handle. Lets a test drive the
/// tunnel branch and assert what the handle received for a loopback launch.
pub(crate) fn state_with_tunnel_and_handle(
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
) -> Arc<AppsState> {
    state_full(tunnel, webview_handle, Arc::new(NoAppLaunchScopes))
}

/// Apps state with the given tunnel and a throwaway recording handle — for tests
/// that don't inspect what the handle received.
pub(crate) fn state_with_tunnel(tunnel: Arc<dyn TunnelService>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel, Arc::new(RecordingStubWebviewHandle::default()))
}

/// Apps state with the offline tunnel — the default for tests that don't exercise
/// the tunnel branch.
pub(crate) fn state() -> Arc<AppsState> {
    state_with_tunnel(tunnel_unavailable())
}

/// Apps state with the offline tunnel and a caller-provided handle — so a loopback
/// launch's resolved URL can be read back off the handle.
pub(crate) fn state_with_sink(webview_handle: Arc<dyn OnDeviceWebviewHandle>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel_unavailable(), webview_handle)
}

/// Apps state with the offline tunnel, a caller-provided handle, and a specific
/// [`AppLaunchScopes`] seam — drives the per-app SMART launch check.
pub(crate) fn state_with_launch_scopes(
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    launch_scopes: Arc<dyn AppLaunchScopes>,
) -> Arc<AppsState> {
    state_full(tunnel_unavailable(), webview_handle, launch_scopes)
}
