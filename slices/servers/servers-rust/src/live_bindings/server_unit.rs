//! [`ServerUnit`]: one server, as a unit `UnitRunner` runs.

use shared_structures_rust::request_caller::ForwardedRequest;
use tokio::sync::{mpsc, watch};
use unit_runner::{RunContext, Unit};
use wildflower_server_rust::{HostPorts, ServerHealth, ServerObservers, WildflowerServerConfig};

use crate::domain::ServerDetail;

/// One run of one server: the Wildflower server `wildflower-server-rust` sets
/// up and serves, as a unit `UnitRunner` runs.
///
/// The host's factory builds a fresh `ServerUnit` for each run, from the
/// server's record as the host last pushed it, so a run's configuration is
/// fixed from its start to its end. `UnitRunner` gives each run its own thread
/// and runtime, and shuts that runtime down when the run ends, which stops
/// every task the server's slices spawned.
///
/// The unit knows nothing of Tauri: the host hands it everything it reads.
pub struct ServerUnit {
    config: WildflowerServerConfig,
    host_ports: HostPorts,
    forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
}

impl ServerUnit {
    /// A run of the server `config` describes, over the host's `host_ports`,
    /// reporting each request its tunnel relays on `forwarded_request_tx`.
    #[must_use]
    pub fn new(
        config: WildflowerServerConfig,
        host_ports: HostPorts,
        forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
    ) -> Self {
        Self {
            config,
            host_ports,
            forwarded_request_tx,
        }
    }
}

impl Unit for ServerUnit {
    type Detail = ServerDetail;

    /// Set the server up, announce it running once it is bound, and serve it
    /// until `UnitRunner` stops the run. Its health goes out as the run's
    /// [`ServerDetail`].
    async fn run(self, ctx: RunContext<ServerDetail>) -> anyhow::Result<()> {
        let (server_health_tx, server_health_rx) = watch::channel(None);
        tokio::spawn(report_health_as_detail(server_health_rx, ctx.clone()));
        let server = wildflower_server_rust::set_up(
            self.config,
            self.host_ports,
            ServerObservers {
                server_health_tx,
                forwarded_request_tx: self.forwarded_request_tx,
            },
        )
        .await?;
        ctx.announce_running();
        server.serve(ctx.shutdown_token().clone()).await
    }
}

/// Set each health the run's reachability monitor publishes as the run's
/// detail, until the server drops its sender. The task dies with the run's
/// runtime, and `UnitRunner` clears the detail when the run ends.
async fn report_health_as_detail(
    mut server_health_rx: watch::Receiver<Option<ServerHealth>>,
    ctx: RunContext<ServerDetail>,
) {
    while server_health_rx.changed().await.is_ok() {
        let health = server_health_rx.borrow_and_update().clone();
        ctx.set_detail(ServerDetail { health });
    }
}
