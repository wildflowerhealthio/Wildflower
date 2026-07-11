//! Shared fixtures for the `/apps` handler tests — the route modules build
//! state and tunnel stubs the same way, so those live here rather than being
//! copied into each. Request-builder helpers (`post`/`get`/…) stay per-test
//! module.

// `StubOwnerAuth` is `#[deprecated]` to keep the no-op stub out of production
// wiring; these fixtures are exactly the sanctioned test use, so silence it.
#![allow(deprecated)]

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::http::{HeaderMap, HeaderValue};
use shared_structures_rust::test_utils::RecordingStubWebviewHandle;
use shared_structures_rust::tunnel_service::{
    OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
};
use shared_structures_server_rust::ProxyTable;
use url::Url;

use crate::db::AppsStore;
use crate::http::ports::launch_cookies::{LaunchCookies, NoLaunchCookies};
use crate::http::ports::owner_auth::{OwnerAuth, StubOwnerAuth};
use crate::http::state::AppsState;
use crate::self_hosted_apps::SelfHostedAppsService;
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

/// The `Set-Cookie` value [`RecordingLaunchCookies`] plants — a fixed sentinel a
/// test can assert lands on the launch `302` without pulling in the gatekeeper
/// cookie format (apps-rust can't depend on gatekeeper-rust).
pub(crate) const SENTINEL_SET_COOKIE: &str =
    "wf_auth=re.scoped.jwt; Domain=demo.example.com; Path=/";

/// A recording [`LaunchCookies`] double: records every `host` it is asked to
/// re-scope onto, and plants the single [`SENTINEL_SET_COOKIE`]. Lets a test
/// assert both that the launch attaches the seam's output *and* that the seam is
/// invoked for exactly the forwarded self-hosted case (its `hosts` stays empty
/// otherwise).
#[derive(Default)]
pub(crate) struct RecordingLaunchCookies {
    pub(crate) hosts: Mutex<Vec<String>>,
}

impl LaunchCookies for RecordingLaunchCookies {
    fn rescope_for_host(&self, _headers: &HeaderMap, host: &str) -> Vec<HeaderValue> {
        self.hosts
            .lock()
            .expect("hosts mutex")
            .push(host.to_owned());
        vec![HeaderValue::from_static(SENTINEL_SET_COOKIE)]
    }
}

/// Build apps state over a fresh in-memory store with a specific `tunnel`,
/// `owner_auth`, on-device webview handle, and launch-cookie seam, using the
/// shared loopback base URL. The most general fixture; the others below pin one
/// or two of the knobs.
pub(crate) fn state_full(
    owner_auth: Arc<dyn OwnerAuth>,
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    launch_cookies: Arc<dyn LaunchCookies>,
) -> Arc<AppsState> {
    let store = AppsStore::open_in_memory().expect("store");
    let self_hosted = self_hosted_service(Arc::clone(&tunnel));
    Arc::new(AppsState::new(
        store,
        loopback_base_url(),
        owner_auth,
        tunnel,
        webview_handle,
        self_hosted,
        launch_cookies,
    ))
}

/// Apps state with a specific `tunnel` + launch-cookie seam, an allow-all owner
/// gate, and a throwaway recording handle — drives the forwarded self-hosted
/// cookie-planting branch.
pub(crate) fn state_with_launch_cookies(
    tunnel: Arc<dyn TunnelService>,
    launch_cookies: Arc<dyn LaunchCookies>,
) -> Arc<AppsState> {
    state_full(
        Arc::new(StubOwnerAuth::always_allowed()),
        tunnel,
        Arc::new(RecordingStubWebviewHandle::default()),
        launch_cookies,
    )
}

/// Apps state with a specific `tunnel` + on-device handle and an allow-all owner
/// gate. Lets a test drive the tunnel branch and assert what the handle received
/// for a loopback launch.
pub(crate) fn state_with_tunnel_and_handle(
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
) -> Arc<AppsState> {
    state_full(
        Arc::new(StubOwnerAuth::always_allowed()),
        tunnel,
        webview_handle,
        Arc::new(NoLaunchCookies),
    )
}

/// Apps state with the given tunnel, an allow-all owner gate, and a throwaway
/// recording handle — for tests that don't inspect what the handle received.
pub(crate) fn state_with_tunnel(tunnel: Arc<dyn TunnelService>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel, Arc::new(RecordingStubWebviewHandle::default()))
}

/// Apps state with the offline tunnel and an allow-all owner gate — the default
/// for tests that don't exercise the tunnel or owner-auth branch.
pub(crate) fn state() -> Arc<AppsState> {
    state_with_tunnel(tunnel_unavailable())
}

/// Apps state with the offline tunnel, an allow-all owner gate, and a
/// caller-provided handle — so a loopback launch's resolved URL can be read back
/// off the handle.
pub(crate) fn state_with_sink(webview_handle: Arc<dyn OnDeviceWebviewHandle>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel_unavailable(), webview_handle)
}

/// Apps state whose owner gate **denies** every loopback launch — drives the
/// `401` branch.
pub(crate) fn state_owner_denied() -> Arc<AppsState> {
    state_full(
        Arc::new(StubOwnerAuth::always_denied()),
        tunnel_unavailable(),
        Arc::new(RecordingStubWebviewHandle::default()),
        Arc::new(NoLaunchCookies),
    )
}

/// Apps state whose owner gate **denies**, with the offline tunnel and a
/// caller-provided handle — lets a test assert a denied loopback launch neither
/// opens the popup nor reaches the (down) tunnel.
pub(crate) fn state_owner_denied_with_sink(
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
) -> Arc<AppsState> {
    state_full(
        Arc::new(StubOwnerAuth::always_denied()),
        tunnel_unavailable(),
        webview_handle,
        Arc::new(NoLaunchCookies),
    )
}
