//! Per-revision tunnel supervisor and the liveness state machine.
//!
//! Persisted settings (incl. the `revision` CAS token) live in SQLite; the
//! *live* runtime — what state the tunnel is in and any error — is in-memory and
//! resets per process. Each accepted write bumps the revision and
//! [`reconcile`](TunnelDaemon::reconcile)s: it cancels the previous supervisor
//! and (when the revision can actually dial) spawns a fresh one. A supervisor
//! owns the reconnect/backoff loop, awaits its own rathole child, *and* drives a
//! concurrent `/health` probe — so the public origin is only ever published once
//! a probe through it has come back healthy.
//!
//! ## Liveness state machine
//!
//! One [`TunnelStatus`] per live revision, published on a `watch` so every
//! consumer (the HTTP `GET /tunnel`, the apps launch handler, an in-process
//! `request_start`) reads one coherent value:
//!
//! ```text
//!   reconcile(requested=false) ─────────────► Off
//!   reconcile(requested, no relay/host) ────► Misconfigured (terminal until
//!                                                            next reconcile)
//!   reconcile(requested + relay + host) ────► Dialing
//!                                  ▲             │ probe pass
//!                      dial drops/ │             ▼
//!                      probe fails └───────── Verified
//!                            (Unreachable ◄──► Verified as probes flip)
//! ```
//!
//! `servedOrigin` is `https://{publicHost}` **only** in `Verified`; every other
//! state resolves to the loopback fallback. Because `Verified` requires a
//! round-trip probe, a launch never redirects to a public origin that merely
//! "started dialing" — closing
//! <https://github.com/Assessment-is/Wildflower/issues/184>. The supervisor
//! re-probes on an interval, so a tunnel that silently drops falls back out of
//! `Verified` rather than pinning a stale public origin.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use shared_structures_rust::tunnel_service::TunnelStatus;

use crate::domain::{RelayClient, TunnelSettings};
use crate::health::HealthProbe;

/// Message shown when the tunnel is requested on but the relay isn't configured.
const NOT_CONFIGURED: &str = "tunnel relay is not configured";

/// Message shown when the tunnel is requested on with a relay but no public
/// host — there is no public URL to serve or probe, so it can't be brought up.
const NO_PUBLIC_HOST: &str = "tunnel is running but no public host is configured";

/// How long a freshly-spawned supervisor will wait for the cancelled previous
/// one to exit before forcibly aborting it. The drain prevents two rathole
/// clients from briefly dialing the same `service_name` (the relay would
/// reject the second as a duplicate); the abort cap prevents a misbehaving
/// old client from leaking forever.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// A snapshot of the live tunnel runtime. Watched so reads see the latest value
/// and internal waiters (and tests) can await transitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Liveness {
    /// The revision of the most-recently-reconciled supervisor. Doubles as the
    /// monotonicity marker: [`TunnelDaemon::reconcile`] skips when its
    /// `settings.revision` is not strictly greater (closing the concurrent-PUT
    /// race), and [`set_state`] drops a superseded supervisor's late update when
    /// this no longer matches its own revision. `None` before any reconcile.
    pub revision: Option<i64>,
    /// The liveness state machine position.
    pub status: TunnelStatus,
    /// A human-readable reason for `Misconfigured`/`Unreachable`, else `None`.
    pub error: Option<String>,
    /// The origin clients should reach the server at: the public
    /// `https://{publicHost}` only while `Verified`, else the loopback fallback.
    /// Computed alongside `status` so the two can never disagree.
    pub served_origin: String,
    /// Count of dial attempts for this revision since the supervisor started.
    /// Resets to 0 on the next reconcile. A climbing `attempt` with a steady
    /// error is the operator-facing "probably a permanent misconfiguration"
    /// signal.
    pub attempt: i64,
}

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

/// Cadence + deadline for the `/health` probe the supervisor runs while a
/// revision is dialing. Configurable so tests drive it on virtual time.
#[derive(Debug, Clone, Copy)]
struct ProbeTiming {
    /// How long to wait before the first probe of an attempt (let the handshake
    /// settle) and between subsequent probes.
    interval: Duration,
    /// How long a single probe may take before it counts as a failure — the
    /// "identify failures after 3 seconds" deadline.
    timeout: Duration,
}

impl Default for ProbeTiming {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(1),
            timeout: Duration::from_secs(3),
        }
    }
}

/// The cancel token and join handle of the live supervisor. Held together so
/// `reconcile` can atomically cancel the previous run and hand its join handle
/// off to the new task for a bounded drain before the new dial begins.
struct SupervisorHandle {
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

pub struct TunnelDaemon {
    client: Arc<dyn RelayClient>,
    /// The `/health` probe adapter the supervisor uses to confirm reachability.
    probe: Arc<dyn HealthProbe>,
    loopback_origin: String,
    local_port: u16,
    state_tx: watch::Sender<Liveness>,
    state_rx: watch::Receiver<Liveness>,
    /// The live supervisor's cancel token + join handle. Taken and replaced on
    /// every reconcile; the taken handle is passed to the new task so it can
    /// drain (and, if the grace period elapses, abort) the previous run before
    /// dialing.
    supervisor: Mutex<Option<SupervisorHandle>>,
    backoff: Backoff,
    probe_timing: ProbeTiming,
}

/// The public `https://{public_host}` for a non-empty host, else `None`. The
/// single place the public origin is spelled, shared by `reconcile` and the
/// supervisor so the scheme/host rule can't drift.
fn public_origin(public_host: Option<&str>) -> Option<String> {
    public_host
        .filter(|h| !h.is_empty())
        .map(|h| format!("https://{h}"))
}

/// The served origin for a `status`: the public origin only while `Verified`,
/// else the loopback fallback. The single source `servedOrigin` is computed
/// from, on both the HTTP and the watch path.
fn served_origin_for(status: TunnelStatus, public: Option<&str>, loopback: &str) -> String {
    match status {
        TunnelStatus::Verified => public.unwrap_or(loopback).to_string(),
        _ => loopback.to_string(),
    }
}

impl TunnelDaemon {
    pub fn new(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        loopback_origin: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self::with_tuning(
            client,
            probe,
            loopback_origin,
            local_port,
            Backoff::default(),
            ProbeTiming::default(),
        )
    }

    fn with_tuning(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        loopback_origin: impl Into<String>,
        local_port: u16,
        backoff: Backoff,
        probe_timing: ProbeTiming,
    ) -> Self {
        let loopback_origin = loopback_origin.into();
        let (state_tx, state_rx) = watch::channel(Liveness {
            revision: None,
            status: TunnelStatus::Off,
            error: None,
            served_origin: loopback_origin.clone(),
            attempt: 0,
        });
        Self {
            client,
            probe,
            loopback_origin,
            local_port,
            state_tx,
            state_rx,
            supervisor: Mutex::new(None),
            backoff,
            probe_timing,
        }
    }

    /// A snapshot of the current liveness.
    pub(crate) fn liveness(&self) -> Liveness {
        self.state_rx.borrow().clone()
    }

    /// The current served origin (`https://{publicHost}` only while `Verified`,
    /// else the loopback fallback).
    pub fn served_origin(&self) -> String {
        self.state_rx.borrow().served_origin.clone()
    }

    /// Subscribe to liveness transitions. Consumers `borrow()` for the live
    /// value or `await changed()` for transitions; `request_start` awaits this
    /// for `Verified`, and the apps launch handler resolves launches against it.
    pub(crate) fn watch_liveness(&self) -> watch::Receiver<Liveness> {
        self.state_tx.subscribe()
    }

    /// Bring the live tunnel in line with `settings`: cancel the previous
    /// supervisor, publish the immediate liveness (so the PUT response and an
    /// immediate GET are coherent before the supervisor runs), then — only when
    /// the revision can actually dial — spawn a supervisor for it.
    ///
    /// Skips when `settings.revision` is not strictly greater than the live
    /// revision. Two PUTs that both win the SQLite CAS race towards different
    /// revisions can both reach `reconcile`; without this guard the
    /// later-arriving (lower-revision) reconcile would cancel the live
    /// (higher-revision) supervisor and rewind the revision, leaving the DB and
    /// the live tunnel disagreeing on which revision is current. Holding
    /// `supervisor` across the whole body keeps the revision check, the cancel +
    /// handle swap, the publish, and the spawn atomic against a racing reconcile.
    pub(crate) fn reconcile(&self, settings: &TunnelSettings) {
        let mut supervisor = self.supervisor.lock();

        if let Some(current) = self.state_rx.borrow().revision {
            if settings.revision <= current {
                tracing::warn!(
                    "skipping stale reconcile for revision {}, current is {}",
                    settings.revision,
                    current,
                );
                return;
            }
        }

        let previous = supervisor.take();
        if let Some(SupervisorHandle { cancel, join: _ }) = previous.as_ref() {
            cancel.cancel();
        }

        let cancel = CancellationToken::new();
        let revision = settings.revision;
        let public = public_origin(settings.public_host.as_deref());

        // The immediate state for a freshly-reconciled `settings`, before the
        // supervisor runs: idle when not requested, terminal `Misconfigured`
        // when requested but unable to dial (no relay, or no public host),
        // otherwise optimistic `Dialing` (still loopback until a probe verifies).
        let (status, error) = if !settings.requested_running {
            (TunnelStatus::Off, None)
        } else if settings.relay_settings.is_none() {
            (
                TunnelStatus::Misconfigured,
                Some(NOT_CONFIGURED.to_string()),
            )
        } else if public.is_none() {
            (
                TunnelStatus::Misconfigured,
                Some(NO_PUBLIC_HOST.to_string()),
            )
        } else {
            (TunnelStatus::Dialing, None)
        };

        let served_origin = served_origin_for(status, public.as_deref(), &self.loopback_origin);
        self.state_tx.send_replace(Liveness {
            revision: Some(revision),
            status,
            error,
            served_origin,
            attempt: 0,
        });

        // Only a dialable revision gets a supervisor; `Off`/`Misconfigured` are
        // terminal until the next reconcile, so there's nothing to drive.
        if status != TunnelStatus::Dialing {
            return;
        }

        let join = tokio::spawn(handover_and_supervise(
            previous.map(|h| h.join),
            SupervisorJob {
                state: self.state_tx.clone(),
                client: Arc::clone(&self.client),
                probe: Arc::clone(&self.probe),
                local_addr: format!("127.0.0.1:{}", self.local_port),
                public_origin: public.expect("Dialing implies a public origin"),
                loopback_origin: self.loopback_origin.clone(),
                settings: settings.clone(),
                cancel: cancel.clone(),
                backoff: self.backoff,
                probe_timing: self.probe_timing,
            },
        ));

        *supervisor = Some(SupervisorHandle { cancel, join });
    }
}

/// Everything one spawned supervisor needs for the revision it drives, bundled
/// so `reconcile` hands off a single value (rather than a long argument list).
struct SupervisorJob {
    state: watch::Sender<Liveness>,
    client: Arc<dyn RelayClient>,
    probe: Arc<dyn HealthProbe>,
    local_addr: String,
    /// The public `https://{host}` this revision serves at when `Verified`.
    public_origin: String,
    loopback_origin: String,
    settings: TunnelSettings,
    cancel: CancellationToken,
    backoff: Backoff,
    probe_timing: ProbeTiming,
}

/// Drain the previous supervisor (up to [`CANCEL_GRACE`], then abort) before
/// this revision begins dialing, so the relay never sees two clients holding
/// the same `service_name`.
async fn handover_and_supervise(previous: Option<JoinHandle<()>>, job: SupervisorJob) {
    if let Some(mut previous) = previous {
        if tokio::time::timeout(CANCEL_GRACE, &mut previous)
            .await
            .is_err()
        {
            tracing::warn!(
                "previous tunnel supervisor did not exit within {:?}; aborting",
                CANCEL_GRACE,
            );
            previous.abort();
            let _ = previous.await;
        }
    }
    supervise(job).await;
}

/// Drive one revision's tunnel: reconnect with backoff until cancelled, probing
/// `/health` while each attempt is in flight so the state tracks real
/// reachability. Updates are dropped if a newer revision has taken over.
async fn supervise(job: SupervisorJob) {
    let SupervisorJob {
        state,
        client,
        probe,
        local_addr,
        public_origin,
        loopback_origin,
        settings,
        cancel,
        backoff,
        probe_timing,
    } = job;
    let revision = settings.revision;
    // `reconcile` only spawns a supervisor for a dialable revision, so the relay
    // is present; this is an invariant, not a runtime branch.
    let Some(relay) = settings.relay_settings else {
        return;
    };

    let mut delay = backoff.initial;
    let mut attempt: i64 = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        attempt = attempt.saturating_add(1);
        // A fresh attempt is dialing, not yet verified — back to loopback.
        set_state(
            &state,
            revision,
            TunnelStatus::Dialing,
            None,
            &loopback_origin,
            &public_origin,
            attempt,
        );
        let attempt_started = tokio::time::Instant::now();
        let dial = client.run_once(&relay, &local_addr, cancel.child_token());
        tokio::pin!(dial);
        let dial_result = dial_with_probes(
            &mut dial,
            &state,
            revision,
            probe.as_ref(),
            &public_origin,
            &loopback_origin,
            attempt,
            &cancel,
            probe_timing,
        )
        .await;
        if cancel.is_cancelled() {
            return;
        }
        let attempt_was_stable = attempt_started.elapsed() >= backoff.stable_threshold;
        // The session ended (cleanly or with an error): no longer reachable.
        let error = match dial_result {
            Ok(()) => {
                delay = backoff.initial;
                None
            }
            Err(error) => {
                if attempt_was_stable {
                    delay = backoff.initial;
                }
                Some(format!("{error:#}"))
            }
        };
        set_state(
            &state,
            revision,
            TunnelStatus::Unreachable,
            error,
            &loopback_origin,
            &public_origin,
            attempt,
        );
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
#[allow(clippy::too_many_arguments)]
async fn dial_with_probes<D>(
    dial: &mut D,
    state: &watch::Sender<Liveness>,
    revision: i64,
    probe: &dyn HealthProbe,
    public_origin: &str,
    loopback_origin: &str,
    attempt: i64,
    cancel: &CancellationToken,
    timing: ProbeTiming,
) -> anyhow::Result<()>
where
    D: std::future::Future<Output = anyhow::Result<()>> + Unpin,
{
    let health_url = format!("{public_origin}/health");
    // First tick fires after `interval` (give the handshake a moment), then
    // every `interval`. `Skip` keeps a slow probe from bursting catch-up ticks.
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + timing.interval,
        timing.interval,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = &mut *dial => return result,
            () = cancel.cancelled() => return Ok(()),
            _ = ticker.tick() => {
                let (status, error) = match probe_once(probe, &health_url, timing.timeout).await {
                    Ok(()) => (TunnelStatus::Verified, None),
                    Err(reason) => (TunnelStatus::Unreachable, Some(reason)),
                };
                set_state(
                    state, revision, status, error, loopback_origin, public_origin, attempt,
                );
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
    match tokio::time::timeout(timeout, probe.probe(health_url)).await {
        Err(_elapsed) => Err(format!("/health did not respond within {timeout:?}")),
        Ok(Err(reason)) => Err(format!("/health probe failed: {reason}")),
        Ok(Ok(())) => Ok(()),
    }
}

/// Equal-jitter backoff: returns a duration in `[base / 2, base]`. Half
/// deterministic so retries don't pile near zero; half random so concurrent
/// losers of a relay session don't reconnect in lockstep.
fn jittered(base: Duration) -> Duration {
    let half = base / 2;
    half + half.mul_f64(rand::random::<f64>())
}

/// Apply a liveness update for `revision`, ignored when a newer revision is live
/// (a superseded supervisor must not clobber the current one). Computes the
/// served origin from `status` so it always matches.
#[allow(clippy::too_many_arguments)]
fn set_state(
    state: &watch::Sender<Liveness>,
    revision: i64,
    status: TunnelStatus,
    error: Option<String>,
    loopback_origin: &str,
    public_origin: &str,
    attempt: i64,
) {
    let served_origin = served_origin_for(status, Some(public_origin), loopback_origin);
    state.send_if_modified(|live| {
        if live.revision != Some(revision) {
            return false;
        }
        if live.status == status
            && live.error == error
            && live.served_origin == served_origin
            && live.attempt == attempt
        {
            return false;
        }
        live.status = status;
        live.error = error;
        live.served_origin = served_origin;
        live.attempt = attempt;
        true
    });
}

#[cfg(test)]
impl TunnelDaemon {
    /// Build with a near-zero backoff and fast probe timing so reconnect/probe
    /// tests don't wait on wall time. 1ms (not zero) keeps the retry loop from
    /// busy-spinning the runtime.
    pub(crate) fn new_test(
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
        loopback_origin: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self::with_tuning(
            client,
            probe,
            loopback_origin,
            local_port,
            Backoff {
                initial: Duration::from_millis(1),
                max: Duration::from_millis(1),
                // Far larger than anything a test will let an attempt run, so
                // the stable-attempt reset doesn't fire by accident.
                stable_threshold: Duration::from_secs(3600),
            },
            ProbeTiming {
                interval: Duration::from_millis(1),
                timeout: Duration::from_millis(50),
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RelaySettings;

    /// A relay client that returns `Ok` immediately so any spawned supervisor
    /// loops without dialing — used for the reconcile-monotonicity tests.
    struct NoopRelayClient;

    #[async_trait::async_trait]
    impl RelayClient for NoopRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// A relay client that holds the session until cancelled — a stable "up"
    /// dial the probe runs against.
    struct HoldUntilCancelRelayClient;

    #[async_trait::async_trait]
    impl RelayClient for HoldUntilCancelRelayClient {
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

    /// A relay client that errors immediately, driving the reconnect loop.
    struct FailImmediatelyRelayClient;

    #[async_trait::async_trait]
    impl RelayClient for FailImmediatelyRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            Err(anyhow::anyhow!("relay unreachable"))
        }
    }

    /// A `/health` probe with a fixed, cloneable outcome.
    struct StubProbe(Result<(), String>);

    impl StubProbe {
        fn passing() -> Self {
            Self(Ok(()))
        }
        fn failing() -> Self {
            Self(Err("connection refused".to_string()))
        }
    }

    #[async_trait::async_trait]
    impl HealthProbe for StubProbe {
        async fn probe(&self, _url: &str) -> Result<(), String> {
            self.0.clone()
        }
    }

    fn settings_at(revision: i64) -> TunnelSettings {
        TunnelSettings {
            revision,
            ..Default::default()
        }
    }

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    fn running_settings(revision: i64, public_host: Option<&str>) -> TunnelSettings {
        TunnelSettings {
            revision,
            public_host: public_host.map(str::to_owned),
            requested_running: true,
            relay_settings: Some(relay()),
        }
    }

    fn daemon_with(client: Arc<dyn RelayClient>, probe: Arc<dyn HealthProbe>) -> TunnelDaemon {
        TunnelDaemon::new_test(client, probe, "http://127.0.0.1:8080", 8080)
    }

    fn noop_daemon() -> TunnelDaemon {
        daemon_with(Arc::new(NoopRelayClient), Arc::new(StubProbe::passing()))
    }

    #[tokio::test]
    async fn first_reconcile_at_db_default_revision_is_applied() {
        let daemon = noop_daemon();
        daemon.reconcile(&settings_at(0));
        let live = daemon.liveness();
        assert_eq!(live.revision, Some(0));
        assert_eq!(live.status, TunnelStatus::Off);
    }

    #[tokio::test]
    async fn stale_reconcile_after_newer_one_is_skipped() {
        let daemon = noop_daemon();
        daemon.reconcile(&settings_at(2));
        daemon.reconcile(&settings_at(1));
        assert_eq!(
            daemon.liveness().revision,
            Some(2),
            "stale reconcile must not rewind below the live revision",
        );
    }

    #[tokio::test]
    async fn requested_without_relay_is_misconfigured() {
        let daemon = noop_daemon();
        daemon.reconcile(&TunnelSettings {
            revision: 1,
            public_host: Some("dev1.example.com".into()),
            requested_running: true,
            relay_settings: None,
        });
        let live = daemon.liveness();
        assert_eq!(live.status, TunnelStatus::Misconfigured);
        assert_eq!(live.error.as_deref(), Some(NOT_CONFIGURED));
        assert_eq!(live.served_origin, "http://127.0.0.1:8080");
        assert!(!live.status.is_running());
    }

    #[tokio::test]
    async fn requested_with_relay_but_no_public_host_is_misconfigured() {
        let daemon = noop_daemon();
        daemon.reconcile(&running_settings(1, None));
        let live = daemon.liveness();
        assert_eq!(live.status, TunnelStatus::Misconfigured);
        assert_eq!(live.error.as_deref(), Some(NO_PUBLIC_HOST));
        assert_eq!(live.served_origin, "http://127.0.0.1:8080");
    }

    #[tokio::test]
    async fn dialing_serves_loopback_before_a_probe_verifies() {
        // A never-answering probe keeps the tunnel in Dialing/Unreachable.
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        );
        daemon.reconcile(&running_settings(1, Some("dev1.example.com")));
        let live = daemon.liveness();
        assert_eq!(live.status, TunnelStatus::Dialing);
        assert_eq!(
            live.served_origin, "http://127.0.0.1:8080",
            "no public origin until a probe verifies",
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_passing_probe_verifies_and_serves_the_public_origin() {
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::passing()),
        );
        let mut rx = daemon.watch_liveness();
        daemon.reconcile(&running_settings(1, Some("dev1.example.com")));
        // The probe ticker fires in virtual time; Verified publishes the origin.
        rx.wait_for(|l| l.status == TunnelStatus::Verified)
            .await
            .expect("verified");
        assert_eq!(rx.borrow().served_origin, "https://dev1.example.com");
    }

    #[tokio::test(start_paused = true)]
    async fn an_unhealthy_probe_stays_unreachable_on_the_loopback_fallback() {
        // The dial holds, but `/health` never answers healthy, so the tunnel
        // must NOT advertise the public origin.
        let daemon = daemon_with(
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        );
        let mut rx = daemon.watch_liveness();
        daemon.reconcile(&running_settings(1, Some("dev1.example.com")));
        rx.wait_for(|l| l.status == TunnelStatus::Unreachable)
            .await
            .expect("unreachable");
        assert_eq!(rx.borrow().served_origin, "http://127.0.0.1:8080");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_dial_surfaces_the_error_and_keeps_retrying() {
        let daemon = daemon_with(
            Arc::new(FailImmediatelyRelayClient),
            Arc::new(StubProbe::passing()),
        );
        let mut rx = daemon.watch_liveness();
        daemon.reconcile(&running_settings(1, Some("dev1.example.com")));
        rx.wait_for(|l| {
            l.status == TunnelStatus::Unreachable && l.error.as_deref() == Some("relay unreachable")
        })
        .await
        .expect("dial error surfaces");
        rx.wait_for(|l| l.attempt >= 2)
            .await
            .expect("attempt count climbs");
    }
}
