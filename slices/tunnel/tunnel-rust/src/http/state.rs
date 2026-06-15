//! Shared HTTP state: the SQLite store, the relay client, and the in-memory
//! runtime (the live tunnel handle + observed state).
//!
//! Settings (intent) are persisted; runtime is ephemeral per process, mirroring
//! the TS side where `TunnelState` resets each session and `TunnelConfig`
//! persists.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::client::{RelayClient, RelayHandle};
use crate::db_utils::TunnelStore;
use crate::domain::TunnelSettings;

/// Daemon-owned runtime, reset on (re)start.
#[derive(Default)]
struct Runtime {
    handle: Option<RelayHandle>,
    running: bool,
    current_subdomain: Option<String>,
    current_root_domain: Option<String>,
    current_local_port: Option<u16>,
    error: Option<String>,
}

/// A copy of the observed runtime for building the wire snapshot without
/// holding the lock.
pub(crate) struct RuntimeView {
    pub running: bool,
    pub current_subdomain: Option<String>,
    pub current_root_domain: Option<String>,
    pub current_local_port: Option<u16>,
    pub error: Option<String>,
}

/// Shared state threaded through the tunnel handlers.
pub struct TunnelState {
    pub(crate) store: TunnelStore,
    client: Arc<dyn RelayClient>,
    loopback_origin: String,
    local_port: u16,
    runtime: Mutex<Runtime>,
}

impl TunnelState {
    pub fn new(
        store: TunnelStore,
        client: Arc<dyn RelayClient>,
        loopback_origin: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self {
            store,
            client,
            loopback_origin: loopback_origin.into(),
            local_port,
            runtime: Mutex::new(Runtime::default()),
        }
    }

    pub(crate) fn loopback_origin(&self) -> &str {
        &self.loopback_origin
    }

    /// Reconcile the live tunnel with `settings.requested_running`: tear down
    /// any existing tunnel, then (if requested) start a fresh one. A start
    /// failure leaves `running == false` with the cause in `error`, mirroring
    /// how the Effect daemon persists a failed bring-up.
    pub(crate) fn apply_running(&self, settings: &TunnelSettings) {
        let mut runtime = self.runtime.lock();
        if let Some(handle) = runtime.handle.take() {
            handle.stop();
        }
        *runtime = Runtime::default();

        if !settings.requested_running {
            return;
        }
        match self
            .client
            .start(settings, &format!("127.0.0.1:{}", self.local_port))
        {
            Ok(handle) => {
                runtime.handle = Some(handle);
                runtime.running = true;
                runtime.current_subdomain = settings.subdomain.clone();
                runtime.current_root_domain = settings.root_domain.clone();
                runtime.current_local_port = Some(self.local_port);
            }
            Err(error) => {
                runtime.error = Some(format!("{error:#}"));
            }
        }
    }

    pub(crate) fn runtime_view(&self) -> RuntimeView {
        let runtime = self.runtime.lock();
        RuntimeView {
            running: runtime.running,
            current_subdomain: runtime.current_subdomain.clone(),
            current_root_domain: runtime.current_root_domain.clone(),
            current_local_port: runtime.current_local_port,
            error: runtime.error.clone(),
        }
    }
}
