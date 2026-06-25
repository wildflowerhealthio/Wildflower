//! Shared fixtures for the `/apps` handler tests — the public (`apps`) and
//! admin (`apps_admin`) test modules both build state and tunnel stubs the same
//! way, so those live here rather than being copied into each. Request-builder
//! helpers (`post`/`get`/`router`/…) stay per-module: they reference each
//! module's own `openapi_router`.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use shared_structures_rust::tunnel_service::{
    OfflineTunnel, TunnelLiveness, TunnelService, TunnelStatus,
};

use crate::db::AppsStore;
use crate::domain::AppEntry;
use crate::http::state::AppsState;
use crate::{LoopbackCaller, OnDeviceLaunchSink};

/// The loopback origin clients reach when the tunnel is down. The apps slice
/// treats this and [`LOOPBACK_HOST`] as **independent** config values —
/// production wires `loopback_origin` and `internal_apps_loopback_host`
/// separately and the slice never derives one from the other (the app could be
/// served elsewhere) — so the fixtures carry both rather than splitting a host
/// out of the origin.
pub(crate) const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:8080";

/// The host portion the internal-app listeners bind on — combined with each
/// internal row's `port` to render `http://{host}:{port}/`.
pub(crate) const LOOPBACK_HOST: &str = "127.0.0.1";

/// An [`OnDeviceLaunchSink`] stub that records the URLs it's handed, so a test
/// can assert the handler resolved the target and routed it to the sink (and
/// returned `204`) instead of redirecting.
#[derive(Default)]
pub(crate) struct RecordingSink(pub(crate) Mutex<Vec<String>>);

impl OnDeviceLaunchSink for RecordingSink {
    fn open(&self, _caller: LoopbackCaller, _app: &AppEntry, url: &str) {
        self.0.lock().expect("sink mutex").push(url.to_owned());
    }
}

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

/// Apps state over a fresh in-memory store with the given tunnel, using the
/// shared loopback config constants.
pub(crate) fn state_with_tunnel(tunnel: Arc<dyn TunnelService>) -> Arc<AppsState> {
    let store = AppsStore::open_in_memory().expect("store");
    Arc::new(AppsState::new(store, LOOPBACK_ORIGIN, LOOPBACK_HOST, tunnel))
}

/// Apps state with the offline tunnel — the default for tests that don't
/// exercise the tunnel branch (the admin surface never touches it).
pub(crate) fn state() -> Arc<AppsState> {
    state_with_tunnel(tunnel_unavailable())
}

/// Apps state with an [`OnDeviceLaunchSink`] installed (the Tauri-host shape).
pub(crate) fn state_with_sink(sink: Arc<dyn OnDeviceLaunchSink>) -> Arc<AppsState> {
    let store = AppsStore::open_in_memory().expect("store");
    Arc::new(
        AppsState::new(store, LOOPBACK_ORIGIN, LOOPBACK_HOST, tunnel_unavailable())
            .with_launch_sink(sink),
    )
}
