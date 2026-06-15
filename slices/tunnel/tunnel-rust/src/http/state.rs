//! Shared HTTP state: the SQLite store, the relay client, and the in-memory
//! runtime (the live tunnel handle + observed state).
//!
//! Settings (intent) are persisted; runtime is ephemeral per process, mirroring
//! the TS side where `TunnelState` resets each session and `TunnelConfig`
//! persists.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::client::{ExitReporter, RelayClient, RelayHandle, TunnelStatus};
use crate::db::TunnelStore;
use crate::domain::TunnelSettings;

/// Daemon-owned runtime, reset on (re)start.
#[derive(Default)]
struct Runtime {
    /// Identifies the current tunnel run, bumped on every (re)start. A client
    /// task that exits late reports the run it was started under, so
    /// [`TunnelState::on_status`] can ignore the exit of a run that a newer
    /// start has already superseded.
    run_id: u64,
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
    ///
    /// A *post-launch* failure (the client task exiting after a successful
    /// launch) is delivered later through the [`ExitReporter`] handed to the
    /// client and folded in by [`Self::on_status`].
    pub(crate) fn apply_running(self: &Arc<Self>, settings: &TunnelSettings) {
        let mut runtime = self.runtime.lock();
        if let Some(handle) = runtime.handle.take() {
            handle.stop();
        }
        // A new run id invalidates any late exit report from the tunnel we just
        // tore down.
        let run_id = runtime.run_id.wrapping_add(1);
        *runtime = Runtime {
            run_id,
            ..Default::default()
        };

        if !settings.requested_running {
            return;
        }

        let weak = Arc::downgrade(self);
        let on_exit: ExitReporter = Box::new(move |status| {
            if let Some(state) = weak.upgrade() {
                state.on_status(run_id, status);
            }
        });
        match self
            .client
            .start(settings, &format!("127.0.0.1:{}", self.local_port), on_exit)
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

    /// Fold a client task's terminal status back into the runtime. Ignored if a
    /// newer (re)start has already superseded `run_id`; otherwise the tunnel is
    /// torn down — `running` off, `current_*` cleared — with a `Failed` cause
    /// stringified into the wire `error` field.
    pub(crate) fn on_status(&self, run_id: u64, status: TunnelStatus) {
        let mut runtime = self.runtime.lock();
        if runtime.run_id != run_id {
            return;
        }
        let error = match status {
            TunnelStatus::Failed(error) => Some(format!("{error:#}")),
            TunnelStatus::Stopped => None,
        };
        *runtime = Runtime {
            run_id,
            error,
            ..Default::default()
        };
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
