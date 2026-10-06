//! The tunnel supervisor and the liveness state machine.
//!
//! The daemon is spawned once per server run with the relay settings and public
//! host from the server's record, and dials for as long as the server runs,
//! forwarding the server's local port through the relay. What state the tunnel
//! is in, and any error, is in-memory and resets per process. The supervisor
//! owns the reconnect/backoff loop, awaits its own rathole child, *and* drives a
//! concurrent `/health` probe through the public origin, so the tunnel only
//! reads as `Verified` once a round trip through the relay has come back
//! healthy.
//!
//! ## TunnelLiveness state machine
//!
//! One [`TunnelStatus`] and its error, published on a `watch` so every consumer
//! (the HTTP `GET /tunnel`, the host's tunnel-drop notifications) reads one
//! coherent value:
//!
//! ```text
//!   spawn ──────────────────────────────────► Dialing
//!                                  ▲             │ probe pass
//!                      dial drops/ │             ▼
//!                      probe fails └───────── Verified
//!                            (Unreachable ◄──► Verified as probes flip)
//! ```
//!
//! The supervisor re-probes on an interval, so a tunnel that silently drops
//! falls back out of `Verified`.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::domain::{RelayClient, RelaySettings, TunnelLiveness, TunnelStatus};
use crate::health::HealthProbe;

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

/// Cadence + deadline for the `/health` probe the supervisor runs while the
/// tunnel is dialing. Configurable so tests drive it on virtual time.
#[derive(Debug, Clone, Copy)]
struct ProbeTiming {
    /// How long to wait before the first probe of an attempt (let the handshake
    /// settle) and between probes while the tunnel is not yet `Verified`. Short
    /// so the initial verdict — and recovery from a transient failure — surface
    /// quickly.
    interval: Duration,
    /// How long to wait between re-probes once the tunnel has `Verified`. A
    /// healthy steady-state only needs an occasional liveness check, so we slow
    /// the cadence down rather than burning relay traffic on a back-to-back
    /// `/health` poll.
    verified_interval: Duration,
    /// How long a single probe may take before it counts as a failure — the
    /// "identify failures after 3 seconds" deadline.
    timeout: Duration,
}

impl Default for ProbeTiming {
    fn default() -> Self {
        Self {
            interval: Duration::from_millis(400),
            verified_interval: Duration::from_secs(30),
            timeout: Duration::from_secs(3),
        }
    }
}

/// The running tunnel: the liveness watch its supervisor publishes on, and the
/// token that stops the supervisor when the daemon is dropped.
pub struct TunnelDaemon {
    state_tx: watch::Sender<TunnelLiveness>,
    /// Cancelled on drop, so the supervisor stops dialing once nothing holds
    /// the daemon.
    cancel: CancellationToken,
}

impl TunnelDaemon {
    /// Start the supervisor that forwards `local_port` through the relay
    /// `relay_settings` names, serving it at `public_host`. Spawns onto the
    /// ambient tokio runtime, and dials until the daemon is dropped.
    pub fn spawn(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        local_port: u16,
        relay_settings: RelaySettings,
        public_host: impl Into<String>,
    ) -> Self {
        Self::spawn_with_tuning(
            client,
            probe,
            local_port,
            relay_settings,
            public_host,
            Backoff::default(),
            ProbeTiming::default(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_with_tuning(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        local_port: u16,
        relay_settings: RelaySettings,
        public_host: impl Into<String>,
        backoff: Backoff,
        probe_timing: ProbeTiming,
    ) -> Self {
        let public_host = public_host.into();
        let (state_tx, _) = watch::channel(TunnelLiveness {
            status: TunnelStatus::Dialing,
            error: None,
        });
        let cancel = CancellationToken::new();
        tokio::spawn(supervise(SupervisorJob {
            state: state_tx.clone(),
            client,
            probe,
            local_addr: format!("127.0.0.1:{local_port}"),
            public_origin: format!("https://{public_host}"),
            relay_settings,
            cancel: cancel.clone(),
            backoff,
            probe_timing,
        }));
        Self { state_tx, cancel }
    }

    /// A snapshot of the current liveness.
    pub(crate) fn liveness(&self) -> TunnelLiveness {
        self.state_tx.borrow().clone()
    }

    /// Subscribe to liveness transitions. Consumers `borrow()` for the live
    /// value or `await changed()` for transitions.
    pub(crate) fn watch_liveness(&self) -> watch::Receiver<TunnelLiveness> {
        self.state_tx.subscribe()
    }
}

impl Drop for TunnelDaemon {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Everything the spawned supervisor needs, bundled so `spawn` hands off a
/// single value (rather than a long argument list).
struct SupervisorJob {
    state: watch::Sender<TunnelLiveness>,
    client: Arc<dyn RelayClient>,
    probe: Arc<dyn HealthProbe>,
    local_addr: String,
    /// The public `https://{host}` the relay serves the server at, which the
    /// probe round-trips through.
    public_origin: String,
    relay_settings: RelaySettings,
    cancel: CancellationToken,
    backoff: Backoff,
    probe_timing: ProbeTiming,
}

/// Drive the tunnel: reconnect with backoff until cancelled, probing `/health`
/// while each attempt is in flight so the state tracks real reachability.
async fn supervise(job: SupervisorJob) {
    let SupervisorJob {
        state,
        client,
        probe,
        local_addr,
        public_origin,
        relay_settings,
        cancel,
        backoff,
        probe_timing,
    } = job;

    let mut delay = backoff.initial;
    let mut attempt: i64 = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        attempt = attempt.saturating_add(1);
        // A fresh attempt is dialing, not yet verified.
        set_state(&state, TunnelStatus::Dialing, None);
        let attempt_started = tokio::time::Instant::now();
        tracing::info!(
            attempt,
            public_origin = %public_origin,
            "tunnel: dialing relay"
        );
        let dial = client.run_once(&relay_settings, &local_addr, cancel.child_token());
        tokio::pin!(dial);
        let dial_result = dial_with_probes(
            &mut dial,
            &state,
            probe.as_ref(),
            &public_origin,
            &cancel,
            probe_timing,
        )
        .await;
        if cancel.is_cancelled() {
            return;
        }
        let attempt_was_stable = attempt_started.elapsed() >= backoff.stable_threshold;
        // The session ended; either way we back off before re-dialing. A clean exit (`Ok`) is not a failure, so publish
        // `Dialing` (we're about to reconnect) rather than an errorless
        // `Unreachable` — that keeps `Unreachable` meaning "something went
        // wrong" with a reason attached. An `Err` publishes `Unreachable` with
        // the cause.
        let (status, error) = match dial_result {
            Ok(()) => {
                delay = backoff.initial;
                (TunnelStatus::Dialing, None)
            }
            Err(error) => {
                if attempt_was_stable {
                    delay = backoff.initial;
                }
                (TunnelStatus::Unreachable, Some(format!("{error:#}")))
            }
        };
        set_state(&state, status, error);
        tokio::select! {
            () = tokio::time::sleep(jittered(delay)) => {}
            () = cancel.cancelled() => return,
        }
        delay = (delay * 2).min(backoff.max);
    }
}

/// Probe `/health` on an interval while `dial` is in flight, moving the state
/// between `Verified` and `Unreachable` as the probe passes or fails. Returns
/// when the dial future resolves (the session ended) or the run is cancelled.
async fn dial_with_probes<D>(
    dial: &mut D,
    state: &watch::Sender<TunnelLiveness>,
    probe: &dyn HealthProbe,
    public_origin: &str,
    cancel: &CancellationToken,
    timing: ProbeTiming,
) -> anyhow::Result<()>
where
    D: std::future::Future<Output = anyhow::Result<()>> + Unpin,
{
    let health_url = format!("{public_origin}/health");
    // First probe fires after `interval` (give the handshake a moment); the gap
    // between subsequent probes depends on the last verdict — `verified_interval`
    // while the tunnel is `Verified`, `interval` otherwise so a recovery is
    // noticed quickly. Sleeping *after* each probe (rather than driving the loop
    // off a fixed-period ticker) means a slow probe never bursts catch-up ticks.
    let mut next_delay = timing.interval;
    loop {
        tokio::select! {
            result = &mut *dial => return result,
            () = cancel.cancelled() => return Ok(()),
            () = tokio::time::sleep(next_delay) => {
                // Keep the dial and the cancel responsive *while the probe is in
                // flight*: a probe may run up to `timeout`, and parking the whole
                // loop on it would defer a cancel (and noticing the session
                // ended) by that long. Race the probe against both.
                let outcome = tokio::select! {
                    result = &mut *dial => return result,
                    () = cancel.cancelled() => return Ok(()),
                    outcome = probe_once(probe, &health_url, timing.timeout) => outcome,
                };
                let (status, error) = match outcome {
                    Ok(()) => (TunnelStatus::Verified, None),
                    Err(reason) => (TunnelStatus::Unreachable, Some(reason)),
                };
                next_delay = match status {
                    TunnelStatus::Verified => timing.verified_interval,
                    _ => timing.interval,
                };
                set_state(state, status, error);
            }
        }
    }
}

/// One bounded `/health` probe: a timeout or an unhealthy/unreachable response
/// fails the attempt; any healthy response verifies it.
async fn probe_once(
    probe: &dyn HealthProbe,
    health_url: &str,
    timeout: Duration,
) -> Result<(), String> {
    let started = tokio::time::Instant::now();
    let result = match tokio::time::timeout(timeout, probe.probe(health_url)).await {
        Err(_elapsed) => Err(format!("/health did not respond within {timeout:?}")),
        Ok(Err(reason)) => Err(format!("/health probe failed: {reason}")),
        Ok(Ok(())) => Ok(()),
    };
    match &result {
        Ok(()) => {
            tracing::debug!(url = %health_url, elapsed = ?started.elapsed(), "tunnel: /health probe ok")
        }
        Err(reason) => tracing::debug!(
            url = %health_url,
            elapsed = ?started.elapsed(),
            %reason,
            "tunnel: /health probe failed"
        ),
    }
    result
}

/// Equal-jitter backoff: returns a duration in `[base / 2, base]`. Half
/// deterministic so retries don't pile near zero; half random so concurrent
/// losers of a relay session don't reconnect in lockstep.
fn jittered(base: Duration) -> Duration {
    let half = base / 2;
    half + half.mul_f64(rand::random::<f64>())
}

/// Apply a liveness update, publishing only a real change.
fn set_state(state: &watch::Sender<TunnelLiveness>, status: TunnelStatus, error: Option<String>) {
    state.send_if_modified(|live| {
        if live.status == status && live.error == error {
            return false;
        }
        tracing::debug!(
            new_status = ?status,
            error = error.as_deref(),
            "tunnel: liveness transition"
        );
        live.status = status;
        live.error = error;
        true
    });
}

#[cfg(test)]
impl TunnelDaemon {
    /// Spawn with a near-zero backoff and fast probe timing so reconnect/probe
    /// tests don't wait on wall time. 1ms (not zero) keeps the retry loop from
    /// busy-spinning the runtime.
    pub(crate) fn spawn_test(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        relay_settings: RelaySettings,
        public_host: impl Into<String>,
    ) -> Self {
        Self::spawn_with_tuning(
            client,
            probe,
            8080,
            relay_settings,
            public_host,
            Backoff {
                initial: Duration::from_millis(1),
                max: Duration::from_millis(1),
                // Far larger than anything a test will let an attempt run, so
                // the stable-attempt reset doesn't fire by accident.
                stable_threshold: Duration::from_secs(3600),
            },
            ProbeTiming {
                interval: Duration::from_millis(1),
                verified_interval: Duration::from_millis(1),
                timeout: Duration::from_millis(50),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use parking_lot::Mutex;

    use super::*;
    use crate::test_support::{relay, HoldUntilCancelRelayClient, StubProbe};

    /// A relay client that errors immediately, driving the reconnect loop, and
    /// reports each dial on a channel so a test can count them.
    struct FailImmediatelyRelayClient(tokio::sync::mpsc::UnboundedSender<()>);

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

    fn daemon_with(client: Arc<dyn RelayClient>, probe: Arc<dyn HealthProbe>) -> TunnelDaemon {
        TunnelDaemon::spawn_test(client, probe, relay(), "dev1.example.com")
    }

    /// The daemon dials the relay it was given, forwarding the local port it
    /// was given, and probes `/health` at the public host it was given.
    #[tokio::test(start_paused = true)]
    async fn dials_with_the_settings_it_was_given() {
        /// Records each dial's relay settings and local address, then holds.
        #[derive(Default)]
        struct RecordingRelayClient(Mutex<Vec<(RelaySettings, String)>>);
        #[async_trait::async_trait]
        impl RelayClient for RecordingRelayClient {
            async fn run_once(
                &self,
                relay: &RelaySettings,
                local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                self.0.lock().push((relay.clone(), local_addr.to_owned()));
                cancel.cancelled().await;
                Ok(())
            }
        }

        /// Records each probed URL, then passes.
        #[derive(Default)]
        struct RecordingProbe(Mutex<Vec<String>>);
        #[async_trait::async_trait]
        impl HealthProbe for RecordingProbe {
            async fn probe(&self, url: &str) -> Result<(), String> {
                self.0.lock().push(url.to_owned());
                Ok(())
            }
        }

        let client = Arc::new(RecordingRelayClient::default());
        let probe = Arc::new(RecordingProbe::default());
        let given = RelaySettings {
            remote_addr: "relay.example.org:4444".into(),
            token: "given-token".into(),
            public_key: "given-key".into(),
            service_name: "given".into(),
        };
        let daemon = TunnelDaemon::spawn_test(
            Arc::clone(&client) as Arc<dyn RelayClient>,
            Arc::clone(&probe) as Arc<dyn HealthProbe>,
            given.clone(),
            "given.relay.example.org",
        );
        daemon
            .watch_liveness()
            .wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("verified");

        assert_eq!(
            *client.0.lock(),
            vec![(given, "127.0.0.1:8080".to_owned())],
            "dialed once, with the given relay settings, forwarding the local port",
        );
        assert_eq!(
            probe.0.lock().first().map(String::as_str),
            Some("https://given.relay.example.org/health"),
        );
    }

    #[tokio::test]
    async fn a_new_daemon_is_dialing() {
        // A failing probe keeps the tunnel off `Verified`.
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        );
        assert_eq!(
            daemon.liveness(),
            TunnelLiveness {
                status: TunnelStatus::Dialing,
                error: None,
            },
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_passing_probe_verifies() {
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::passing()),
        );
        // The probe ticker fires in virtual time.
        daemon
            .watch_liveness()
            .wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("verified");
    }

    #[tokio::test(start_paused = true)]
    async fn an_unhealthy_probe_is_unreachable_with_the_probe_failure() {
        // The dial holds, but `/health` never answers healthy, so the tunnel
        // never verifies.
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        );
        let mut rx = daemon.watch_liveness();
        let unreachable = rx
            .wait_for(|l| l.status == TunnelStatus::Unreachable)
            .await
            .expect("unreachable")
            .clone();
        assert_eq!(
            unreachable.error.as_deref(),
            Some("/health probe failed: connection refused"),
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_dial_surfaces_the_error_and_keeps_retrying() {
        let (dialed, mut dials) = tokio::sync::mpsc::unbounded_channel();
        let daemon = daemon_with(
            Arc::new(FailImmediatelyRelayClient(dialed)),
            Arc::new(StubProbe::passing()),
        );
        let mut rx = daemon.watch_liveness();
        rx.wait_for(|l| {
            l.status == TunnelStatus::Unreachable && l.error.as_deref() == Some("relay unreachable")
        })
        .await
        .expect("dial error surfaces");
        dials.recv().await.expect("dial 1");
        dials.recv().await.expect("dial 2");
    }

    #[tokio::test(start_paused = true)]
    async fn a_clean_session_end_reports_dialing_not_an_errorless_unreachable() {
        // A relay whose first session verifies and then ends *cleanly* (the relay
        // closed a healthy connection, `Ok(())` with no error), then holds. A
        // clean end is not a failure, so it must surface as `Dialing` (about to
        // reconnect) — never as an errorless `Unreachable`, which would mean
        // "something went wrong" with no cause to show.
        struct VerifyThenCleanExit(AtomicBool);
        #[async_trait::async_trait]
        impl RelayClient for VerifyThenCleanExit {
            async fn run_once(
                &self,
                _relay: &RelaySettings,
                _local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                if !self.0.swap(true, Ordering::SeqCst) {
                    // Outlast the probe interval (so `/health` verifies) but not
                    // its timeout, then close cleanly.
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Ok(())
                } else {
                    cancel.cancelled().await;
                    Ok(())
                }
            }
        }

        let daemon = daemon_with(
            Arc::new(VerifyThenCleanExit(AtomicBool::new(false))),
            Arc::new(StubProbe::passing()),
        );
        let mut rx = daemon.watch_liveness();

        // First session verifies.
        rx.wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("first session verifies");
        // The clean end is the first non-`Verified` transition after it: assert
        // it's `Dialing` with no error, not an errorless `Unreachable`.
        let after_clean_exit = rx
            .wait_for(|l| l.status != TunnelStatus::Verified)
            .await
            .expect("session ends")
            .clone();
        assert_eq!(after_clean_exit.status, TunnelStatus::Dialing);
        assert!(after_clean_exit.error.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_daemon_stops_the_supervisor() {
        /// Holds each dial until cancelled. Its channel closes once the
        /// supervisor, the client's only owner, has ended and dropped it.
        struct HeldUntilSupervisorEnds {
            _alive: tokio::sync::mpsc::Sender<()>,
        }
        #[async_trait::async_trait]
        impl RelayClient for HeldUntilSupervisorEnds {
            async fn run_once(
                &self,
                _relay: &RelaySettings,
                _local_addr: &str,
                cancel: CancellationToken,
            ) -> anyhow::Result<()> {
                cancel.cancelled().await;
                Ok(())
            }
        }

        let (client_alive, mut client_dropped) = tokio::sync::mpsc::channel(1);
        let daemon = daemon_with(
            Arc::new(HeldUntilSupervisorEnds {
                _alive: client_alive,
            }),
            Arc::new(StubProbe::passing()),
        );
        daemon
            .watch_liveness()
            .wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("verified");

        drop(daemon);
        // A supervisor that kept running would hold the client forever; bound
        // the wait so that fails rather than hangs.
        let closed = tokio::time::timeout(Duration::from_secs(5), client_dropped.recv())
            .await
            .expect("the supervisor ended within the bound");
        assert!(closed.is_none(), "the supervisor dropped its relay client");
    }
}
