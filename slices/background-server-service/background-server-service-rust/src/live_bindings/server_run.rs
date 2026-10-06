//! One run of the Wildflower server: behind the [`RunGate`], on its own OS
//! thread and its own tokio runtime, reporting its [`ServerRunState`]; and
//! [`ServerToRun`], what the host publishes for the background service's runs.

mod dedicated_runtime;

use shared_structures_rust::request_caller::ForwardedRequest;
use shared_structures_rust::server_run_state::ServerRunState;
use shared_structures_rust::tunnel_service::TunnelLiveness;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use wildflower_server_rust::{HostPorts, ServerObservers, WildflowerServerConfig};

use crate::domain::run_gate::RunGate;

pub use dedicated_runtime::SERVER_RUNTIME_SHUTDOWN_TIMEOUT;

/// How many forwarded-request reports may wait for the host before the server
/// starts dropping them (see `wildflower_server_rust::ServerObservers`).
pub const FORWARDED_REQUEST_CAPACITY: usize = 256;

/// What every server run shares, whichever server it runs: the host's ports,
/// the channels the host watches runs through, and the run gate. The host
/// builds it once; `Clone` is cheap (the ports are `Arc`s and the channels are
/// shared).
#[derive(Clone)]
pub struct ServerHost {
    host_ports: HostPorts,
    observers: ServerObservers,
    run_gate: RunGate,
    run_state_sender: watch::Sender<ServerRunState>,
}

/// One server, as the background service runs it: its config, and the
/// [`ServerHost`] every run shares. `Clone` is cheap.
#[derive(Clone)]
pub struct ServerHostContext {
    host: ServerHost,
    config: WildflowerServerConfig,
}

/// The receiving ends of a [`ServerHost`]'s channels, for the host's glue to
/// watch. Every run reports on them, whichever server it runs.
pub struct ServerServiceReceivers {
    /// Each run's [`ServerRunState`]; `Stopped { error: None }` before any run.
    pub run_state: watch::Receiver<ServerRunState>,
    /// The running server's tunnel liveness; `None` while no server runs.
    pub tunnel_liveness: watch::Receiver<Option<TunnelLiveness>>,
    /// Each request the trusted front relayed through the tunnel.
    pub forwarded_requests: mpsc::Receiver<ForwardedRequest>,
}

/// What the host publishes for the background service's runs, which the
/// platform may start on its own (a phone's background task, the plugin's
/// recovery) as well as when the host asks.
#[derive(Clone)]
pub enum ServerToRun {
    /// The host is still setting up; a run waits for it to decide.
    Undecided,
    /// Run this server. Boxed: a context is far larger than a reason.
    Server(Box<ServerHostContext>),
    /// Run nothing, for `reason`: a run ends at once, logging it.
    NoServer { reason: String },
}

impl ServerHost {
    /// The host side of every run over the host's `host_ports`, with the
    /// channels the host watches the runs through.
    #[must_use]
    pub fn new(host_ports: HostPorts) -> (Self, ServerServiceReceivers) {
        let (run_state_sender, run_state) = watch::channel(ServerRunState::Stopped { error: None });
        let (tunnel_liveness_sender, tunnel_liveness) = watch::channel(None);
        let (forwarded_request_sender, forwarded_requests) =
            mpsc::channel(FORWARDED_REQUEST_CAPACITY);
        let host = Self {
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
        (host, receivers)
    }

    /// The context for running the server `config` describes.
    #[must_use]
    pub fn context(&self, config: WildflowerServerConfig) -> ServerHostContext {
        ServerHostContext {
            host: self.clone(),
            config,
        }
    }

    /// A receiver of every run's [`ServerRunState`], whichever server it runs.
    #[must_use]
    pub fn subscribe_run_state(&self) -> watch::Receiver<ServerRunState> {
        self.run_state_sender.subscribe()
    }

    /// A receiver of the running server's tunnel liveness, whichever server
    /// it is; `None` while no server runs.
    #[must_use]
    pub fn subscribe_tunnel_liveness(&self) -> watch::Receiver<Option<TunnelLiveness>> {
        self.observers.tunnel_liveness_sender.subscribe()
    }

    /// Wait until every run that is serving, or waiting at the gate, has
    /// ended: its server gone with its runtime, and `Stopped` published. A run
    /// whose shutdown was cancelled before it reached the gate ends there
    /// without starting.
    pub async fn wait_for_runs_to_end(&self) {
        drop(self.run_gate.wait_for_previous_run().await);
    }
}

/// Wait for the host to decide what to run (or for `shutdown`), then run it
/// until `shutdown` is cancelled or the server fails. With
/// [`ServerToRun::NoServer`] the run logs the host's reason and ends at once,
/// `Ok`, starting nothing: the run state stays `Stopped`.
///
/// # Errors
///
/// The server's error (see [`ServerHostContext::run_server`]), or that the
/// host dropped its sender without deciding.
pub async fn run_published_server(
    server_to_run: &mut watch::Receiver<ServerToRun>,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let published = tokio::select! {
        () = shutdown.cancelled() => return Ok(()),
        published = server_to_run.wait_for(|server_to_run| {
            !matches!(server_to_run, ServerToRun::Undecided)
        }) => published
            .map_err(|_| anyhow::anyhow!("the host dropped the server to run without deciding it"))?
            .clone(),
    };
    match published {
        ServerToRun::Server(context) => context.run_server(shutdown).await,
        ServerToRun::NoServer { reason } => {
            tracing::info!("no server to run: {reason}");
            Ok(())
        }
        ServerToRun::Undecided => unreachable!("the wait above ends only once a server is decided"),
    }
}

impl ServerHostContext {
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
        let _run_gate_guard = self.host.run_gate.wait_for_previous_run().await;
        if shutdown.is_cancelled() {
            return Ok(());
        }
        self.host
            .run_state_sender
            .send_replace(ServerRunState::Starting);
        let result = self.serve_on_server_thread(shutdown.child_token()).await;
        // The run's tasks are gone with its runtime, so nothing copies the
        // tunnel's liveness any more.
        self.host
            .observers
            .tunnel_liveness_sender
            .send_replace(None);
        self.host
            .run_state_sender
            .send_replace(ServerRunState::Stopped {
                error: result.as_ref().err().map(|error| format!("{error:#}")),
            });
        result
    }

    async fn set_up_and_serve(&self, shutdown: CancellationToken) -> anyhow::Result<()> {
        let server = wildflower_server_rust::set_up(
            self.config.clone(),
            self.host.host_ports.clone(),
            self.host.observers.clone(),
        )
        .await?;
        if shutdown.is_cancelled() {
            return Ok(());
        }
        self.host
            .run_state_sender
            .send_replace(ServerRunState::Running);
        server.serve(shutdown).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A run the platform starts while the host is still deciding waits, and
    /// one the host has nothing for ends at once, starting nothing.
    #[tokio::test]
    async fn a_run_with_no_server_to_run_ends_once_the_host_says_so() {
        let (server_to_run_sender, mut server_to_run) = watch::channel(ServerToRun::Undecided);
        let shutdown = CancellationToken::new();
        let run =
            tokio::spawn(async move { run_published_server(&mut server_to_run, &shutdown).await });
        tokio::task::yield_now().await;
        assert!(
            !run.is_finished(),
            "an undecided host keeps the run waiting"
        );

        server_to_run_sender.send_replace(ServerToRun::NoServer {
            reason: "no server's run policy is active".to_owned(),
        });

        run.await
            .expect("the run's task doesn't panic")
            .expect("a run with nothing to run ends Ok");
    }

    #[tokio::test]
    async fn a_run_shut_down_while_the_host_decides_ends_ok() {
        let (_server_to_run_sender, mut server_to_run) = watch::channel(ServerToRun::Undecided);
        let shutdown = CancellationToken::new();
        shutdown.cancel();

        run_published_server(&mut server_to_run, &shutdown)
            .await
            .expect("a cancelled run ends Ok");
    }

    #[tokio::test]
    async fn a_host_that_drops_its_sender_undecided_fails_the_run() {
        let (server_to_run_sender, mut server_to_run) = watch::channel(ServerToRun::Undecided);
        drop(server_to_run_sender);

        let error = run_published_server(&mut server_to_run, &CancellationToken::new())
            .await
            .expect_err("nothing was decided");
        assert!(error.to_string().contains("without deciding"), "{error}");
    }
}
