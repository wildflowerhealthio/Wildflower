//! [`ServerUnit`]: one server, as a unit `UnitRunner` runs.

use gatekeeper_rust::PendingConsentHead;
use shared_structures_rust::request_caller::ForwardedRequest;
use tokio::sync::{mpsc, watch};
use unit_runner::{RunContext, Unit};
use wildflower_server_rust::{HostPorts, ServerHealth, ServerObservers, WildflowerServerConfig};

use crate::domain::ServerDetail;
use crate::live_bindings::running_server_consents::RunningServerConsents;

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
    running_server_consents: RunningServerConsents,
}

impl ServerUnit {
    /// A run of the server `config` describes, over the host's `host_ports`,
    /// reporting each request its tunnel relays on `forwarded_request_tx`
    /// and putting its consents in `running_server_consents` while it is up.
    #[must_use]
    pub fn new(
        config: WildflowerServerConfig,
        host_ports: HostPorts,
        forwarded_request_tx: mpsc::Sender<ForwardedRequest>,
        running_server_consents: RunningServerConsents,
    ) -> Self {
        Self {
            config,
            host_ports,
            forwarded_request_tx,
            running_server_consents,
        }
    }
}

impl Unit for ServerUnit {
    type Detail = ServerDetail;

    /// Set the server up, put its consents in the host's
    /// [`RunningServerConsents`] until the run ends, announce it running, and
    /// serve it until `UnitRunner` stops the run. Its health and the head of
    /// its pending-consent queue go out as the run's [`ServerDetail`].
    ///
    /// The run's gatekeeper publishes its queue's head on a channel of the
    /// run's own, so each server's head is its own; each head is forwarded to
    /// the host's `active_pending_consent_tx` too, which every run shares.
    async fn run(self, ctx: RunContext<ServerDetail>) -> anyhow::Result<()> {
        let (server_health_tx, server_health_rx) = watch::channel(None);
        let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
        let host_pending_consent_tx = self.host_ports.active_pending_consent_tx.clone();
        let server = wildflower_server_rust::set_up(
            self.config,
            HostPorts {
                active_pending_consent_tx: pending_consent_tx,
                ..self.host_ports
            },
            ServerObservers {
                server_health_tx,
                forwarded_request_tx: self.forwarded_request_tx,
            },
        )
        .await?;
        let _consents_entry = self
            .running_server_consents
            .enter(ctx.unit_id().as_str(), server.host_owner_consents().clone());
        tokio::spawn(report_detail(
            DetailSources {
                server_health_rx,
                pending_consent_rx,
                host_pending_consent_tx,
            },
            ctx.clone(),
        ));
        ctx.announce_running();
        server.serve(ctx.shutdown_token().clone()).await
    }
}

/// What a run's detail is read from.
struct DetailSources {
    /// The run's reachability monitor's health.
    server_health_rx: watch::Receiver<Option<ServerHealth>>,
    /// The head of the run's gatekeeper's pending-consent queue.
    pending_consent_rx: watch::Receiver<Option<PendingConsentHead>>,
    /// The host's channel each head is forwarded to.
    host_pending_consent_tx: watch::Sender<Option<PendingConsentHead>>,
}

/// Set the run's detail from its health and its queue's head, now and each
/// time either changes, and forward each new head to the host's channel. The
/// task dies with the run's runtime, and `UnitRunner` clears the detail when
/// the run ends.
async fn report_detail(mut sources: DetailSources, ctx: RunContext<ServerDetail>) {
    // The monitor drops its sender once it stops; the head's lives as long as
    // the run's gatekeeper.
    let mut health_open = true;
    loop {
        let pending_consent = sources.pending_consent_rx.borrow_and_update().clone();
        sources
            .host_pending_consent_tx
            .send_if_modified(|host_head| {
                let changed = *host_head != pending_consent;
                if changed {
                    host_head.clone_from(&pending_consent);
                }
                changed
            });
        ctx.set_detail(ServerDetail {
            health: sources.server_health_rx.borrow_and_update().clone(),
            pending_consent,
        });
        tokio::select! {
            changed = sources.server_health_rx.changed(), if health_open => {
                health_open = changed.is_ok();
            }
            changed = sources.pending_consent_rx.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
    }
}
