//! Shared fixtures for the `/apps` handler tests — the public (`apps`) and
//! admin (`apps_admin`) test modules both build state and tunnel stubs the same
//! way, so those live here rather than being copied into each. Request-builder
//! helpers (`post`/`get`/`router`/…) stay per-module: they reference each
//! module's own `openapi_router`.

use std::sync::Arc;

use async_trait::async_trait;
use shared_structures_rust::test_utils::RecordingStubWebviewHandle;
use shared_structures_rust::tunnel_service::{
    OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
};

use crate::db::AppsStore;
use crate::http::state::AppsState;
use crate::OnDeviceWebviewHandle;

/// The loopback origin clients reach when the tunnel is down. The apps slice
/// treats this and [`LOOPBACK_HOSTNAME`] as **independent** config values —
/// production wires `loopback_origin` and `loopback_hostname`
/// separately and the slice never derives one from the other (the app could be
/// served elsewhere) — so the fixtures carry both rather than splitting a host
/// out of the origin.
pub(crate) const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:8080";

/// The hostname (no scheme, no port) the internal-app listeners bind on —
/// combined with each internal row's `port` to render `http://{hostname}:{port}/`.
pub(crate) const LOOPBACK_HOSTNAME: &str = "127.0.0.1";

/// A `TunnelService` stub for a tunnel that's up and verified at `origin` — the
/// success counterpart to the shared [`OfflineTunnel`], which models the
/// can't-reach case (`try_start` fails, state stays `Off`). `public_host` is
/// reported through [`TunnelService::current_public_host`] — the internal-app
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
/// the live shape that drives the internal-app launch's subdomain branch
/// (forwarded caller → `https://<id>.<host>/`) without needing the tunnel up.
pub(crate) fn tunnel_with_public_host(public_host: &str) -> Arc<dyn TunnelService> {
    Arc::new(StubTunnel {
        origin: LOOPBACK_ORIGIN.to_owned(),
        public_host: Some(public_host.to_owned()),
    })
}

pub(crate) fn tunnel_unavailable() -> Arc<dyn TunnelService> {
    Arc::new(OfflineTunnel::new(LOOPBACK_ORIGIN))
}

/// Apps state over a fresh in-memory store with a specific `tunnel` AND a
/// caller-provided on-device webview handle, using the shared loopback config
/// constants. Lets a test both drive the tunnel branch and assert what the
/// handle received for a loopback launch.
pub(crate) fn state_with_tunnel_and_handle(
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
) -> Arc<AppsState> {
    let store = AppsStore::open_in_memory().expect("store");
    Arc::new(AppsState::new(
        store,
        LOOPBACK_ORIGIN,
        LOOPBACK_HOSTNAME,
        tunnel,
        webview_handle,
    ))
}

/// Apps state with the given tunnel and a throwaway recording handle — for
/// tests that don't inspect what the handle received.
pub(crate) fn state_with_tunnel(tunnel: Arc<dyn TunnelService>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel, Arc::new(RecordingStubWebviewHandle::default()))
}

/// Apps state with the offline tunnel — the default for tests that don't
/// exercise the tunnel branch (the admin surface never touches it).
pub(crate) fn state() -> Arc<AppsState> {
    state_with_tunnel(tunnel_unavailable())
}

/// Apps state with the offline tunnel and a caller-provided handle — so a
/// loopback launch's resolved URL can be read back off the handle.
pub(crate) fn state_with_sink(webview_handle: Arc<dyn OnDeviceWebviewHandle>) -> Arc<AppsState> {
    state_with_tunnel_and_handle(tunnel_unavailable(), webview_handle)
}
