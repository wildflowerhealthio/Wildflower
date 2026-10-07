//! One run of the Wildflower server: behind the [`RunGate`], on its own OS
//! thread and its own tokio runtime, reporting its [`ServerRunState`].

mod dedicated_runtime;

use shared_structures_rust::request_caller::ForwardedRequest;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use wildflower_server_rust::{HostPorts, ServerHealth, ServerObservers, WildflowerServerConfig};

use crate::domain::run_gate::RunGate;
use crate::domain::server_run_state::ServerRunState;

pub use dedicated_runtime::SERVER_RUNTIME_SHUTDOWN_TIMEOUT;

/// How many forwarded-request reports may wait for the host before the server
/// starts dropping them (see `wildflower_server_rust::ServerObservers`).
pub const FORWARDED_REQUEST_CAPACITY: usize = 256;

/// Everything a server run needs from the host, shared by every run. The host
/// builds it once; `Clone` is cheap (the ports are `Arc`s and the channels are
/// shared).
#[derive(Clone)]
pub struct ServerHostContext {
    config: WildflowerServerConfig,
    host_ports: HostPorts,
    observers: ServerObservers,
    run_gate: RunGate,
    run_state_sender: watch::Sender<ServerRunState>,
}

/// The receiving ends of a [`ServerHostContext`]'s channels, for the host's
/// glue to watch.
pub struct ServerServiceReceivers {
    /// Each run's [`ServerRunState`]; `Stopped { error: None }` before any run.
    pub run_state: watch::Receiver<ServerRunState>,
    /// The running server's health through its public origin; `None` while no
    /// server runs, and until its first probe.
    pub server_health: watch::Receiver<Option<ServerHealth>>,
    /// Each request the trusted front relayed through the tunnel.
    pub forwarded_requests: mpsc::Receiver<ForwardedRequest>,
}

impl ServerHostContext {
    /// The context for running the server `config` describes over the host's
    /// `host_ports`, with the channels the host watches it through.
    #[must_use]
    pub fn new(
        config: WildflowerServerConfig,
        host_ports: HostPorts,
    ) -> (Self, ServerServiceReceivers) {
        let (run_state_sender, run_state) = watch::channel(ServerRunState::Stopped { error: None });
        let (server_health_sender, server_health) = watch::channel(None);
        let (forwarded_request_sender, forwarded_requests) =
            mpsc::channel(FORWARDED_REQUEST_CAPACITY);
        let context = Self {
            config,
            host_ports,
            observers: ServerObservers {
                server_health_sender,
                forwarded_request_sender,
            },
            run_gate: RunGate::new(),
            run_state_sender,
        };
        let receivers = ServerServiceReceivers {
            run_state,
            server_health,
            forwarded_requests,
        };
        (context, receivers)
    }

    /// Run the server until `shutdown` is cancelled or the server fails.
    ///
    /// Waits for the previous run to finish (see [`RunGate`]), then sets the
    /// server up and serves it on a dedicated OS thread with its own
    /// multi-thread runtime. When the server stops, the thread shuts that
    /// runtime down (waiting up to [`SERVER_RUNTIME_SHUTDOWN_TIMEOUT`]), which
    /// cancels every task the slices spawned. Only then does the run publish
    /// `Stopped` and open the gate for the next run.
    ///
    /// A run whose `shutdown` is cancelled while it waits at the gate never
    /// starts, and returns `Ok`.
    ///
    /// # Errors
    ///
    /// Returns the server's startup or serving error, or the panic it died with.
    /// The same error, as its `{:#}` chain, is the run's `Stopped` state.
    pub async fn run_server(&self, shutdown: &CancellationToken) -> anyhow::Result<()> {
        let _run_gate_guard = self.run_gate.wait_for_previous_run().await;
        if shutdown.is_cancelled() {
            return Ok(());
        }
        self.run_state_sender.send_replace(ServerRunState::Starting);
        let result = self.serve_on_server_thread(shutdown.child_token()).await;
        // The run's tasks are gone with its runtime, so nothing probes the
        // server's health any more.
        self.observers.server_health_sender.send_replace(None);
        self.run_state_sender.send_replace(ServerRunState::Stopped {
            error: result.as_ref().err().map(|error| format!("{error:#}")),
        });
        result
    }

    async fn set_up_and_serve(&self, shutdown: CancellationToken) -> anyhow::Result<()> {
        let server = wildflower_server_rust::set_up(
            self.config.clone(),
            self.host_ports.clone(),
            self.observers.clone(),
        )
        .await?;
        if shutdown.is_cancelled() {
            return Ok(());
        }
        self.run_state_sender.send_replace(ServerRunState::Running);
        server.serve(shutdown).await
    }
}
