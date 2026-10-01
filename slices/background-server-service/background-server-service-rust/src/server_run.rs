//! One run of the Wildflower server: behind the [`RunGate`], on its own OS
//! thread and its own tokio runtime, reporting its [`ServerRunState`].

use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context};
use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::tunnel_service::TunnelLiveness;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use wildflower_server_rust::{HostPorts, ServerObservers, WildflowerServerConfig};

use crate::run_gate::RunGate;

/// How long a run's runtime waits for its tasks after the server stops, before
/// the thread gives up on them. Gatekeeper's retention sweep can hold a
/// blocking worker for up to 30 s on a pooled connection; a runtime that is
/// dropped instead waits for it forever.
pub const SERVER_RUNTIME_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// How many forwarded-request reports may wait for the host before the server
/// starts dropping them (see `wildflower_server_rust::ServerObservers`).
pub const FORWARDED_REQUEST_CAPACITY: usize = 256;

/// The name of each run's OS thread, and the prefix of its runtime's workers.
const SERVER_THREAD_NAME: &str = "wildflower-server";

/// Where the current server run is.
///
/// Runs are ordered by the [`RunGate`] and each run writes its states in this
/// order, so the host's watch of it never goes backwards: `Starting` →
/// `Running` → `Stopped`, or `Starting` → `Stopped` when startup fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerRunState {
    /// A run holds the gate and is setting the server up.
    Starting,
    /// The server is bound and serving.
    Running,
    /// No run is serving. `error` is the most recent run's failure as its full
    /// `{:#}` chain, or `None` when it stopped cleanly or none has run yet.
    Stopped { error: Option<String> },
}

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
    /// The running server's tunnel liveness; `None` while no server runs.
    pub tunnel_liveness: watch::Receiver<Option<TunnelLiveness>>,
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
        let (tunnel_liveness_sender, tunnel_liveness) = watch::channel(None);
        let (forwarded_request_sender, forwarded_requests) =
            mpsc::channel(FORWARDED_REQUEST_CAPACITY);
        let context = Self {
            config,
            host_ports,
            observers: ServerObservers {
                tunnel_liveness_sender,
                forwarded_request_sender,
            },
            run_gate: RunGate::new(),
            run_state_sender,
        };
        let receivers = ServerServiceReceivers {
            run_state,
            tunnel_liveness,
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
        // The run's tasks are gone with its runtime, so nothing copies the
        // tunnel's liveness any more.
        self.observers.tunnel_liveness_sender.send_replace(None);
        self.run_state_sender.send_replace(ServerRunState::Stopped {
            error: result.as_ref().err().map(|error| format!("{error:#}")),
        });
        result
    }

    /// Spawn the run's thread and wait for its result.
    async fn serve_on_server_thread(
        &self,
        server_shutdown: CancellationToken,
    ) -> anyhow::Result<()> {
        // Should this future be dropped rather than cancelled, the server still
        // stops.
        let _stop_server_when_dropped = server_shutdown.clone().drop_guard();
        let (result_sender, result_receiver) = oneshot::channel();
        let context = self.clone();
        std::thread::Builder::new()
            .name(SERVER_THREAD_NAME.to_owned())
            .spawn(move || {
                let result = context.serve_on_dedicated_runtime(server_shutdown);
                if result_sender.send(result).is_err() {
                    tracing::debug!("server run result dropped: its run is no longer waiting");
                }
            })
            .context("failed to spawn the server thread")?;
        result_receiver
            .await
            .context("the server thread ended without reporting a result")?
    }

    /// The body of the run's thread: build a runtime, set up and serve on it,
    /// then shut it down.
    fn serve_on_dedicated_runtime(&self, shutdown: CancellationToken) -> anyhow::Result<()> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name(format!("{SERVER_THREAD_NAME}-worker"))
            .build()
            .context("failed to build the server runtime")?;
        // A panic in the server must not skip the bounded shutdown below: an
        // unwinding thread would drop the runtime instead, which can wait on a
        // blocking worker forever and hold the gate shut.
        let served = std::panic::catch_unwind(AssertUnwindSafe(|| {
            runtime.block_on(self.set_up_and_serve(shutdown))
        }))
        .unwrap_or_else(|panic| Err(anyhow!("the server panicked: {}", panic_message(&*panic))));
        shut_down_runtime(runtime);
        served
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

/// Shut `runtime` down, giving its tasks [`SERVER_RUNTIME_SHUTDOWN_TIMEOUT`] to
/// finish, and log when blocking work outlived it.
fn shut_down_runtime(runtime: tokio::runtime::Runtime) {
    let shutdown_started = Instant::now();
    runtime.shutdown_timeout(SERVER_RUNTIME_SHUTDOWN_TIMEOUT);
    if shutdown_started.elapsed() >= SERVER_RUNTIME_SHUTDOWN_TIMEOUT {
        tracing::warn!(
            "the server runtime's blocking work outlived its {SERVER_RUNTIME_SHUTDOWN_TIMEOUT:?} \
             shutdown timeout and was left running"
        );
    }
}

/// The text a panic was raised with, when it was raised with text.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    if let Some(message) = panic.downcast_ref::<&str>() {
        message
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message
    } else {
        "a non-text panic payload"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_messages_are_read_from_text_payloads() {
        let from_str = std::panic::catch_unwind(|| panic!("static text")).expect_err("panics");
        assert_eq!(panic_message(&*from_str), "static text");
        let from_string =
            std::panic::catch_unwind(|| panic!("{} text", "formatted")).expect_err("panics");
        assert_eq!(panic_message(&*from_string), "formatted text");
        let from_value =
            std::panic::catch_unwind(|| std::panic::panic_any(7_u8)).expect_err("panics");
        assert_eq!(panic_message(&*from_value), "a non-text panic payload");
    }
}
