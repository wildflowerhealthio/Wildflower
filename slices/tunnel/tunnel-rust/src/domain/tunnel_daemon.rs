//! The tunnel supervisor: dials the relay and re-dials with backoff.
//!
//! The daemon is spawned once per server run with the relay settings from the
//! server's record, and dials for as long as the server runs, forwarding the
//! server's local port through the relay. It owns the reconnect/backoff loop
//! and awaits its own rathole child; each dial and its outcome go to the
//! tracing log. Whether the server is reachable through the relay is not the
//! tunnel's to say: the server's reachability monitor
//! (`wildflower-server-rust`) GETs its own `/health` through the public
//! origin.

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::domain::{RelayClient, RelaySettings};

/// Exponential reconnect backoff, configurable so tests don't wait on wall time.
#[derive(Debug, Clone, Copy)]
struct Backoff {
    initial: Duration,
    max: Duration,
    /// An attempt that ran at least this long before exiting (Ok or Err) is
    /// treated as a successful session and the next delay snaps back to
    /// `initial`. Without it a tunnel that flaps at startup (delay climbs to
    /// `max`), runs cleanly for hours, then drops would wait the full `max`
    /// before reconnecting instead of `initial`.
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
    /// Start the supervisor that forwards `local_port` through the relay
    /// `relay_settings` names. Spawns onto the ambient tokio runtime, and dials
    /// until the daemon is dropped.
    pub fn spawn(
        client: Arc<dyn RelayClient>,
        local_port: u16,
        relay_settings: RelaySettings,
    ) -> Self {
        Self::spawn_with_backoff(client, local_port, relay_settings, Backoff::default())
    }

    fn spawn_with_backoff(
        client: Arc<dyn RelayClient>,
        local_port: u16,
        relay_settings: RelaySettings,
        backoff: Backoff,
    ) -> Self {
        let cancel = CancellationToken::new();
        tokio::spawn(supervise(
            client,
            format!("127.0.0.1:{local_port}"),
            relay_settings,
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

/// Drive the tunnel: dial, and when the session ends re-dial with backoff,
/// until cancelled.
async fn supervise(
    client: Arc<dyn RelayClient>,
    local_addr: String,
    relay_settings: RelaySettings,
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
        let dial_result = client
            .run_once(&relay_settings, &local_addr, cancel.child_token())
            .await;
        if cancel.is_cancelled() {
            return;
        }
        let attempt_was_stable = attempt_started.elapsed() >= backoff.stable_threshold;
        // The session ended; either way we back off before re-dialing. A clean
        // exit (the relay closed a healthy session) resets the backoff.
        match dial_result {
            Ok(()) => {
                tracing::info!(attempt, "tunnel: relay session ended; re-dialing");
                delay = backoff.initial;
            }
            Err(error) => {
                tracing::warn!(attempt, error = %format!("{error:#}"), "tunnel: dial failed; retrying");
                if attempt_was_stable {
                    delay = backoff.initial;
                }
            }
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
    pub(crate) fn spawn_test(client: Arc<dyn RelayClient>, relay_settings: RelaySettings) -> Self {
        Self::spawn_with_backoff(
            client,
            8080,
            relay_settings,
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
    use std::sync::atomic::{AtomicBool, Ordering};

    use parking_lot::Mutex;
    use tokio::sync::mpsc;

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

    /// A relay client that errors immediately, driving the reconnect loop, and
    /// reports each dial on a channel so a test can count them.
    struct FailImmediatelyRelayClient(mpsc::UnboundedSender<()>);

    #[async_trait::async_trait]
    impl RelayClient for FailImmediatelyRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            let _ = self.0.send(());
            Err(anyhow::anyhow!("relay unreachable"))
        }
    }

    /// The daemon dials the relay it was given, forwarding the local port it
    /// was given, and holds the session while it is up.
    #[tokio::test(start_paused = true)]
    async fn dials_with_the_settings_it_was_given() {
        /// Records each dial's relay settings and local address, then holds.
        struct RecordingRelayClient {
            dials: Mutex<Vec<(RelaySettings, String)>>,
            dialed: mpsc::UnboundedSender<()>,
        }
        #[async_trait::async_trait]
        impl RelayClient for RecordingRelayClient {
            async fn run_once(
                &self,
                relay: &RelaySettings,
                local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                self.dials
                    .lock()
                    .push((relay.clone(), local_addr.to_owned()));
                let _ = self.dialed.send(());
                cancel.cancelled().await;
                Ok(())
            }
        }

        let (dialed, mut dials) = mpsc::unbounded_channel();
        let client = Arc::new(RecordingRelayClient {
            dials: Mutex::new(Vec::new()),
            dialed,
        });
        let given = RelaySettings {
            remote_addr: "relay.example.org:4444".into(),
            token: "given-token".into(),
            public_key: "given-key".into(),
            service_name: "given".into(),
        };
        let _daemon =
            TunnelDaemon::spawn_test(Arc::clone(&client) as Arc<dyn RelayClient>, given.clone());
        dials.recv().await.expect("dialed");
        // Long past any backoff: a held session is not re-dialed.
        tokio::time::sleep(Duration::from_secs(60)).await;

        assert_eq!(
            *client.dials.lock(),
            vec![(given, "127.0.0.1:8080".to_owned())],
            "dialed once, with the given relay settings, forwarding the local port",
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_dial_is_retried() {
        let (dialed, mut dials) = mpsc::unbounded_channel();
        let _daemon =
            TunnelDaemon::spawn_test(Arc::new(FailImmediatelyRelayClient(dialed)), relay());
        dials.recv().await.expect("dial 1");
        dials.recv().await.expect("dial 2");
        dials.recv().await.expect("dial 3");
    }

    #[tokio::test(start_paused = true)]
    async fn a_clean_session_end_is_redialed() {
        /// Ends its first session cleanly (the relay closed a healthy
        /// connection), then holds; reports each dial.
        struct CleanExitThenHold {
            ended_once: AtomicBool,
            dialed: mpsc::UnboundedSender<()>,
        }
        #[async_trait::async_trait]
        impl RelayClient for CleanExitThenHold {
            async fn run_once(
                &self,
                _relay: &RelaySettings,
                _local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                let _ = self.dialed.send(());
                if !self.ended_once.swap(true, Ordering::SeqCst) {
                    return Ok(());
                }
                cancel.cancelled().await;
                Ok(())
            }
        }

        let (dialed, mut dials) = mpsc::unbounded_channel();
        let _daemon = TunnelDaemon::spawn_test(
            Arc::new(CleanExitThenHold {
                ended_once: AtomicBool::new(false),
                dialed,
            }),
            relay(),
        );
        dials.recv().await.expect("first session");
        dials.recv().await.expect("re-dialed after the clean end");
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
                _local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                let _ = self.dialed.send(());
                cancel.cancelled().await;
                Ok(())
            }
        }

        let (client_alive, mut client_dropped) = mpsc::channel(1);
        let (dialed, mut dials) = mpsc::unbounded_channel();
        let daemon = TunnelDaemon::spawn_test(
            Arc::new(HeldUntilSupervisorEnds {
                _alive: client_alive,
                dialed,
            }),
            relay(),
        );
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
