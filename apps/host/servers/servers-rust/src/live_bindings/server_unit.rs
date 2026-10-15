//! [`ServerUnit`]: one server, as a unit `UnitRunner` runs.

use tokio::sync::watch;
use wildflowerhealthio_authorization_server::NewestPendingConsent;
use wildflowerhealthio_tunnel::TunnelState;
use wildflowerhealthio_unit_runner::{RunContext, Unit};
use wildflowerhealthio_wildflower_server::{
    CertificateState, ServerHealth, ServerObservers, WildflowerServerConfig,
};

use crate::domain::ServerDetail;
use crate::live_bindings::server_consent_watcher::ServerConsentWatcher;
use crate::live_bindings::server_launch_minter::ServerLaunchMinter;
use crate::live_bindings::server_sign_in_code_minter::ServerSignInCodeMinter;

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
}

impl ServerUnit {
    /// A run of the server `config` describes.
    #[must_use]
    pub fn new(config: WildflowerServerConfig) -> Self {
        Self { config }
    }
}

impl Unit for ServerUnit {
    type Detail = ServerDetail;

    /// Set the server up, announce it running, and serve it until
    /// `UnitRunner` stops the run. Its health, its tunnel's state, its
    /// certificate's state, its newest pending consent, and the
    /// [`ServerLaunchMinter`], [`ServerSignInCodeMinter`] and
    /// [`ServerConsentWatcher`] over its authorization server go out as the
    /// run's [`ServerDetail`].
    ///
    /// The run's authorization server publishes its newest pending consent on
    /// a channel of the run's own, so each server's is its own.
    async fn run(self, ctx: RunContext<ServerDetail>) -> anyhow::Result<()> {
        let (server_health_tx, server_health_rx) = watch::channel(None);
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(None);
        let (certificate_tx, certificate_rx) = watch::channel(None);
        let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
        let server = wildflowerhealthio_wildflower_server::set_up(
            self.config,
            ServerObservers {
                server_health_tx,
                tunnel_state_tx,
                certificate_tx,
                pending_consent_tx,
            },
        )
        .await?;
        tokio::spawn(report_detail(
            DetailSources {
                launch_minter: ServerLaunchMinter::new(server.launch_context_minter()),
                sign_in_code_minter: ServerSignInCodeMinter::new(
                    server.same_device_sign_in_code_minter(),
                ),
                consent_watcher: ServerConsentWatcher::new(server.pending_consent_watcher()),
                channels: DetailChannels::new(
                    server_health_rx,
                    tunnel_state_rx,
                    certificate_rx,
                    pending_consent_rx,
                ),
            },
            ctx.clone(),
        ));
        ctx.announce_running();
        server.serve(ctx.shutdown_token().clone()).await
    }
}

/// What a run's detail is read from.
struct DetailSources {
    /// The run's launch minter, the same in every detail the run sets.
    launch_minter: ServerLaunchMinter,
    /// The run's sign-in code minter, the same in every detail the run sets.
    sign_in_code_minter: ServerSignInCodeMinter,
    /// The run's consent watcher, the same in every detail the run sets.
    consent_watcher: ServerConsentWatcher,
    /// The channels the rest of the detail is read from.
    channels: DetailChannels,
}

/// The channels a run's detail is read from, each watched until its own
/// sender drops, its last value staying in the detail: the reachability
/// monitor drops its sender once it stops, and the tunnel daemon its own once
/// the relay refuses the tunnel; the certificate's and the pending consent's live as long
/// as the server.
struct DetailChannels {
    /// The run's reachability monitor's health.
    server_health_rx: watch::Receiver<Option<ServerHealth>>,
    /// The run's tunnel daemon's state.
    tunnel_state_rx: watch::Receiver<Option<TunnelState>>,
    /// The run's certificate's state.
    certificate_rx: watch::Receiver<Option<CertificateState>>,
    /// The run's authorization server's newest pending consent.
    pending_consent_rx: watch::Receiver<Option<NewestPendingConsent>>,
    health_open: bool,
    tunnel_open: bool,
    certificate_open: bool,
}

impl DetailChannels {
    fn new(
        server_health_rx: watch::Receiver<Option<ServerHealth>>,
        tunnel_state_rx: watch::Receiver<Option<TunnelState>>,
        certificate_rx: watch::Receiver<Option<CertificateState>>,
        pending_consent_rx: watch::Receiver<Option<NewestPendingConsent>>,
    ) -> Self {
        Self {
            server_health_rx,
            tunnel_state_rx,
            certificate_rx,
            pending_consent_rx,
            health_open: true,
            tunnel_open: true,
            certificate_open: true,
        }
    }

    /// Wait for the health, the tunnel state, the certificate state or the
    /// pending consent to change, or for the sender of one of the first three
    /// to drop, after which that one is no longer watched. `false` once the
    /// pending consent's sender drops, which ends the run's report.
    async fn changed(&mut self) -> bool {
        tokio::select! {
            changed = self.server_health_rx.changed(), if self.health_open => {
                self.health_open = changed.is_ok();
            }
            changed = self.tunnel_state_rx.changed(), if self.tunnel_open => {
                self.tunnel_open = changed.is_ok();
            }
            changed = self.certificate_rx.changed(), if self.certificate_open => {
                self.certificate_open = changed.is_ok();
            }
            changed = self.pending_consent_rx.changed() => {
                return changed.is_ok();
            }
        }
        true
    }
}

/// The task each run spawns to report its [`ServerDetail`]: it merges the
/// run's health, its tunnel's state, its certificate's state, its
/// authorization server's newest pending consent, its launch minter, its
/// sign-in code minter and its consent watcher into the detail, now and each time the health, the
/// tunnel state, the certificate state or the pending consent changes. The task dies with the run's runtime, and `UnitRunner` clears the
/// detail when the run ends.
async fn report_detail(mut sources: DetailSources, ctx: RunContext<ServerDetail>) {
    loop {
        let channels = &mut sources.channels;
        ctx.set_detail(ServerDetail {
            health: channels.server_health_rx.borrow_and_update().clone(),
            tunnel: channels.tunnel_state_rx.borrow_and_update().clone(),
            certificate: channels.certificate_rx.borrow_and_update().clone(),
            pending_consent: channels.pending_consent_rx.borrow_and_update().clone(),
            launch_minter: Some(sources.launch_minter.clone()),
            sign_in_code_minter: Some(sources.sign_in_code_minter.clone()),
            consent_watcher: Some(sources.consent_watcher.clone()),
        });
        if !channels.changed().await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;
    use wildflowerhealthio_shared_structures::health_check::HealthReport;

    use super::*;

    /// Long enough for a wake that is due to come; a wake that hasn't by
    /// then isn't coming.
    const WAKE: Duration = Duration::from_millis(100);

    #[tokio::test]
    async fn the_tunnel_state_is_watched_after_the_health_closes_and_until_the_pending_consent_closes(
    ) {
        // Arrange
        let (server_health_tx, server_health_rx) = watch::channel(None);
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(None);
        let (certificate_tx, certificate_rx) = watch::channel(None);
        let (pending_consent_tx, pending_consent_rx) = watch::channel(None);
        let mut channels = DetailChannels::new(
            server_health_rx,
            tunnel_state_rx,
            certificate_rx,
            pending_consent_rx,
        );

        // Act: the monitor answers once and stops.
        server_health_tx.send_replace(Some(ServerHealth::Reachable(HealthReport::pass())));
        drop(server_health_tx);

        // Assert: the answer wakes the report, and the close once more.
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        assert!(channels.server_health_rx.borrow_and_update().is_some());
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        assert!(
            timeout(WAKE, channels.changed()).await.is_err(),
            "a closed health wakes the report no more"
        );

        // Act: the tunnel drops, then the relay refuses it, and the daemon stops.
        tunnel_state_tx.send_replace(Some(TunnelState::Reconnecting {
            error: "the relay closed the connection".to_owned(),
        }));

        // Assert: each tunnel state still reaches the detail.
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        assert!(matches!(
            *channels.tunnel_state_rx.borrow_and_update(),
            Some(TunnelState::Reconnecting { .. })
        ));
        tunnel_state_tx.send_replace(Some(TunnelState::TokenRejected));
        drop(tunnel_state_tx);
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        assert_eq!(
            *channels.tunnel_state_rx.borrow_and_update(),
            Some(TunnelState::TokenRejected)
        );
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        assert!(
            timeout(WAKE, channels.changed()).await.is_err(),
            "with the health and the tunnel closed, the report waits"
        );

        // Act / Assert: the certificate still wakes it, and the pending consent's close ends it.
        certificate_tx.send_replace(None);
        assert!(timeout(WAKE, channels.changed()).await.unwrap());
        drop(pending_consent_tx);
        assert!(!timeout(WAKE, channels.changed()).await.unwrap());
    }
}
