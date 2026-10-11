//! The tunnel supervisor: dials the relay and re-dials with backoff.
//!
//! The daemon is spawned once per server run with the relay settings from the
//! server's record, and dials for as long as the server runs, handing each
//! visitor's stream to the server's tunnel listener. It owns the
//! reconnect/backoff loop and awaits its own rathole child; each dial and its
//! outcome go to the tracing log, and it publishes its [`TunnelState`] on the
//! host's channel, from which the server's `/health` reports its
//! `connectivity`. A relay that refuses the tunnel's token, or has no tunnel
//! of its name, stops the dialing: the next run, with the server's record as
//! it then stands, dials again. Whether the server is reachable through the
//! relay is not the tunnel's to say: the server's reachability monitor
//! (`wildflower-server-rust`) GETs its own `/health` through the public
//! origin.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::domain::{DialFailure, RelayClient, RelaySettings, TunnelState, TunnelStream};

/// Exponential reconnect backoff, configurable so tests don't wait on wall time.
#[derive(Debug, Clone, Copy)]
struct Backoff {
    initial: Duration,
    max: Duration,
    /// An attempt that ran at least this long before it dropped is treated as
    /// a successful session and the next delay snaps back to `initial`.
    /// Without it a tunnel that flaps at startup (delay climbs to `max`), runs
    /// cleanly for hours, then drops would wait the full `max` before
    /// reconnecting instead of `initial`.
    stable_threshold: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(30),
            stable_threshold: Duration::from_secs(60),
        }
    }
}

/// The running tunnel: the token that stops its supervisor when the daemon is
/// dropped.
pub struct TunnelDaemon {
    /// Cancelled on drop, so the supervisor stops dialing once nothing holds
    /// the daemon.
    cancel: CancellationToken,
}

impl TunnelDaemon {
    /// Start the supervisor that dials the relay `relay_settings` names and
    /// sends each visitor's stream to `tunnel_stream_tx`, publishing its
    /// [`TunnelState`] on `tunnel_state_tx`, [`TunnelState::Connecting`] from
    /// the start. Spawns onto the ambient tokio runtime, and dials until the
    /// relay refuses the tunnel or the daemon is dropped.
    pub fn spawn(
        client: Arc<dyn RelayClient>,
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        relay_settings: RelaySettings,
        tunnel_state_tx: watch::Sender<Option<TunnelState>>,
    ) -> Self {
        Self::spawn_with_backoff(
            client,
            tunnel_stream_tx,
            relay_settings,
            tunnel_state_tx,
            Backoff::default(),
        )
    }

    fn spawn_with_backoff(
        client: Arc<dyn RelayClient>,
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        relay_settings: RelaySettings,
        tunnel_state_tx: watch::Sender<Option<TunnelState>>,
        backoff: Backoff,
    ) -> Self {
        let cancel = CancellationToken::new();
        tunnel_state_tx.send_replace(Some(TunnelState::Connecting));
        tokio::spawn(supervise(
            client,
            tunnel_stream_tx,
            relay_settings,
            tunnel_state_tx,
            cancel.clone(),
            backoff,
        ));
        Self { cancel }
    }
}

impl Drop for TunnelDaemon {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Drive the tunnel: dial, and when the dial fails or the connection drops
/// re-dial with backoff, until the relay refuses the tunnel or the supervisor
/// is cancelled.
async fn supervise(
    client: Arc<dyn RelayClient>,
    tunnel_stream_tx: mpsc::Sender<TunnelStream>,
    relay_settings: RelaySettings,
    tunnel_state_tx: watch::Sender<Option<TunnelState>>,
    cancel: CancellationToken,
    backoff: Backoff,
) {
    let mut delay = backoff.initial;
    let mut attempt: i64 = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        attempt = attempt.saturating_add(1);
        let attempt_started = tokio::time::Instant::now();
        tracing::info!(
            attempt,
            remote_addr = %relay_settings.remote_addr,
            "tunnel: dialing relay"
        );
        // The client stops on the child token, so a cancel ends the dial too.
        let (connected_tx, connected_rx) = oneshot::channel();
        let dial = client.run_once(
            &relay_settings,
            tunnel_stream_tx.clone(),
            connected_tx,
            cancel.child_token(),
        );
        tokio::pin!(dial);
        let dial_result = tokio::select! {
            dial_result = &mut dial => dial_result,
            Ok(()) = connected_rx => {
                tracing::info!(attempt, "tunnel: connected to relay");
                tunnel_state_tx.send_replace(Some(TunnelState::Connected));
                dial.await
            }
        };
        // A stopped daemon publishes nothing more, whatever the dial ended
        // with.
        if cancel.is_cancelled() {
            return;
        }
        let error = match dial_result {
            // Only a cancel resolves the dial `Ok`.
            Ok(()) => return,
            Err(DialFailure::TokenRejected) => {
                tracing::error!(
                    attempt,
                    "tunnel: the relay rejected the tunnel's token; stopped dialing"
                );
                tunnel_state_tx.send_replace(Some(TunnelState::TokenRejected));
                return;
            }
            Err(DialFailure::TunnelUnknown) => {
                tracing::error!(
                    attempt,
                    service_name = %relay_settings.service_name,
                    "tunnel: the relay has no tunnel of this name; stopped dialing"
                );
                tunnel_state_tx.send_replace(Some(TunnelState::TunnelUnknown));
                return;
            }
            Err(DialFailure::Dropped(error)) => format!("{error:#}"),
        };
        tracing::warn!(attempt, %error, "tunnel: relay connection dropped; retrying");
        tunnel_state_tx.send_replace(Some(TunnelState::Reconnecting { error }));
        if attempt_started.elapsed() >= backoff.stable_threshold {
            delay = backoff.initial;
        }
        tokio::select! {
            () = tokio::time::sleep(jittered(delay)) => {}
            () = cancel.cancelled() => return,
        }
        delay = (delay * 2).min(backoff.max);
    }
}

/// Equal-jitter backoff: returns a duration in `[base / 2, base]`. Half
/// deterministic so retries don't pile near zero; half random so concurrent
/// losers of a relay session don't reconnect in lockstep.
fn jittered(base: Duration) -> Duration {
    let half = base / 2;
    half + half.mul_f64(rand::random::<f64>())
}

#[cfg(test)]
impl TunnelDaemon {
    /// Spawn with a near-zero backoff so reconnect tests don't wait on wall
    /// time. 1ms (not zero) keeps the retry loop from busy-spinning the
    /// runtime.
    pub(crate) fn spawn_test(
        client: Arc<dyn RelayClient>,
        tunnel_stream_tx: mpsc::Sender<TunnelStream>,
        relay_settings: RelaySettings,
        tunnel_state_tx: watch::Sender<Option<TunnelState>>,
    ) -> Self {
        Self::spawn_with_backoff(
            client,
            tunnel_stream_tx,
            relay_settings,
            tunnel_state_tx,
            Backoff {
                initial: Duration::from_millis(1),
                max: Duration::from_millis(1),
                // Far larger than anything a test will let an attempt run, so
                // the stable-attempt reset doesn't fire by accident.
                stable_threshold: Duration::from_secs(3600),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::time::Instant;
    use wildflowerhealthio_shared_structures::health_check::HealthStatus;

    use super::*;

    /// A relay connection for tests that never reach a real relay.
    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    /// What a [`ScriptedRelayClient`] dial does.
    #[derive(Clone, Copy)]
    enum Dial {
        /// Fails before connecting: the relay is unreachable.
        Unreachable,
        /// Connects, then the connection drops.
        ConnectThenDrop,
        /// Connects, and holds until cancelled.
        ConnectAndHold,
        /// Holds until cancelled without connecting.
        HoldUnconnected,
        /// The relay rejects the token.
        RejectToken,
        /// The relay has no such tunnel.
        UnknownTunnel,
    }

    /// A relay client whose dials follow a script, the last dial repeating
    /// once the script runs out, and which reports when each dial starts on
    /// a channel so a test can count them.
    struct ScriptedRelayClient {
        dials: Mutex<Vec<Dial>>,
        dialed: mpsc::UnboundedSender<Instant>,
    }

    impl ScriptedRelayClient {
        fn new(dials: &[Dial]) -> (Arc<Self>, mpsc::UnboundedReceiver<Instant>) {
            let (dialed, dial_times) = mpsc::unbounded_channel();
            let client = Self {
                dials: Mutex::new(dials.iter().rev().copied().collect()),
                dialed,
            };
            (Arc::new(client), dial_times)
        }
    }

    #[async_trait::async_trait]
    impl RelayClient for ScriptedRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _tunnel_stream_tx: mpsc::Sender<TunnelStream>,
            connected_tx: oneshot::Sender<()>,
            cancel: CancellationToken,
        ) -> Result<(), DialFailure> {
            let _ = self.dialed.send(Instant::now());
            let dial = {
                let mut dials = self.dials.lock();
                if dials.len() > 1 {
                    dials.pop()
                } else {
                    dials.last().copied()
                }
            };
            match dial.expect("a scripted dial") {
                Dial::Unreachable => {
                    Err(DialFailure::Dropped(anyhow::anyhow!("relay unreachable")))
                }
                Dial::ConnectThenDrop => {
                    let _ = connected_tx.send(());
                    Err(DialFailure::Dropped(anyhow::anyhow!("heartbeat timed out")))
                }
                Dial::ConnectAndHold => {
                    let _ = connected_tx.send(());
                    cancel.cancelled().await;
                    Ok(())
                }
                Dial::HoldUnconnected => {
                    cancel.cancelled().await;
                    Ok(())
                }
                Dial::RejectToken => Err(DialFailure::TokenRejected),
                Dial::UnknownTunnel => Err(DialFailure::TunnelUnknown),
            }
        }
    }

    /// A sender for a test that never looks at the streams handed over.
    fn unread_tunnel_stream_tx() -> mpsc::Sender<TunnelStream> {
        mpsc::channel(1).0
    }

    /// Spawn the daemon over `client` with the test backoff, and the
    /// receiver of the state it publishes.
    fn spawn_daemon(
        client: Arc<dyn RelayClient>,
    ) -> (TunnelDaemon, watch::Receiver<Option<TunnelState>>) {
        let (tunnel_state_tx, tunnel_state_rx) = watch::channel(None);
        let daemon =
            TunnelDaemon::spawn_test(client, unread_tunnel_stream_tx(), relay(), tunnel_state_tx);
        (daemon, tunnel_state_rx)
    }

    /// Wait, within a bound, for the published state to satisfy `matches`.
    async fn until_state(
        tunnel_state_rx: &mut watch::Receiver<Option<TunnelState>>,
        matches: impl FnMut(&Option<TunnelState>) -> bool,
    ) -> TunnelState {
        tokio::time::timeout(Duration::from_secs(5), tunnel_state_rx.wait_for(matches))
            .await
            .expect("the state is published within the bound")
            .expect("the test holds the state sender")
            .clone()
            .expect("a state")
    }

    /// The daemon dials the relay it was given, hands the visitor streams the
    /// client brings to the sender it was given, and holds the session while
    /// it is up.
    #[tokio::test(start_paused = true)]
    async fn dials_the_relay_it_was_given_and_hands_over_its_streams() {
        /// The bytes the visitor sends down the stream the client hands over.
        const VISITOR_BYTES: &[u8] = b"GET / HTTP/1.1";

        /// Records each dial's relay settings and hands over one visitor's
        /// stream, then holds.
        struct RecordingRelayClient {
            dials: Mutex<Vec<RelaySettings>>,
        }
        #[async_trait::async_trait]
        impl RelayClient for RecordingRelayClient {
            async fn run_once(
                &self,
                relay: &RelaySettings,
                tunnel_stream_tx: mpsc::Sender<TunnelStream>,
                connected_tx: oneshot::Sender<()>,
                cancel: CancellationToken,
            ) -> Result<(), DialFailure> {
                self.dials.lock().push(relay.clone());
                let _ = connected_tx.send(());
                let (mut visitor, tunnel_stream) = tokio::io::duplex(64);
                visitor.write_all(VISITOR_BYTES).await.expect("write");
                tunnel_stream_tx
                    .send(Box::new(tunnel_stream))
                    .await
                    .unwrap_or_else(|_| panic!("the test takes the stream"));
                cancel.cancelled().await;
                Ok(())
            }
        }

        let client = Arc::new(RecordingRelayClient {
            dials: Mutex::new(Vec::new()),
        });
        let given = RelaySettings {
            remote_addr: "relay.example.org:4444".into(),
            token: "given-token".into(),
            public_key: "given-key".into(),
            service_name: "given".into(),
        };
        let (tunnel_stream_tx, mut tunnel_stream_rx) = mpsc::channel(1);
        let _daemon = TunnelDaemon::spawn_test(
            Arc::clone(&client) as Arc<dyn RelayClient>,
            tunnel_stream_tx,
            given.clone(),
            watch::channel(None).0,
        );
        let mut tunnel_stream = tunnel_stream_rx.recv().await.expect("a stream handed over");
        let mut received = vec![0; VISITOR_BYTES.len()];
        tunnel_stream
            .read_exact(&mut received)
            .await
            .expect("the visitor's bytes");
        assert_eq!(received, VISITOR_BYTES);
        // Long past any backoff: a held session is not re-dialed.
        tokio::time::sleep(Duration::from_secs(60)).await;

        assert_eq!(
            *client.dials.lock(),
            vec![given],
            "dialed once, with the given relay settings",
        );
    }

    /// Until the relay accepts the control channel, the tunnel is
    /// connecting, and warns.
    #[tokio::test(start_paused = true)]
    async fn the_first_dial_publishes_connecting() {
        let (client, mut dials) = ScriptedRelayClient::new(&[Dial::HoldUnconnected]);
        let (_daemon, tunnel_state_rx) = spawn_daemon(client);
        assert_eq!(*tunnel_state_rx.borrow(), Some(TunnelState::Connecting));
        dials.recv().await.expect("dialed");
        tokio::time::sleep(Duration::from_secs(60)).await;
        let tunnel_state = tunnel_state_rx.borrow().clone().expect("a state");
        assert_eq!(
            (&tunnel_state, tunnel_state.connectivity()),
            (&TunnelState::Connecting, HealthStatus::Warn)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_connected_dial_publishes_connected() {
        let (client, _dials) = ScriptedRelayClient::new(&[Dial::ConnectAndHold]);
        let (_daemon, mut tunnel_state_rx) = spawn_daemon(client);
        let tunnel_state = until_state(&mut tunnel_state_rx, |tunnel_state| {
            tunnel_state != &Some(TunnelState::Connecting)
        })
        .await;
        assert_eq!(
            (&tunnel_state, tunnel_state.connectivity()),
            (&TunnelState::Connected, HealthStatus::Pass)
        );
    }

    /// A failed dial is retried, and the tunnel is reconnecting, with why, and
    /// warns meanwhile.
    #[tokio::test(start_paused = true)]
    async fn a_failed_dial_is_retried_and_publishes_reconnecting() {
        let (client, mut dials) = ScriptedRelayClient::new(&[Dial::Unreachable]);
        let (_daemon, tunnel_state_rx) = spawn_daemon(client);
        dials.recv().await.expect("dial 1");
        dials.recv().await.expect("dial 2");
        dials.recv().await.expect("dial 3");
        let tunnel_state = tunnel_state_rx.borrow().clone().expect("a state");
        assert_eq!(
            (&tunnel_state, tunnel_state.connectivity()),
            (
                &TunnelState::Reconnecting {
                    error: "relay unreachable".into()
                },
                HealthStatus::Warn
            )
        );
    }

    /// A connection that drops is re-dialed, and the tunnel connects again.
    #[tokio::test(start_paused = true)]
    async fn a_dropped_connection_is_redialed() {
        let (client, mut dials) =
            ScriptedRelayClient::new(&[Dial::ConnectThenDrop, Dial::ConnectAndHold]);
        let (_daemon, mut tunnel_state_rx) = spawn_daemon(client);
        dials.recv().await.expect("first connection");
        dials.recv().await.expect("re-dialed after the drop");
        let tunnel_state = until_state(&mut tunnel_state_rx, |tunnel_state| {
            tunnel_state == &Some(TunnelState::Connected)
        })
        .await;
        assert_eq!(tunnel_state.connectivity(), HealthStatus::Pass);
    }

    /// Each re-dial waits twice as long as the last, up to the maximum, with
    /// jitter of up to half the delay.
    #[tokio::test(start_paused = true)]
    async fn redials_back_off_exponentially() {
        let (client, mut dials) = ScriptedRelayClient::new(&[Dial::ConnectThenDrop]);
        let (tunnel_state_tx, _tunnel_state_rx) = watch::channel(None);
        let _daemon = TunnelDaemon::spawn_with_backoff(
            client,
            unread_tunnel_stream_tx(),
            relay(),
            tunnel_state_tx,
            Backoff {
                initial: Duration::from_secs(1),
                max: Duration::from_secs(4),
                stable_threshold: Duration::from_secs(3600),
            },
        );
        let mut last_dial = dials.recv().await.expect("dial 1");
        for delay in [1, 2, 4, 4].map(Duration::from_secs) {
            let dial = dials.recv().await.expect("a re-dial");
            let waited = dial - last_dial;
            assert!(
                delay / 2 <= waited && waited <= delay,
                "waited {waited:?} for a delay of {delay:?}"
            );
            last_dial = dial;
        }
    }

    /// A rejected token, or a tunnel the relay doesn't know, fails the tunnel
    /// and stops the dialing: a re-dial with the same settings would be
    /// refused again.
    #[tokio::test(start_paused = true)]
    async fn a_refused_tunnel_publishes_fail_and_stops_dialing() {
        for (dial, refused) in [
            (Dial::RejectToken, TunnelState::TokenRejected),
            (Dial::UnknownTunnel, TunnelState::TunnelUnknown),
        ] {
            // Refused on a re-dial, after the first dial was dropped.
            let (client, mut dials) = ScriptedRelayClient::new(&[Dial::Unreachable, dial]);
            let (_daemon, mut tunnel_state_rx) = spawn_daemon(client);
            let tunnel_state = until_state(&mut tunnel_state_rx, |tunnel_state| {
                tunnel_state.as_ref() == Some(&refused)
            })
            .await;
            assert_eq!(tunnel_state.connectivity(), HealthStatus::Fail);
            // Long past any backoff: no further dial.
            tokio::time::sleep(Duration::from_secs(3600)).await;
            let mut dial_count = 0;
            while dials.try_recv().is_ok() {
                dial_count += 1;
            }
            assert_eq!(dial_count, 2, "dialed until refused, then stopped");
            assert_eq!(tunnel_state_rx.borrow().as_ref(), Some(&refused));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_daemon_stops_the_supervisor() {
        /// Holds each dial until cancelled. Its channel closes once the
        /// supervisor, the client's only owner, has ended and dropped it.
        struct HeldUntilSupervisorEnds {
            _alive: mpsc::Sender<()>,
            dialed: mpsc::UnboundedSender<()>,
        }
        #[async_trait::async_trait]
        impl RelayClient for HeldUntilSupervisorEnds {
            async fn run_once(
                &self,
                _relay: &RelaySettings,
                _tunnel_stream_tx: mpsc::Sender<TunnelStream>,
                _connected_tx: oneshot::Sender<()>,
                cancel: CancellationToken,
            ) -> Result<(), DialFailure> {
                let _ = self.dialed.send(());
                cancel.cancelled().await;
                Ok(())
            }
        }

        let (client_alive, mut client_dropped) = mpsc::channel(1);
        let (dialed, mut dials) = mpsc::unbounded_channel();
        let (daemon, _tunnel_state_rx) = spawn_daemon(Arc::new(HeldUntilSupervisorEnds {
            _alive: client_alive,
            dialed,
        }));
        dials.recv().await.expect("dialed");

        drop(daemon);
        // A supervisor that kept running would hold the client forever; bound
        // the wait so that fails rather than hangs.
        let closed = tokio::time::timeout(Duration::from_secs(5), client_dropped.recv())
            .await
            .expect("the supervisor ended within the bound");
        assert!(closed.is_none(), "the supervisor dropped its relay client");
    }
}
