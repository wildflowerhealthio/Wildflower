//! Per-revision tunnel supervisor.
//!
//! Persisted settings (incl. the `revision` CAS token) live in SQLite; the
//! *observed* runtime — whether the tunnel is up and any error — is in-memory
//! and resets per process. Each accepted write bumps the revision and
//! [`reconcile`](TunnelDaemon::reconcile)s: it cancels the previous supervisor
//! and spawns a fresh one for the new revision. A supervisor owns the
//! reconnect/backoff loop and awaits its own rathole child, so there are no
//! stale cross-task reports — supersession is just cancellation, and the
//! revision guard on observed updates closes the teardown race.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::domain::{RelayClient, TunnelSettings};

/// Message shown when the tunnel is requested on but the relay isn't configured.
const NOT_CONFIGURED: &str = "tunnel relay is not configured";

/// How long a freshly-spawned supervisor will wait for the cancelled previous
/// one to exit before forcibly aborting it. The drain prevents two rathole
/// clients from briefly dialing the same `service_name` (the relay would
/// reject the second as a duplicate); the abort cap prevents a misbehaving
/// old client from leaking forever.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// Observed, in-memory liveness of the live tunnel run. Watched so reads see the
/// latest value and internal waiters (and tests) can await transitions.
#[derive(Debug, Clone, Default)]
pub(crate) struct Observed {
    /// The revision of the most-recently-reconciled supervisor. Doubles as the
    /// monotonicity marker: [`TunnelDaemon::reconcile`] skips when its
    /// `settings.revision` is not strictly greater (closing the concurrent-PUT
    /// race), and [`set_observed`] drops a superseded supervisor's late update
    /// when this no longer matches its own revision. `None` before any
    /// reconcile has run.
    pub revision: Option<i64>,
    /// `true` while the supervisor is *attempting* to keep a dial up, not a
    /// connected-handshake signal — rathole exposes no such signal, so this
    /// flips to `true` the instant `run_once` starts and stays `true` across
    /// retries that haven't yet errored. Treat as "dialing", not "reachable".
    pub running: bool,
    pub error: Option<String>,
    /// Count of `run_once` invocations for this revision since the supervisor
    /// started. Resets to 0 on the next reconcile (new revision). A growing
    /// `attempt` paired with a steady `error` is the operator-facing signal
    /// for "this is probably a permanent misconfiguration, not a transient outage"
    /// — the daemon can't classify rathole errors itself, but a long-running
    /// counter lets the human see it.
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

/// The cancel token and join handle of the live supervisor. Held together so
/// `reconcile` can atomically cancel the previous run and hand its join handle
/// off to the new task for a bounded drain before the new dial begins.
struct SupervisorHandle {
    cancel: CancellationToken,
    join: JoinHandle<()>,
}

pub struct TunnelDaemon {
    client: Arc<dyn RelayClient>,
    loopback_origin: String,
    local_port: u16,
    observed_tx: watch::Sender<Observed>,
    observed_rx: watch::Receiver<Observed>,
    /// The live supervisor's cancel token + join handle. Taken and replaced on
    /// every reconcile; the taken handle is passed to the new task so it can
    /// drain (and, if the grace period elapses, abort) the previous run before
    /// dialing.
    supervisor: Mutex<Option<SupervisorHandle>>,
    /// The current served origin (`https://{publicHost}` while dialing this
    /// revision's configured host, else the loopback fallback), published as a
    /// `watch` channel so consumers — notably the apps slice's launch handler,
    /// wired in by the composition root — read the live value and react to
    /// changes without reaching into the tunnel store. Wrapped in `Arc` because
    /// both [`reconcile`](TunnelDaemon::reconcile) and the per-revision
    /// supervisor task hold a sender, and `watch::Sender` is not `Clone`.
    /// Mirrors the optimistic `servedOrigin` the HTTP `GET /tunnel` surface
    /// reports — see [`crate::http`].
    served_origin_tx: Arc<watch::Sender<String>>,
    backoff: Backoff,
}

/// Compute the origin clients should reach the server at: the public
/// `https://{public_host}` when the daemon is dialing this revision's
/// configured (non-empty) host, else the loopback fallback. The optimistic
/// twin of the HTTP layer's `served_origin` — see [`crate::http`]'s type docs
/// on why `running` means "dialing", not "reachable".
fn compute_served_origin(
    running: bool,
    public_host: Option<&str>,
    loopback_origin: &str,
) -> String {
    match public_host {
        Some(host) if running && !host.is_empty() => format!("https://{host}"),
        _ => loopback_origin.to_string(),
    }
}

impl TunnelDaemon {
    pub fn new(
        client: Arc<dyn RelayClient>,
        loopback_origin: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self::with_backoff(client, loopback_origin, local_port, Backoff::default())
    }

    fn with_backoff(
        client: Arc<dyn RelayClient>,
        loopback_origin: impl Into<String>,
        local_port: u16,
        backoff: Backoff,
    ) -> Self {
        let loopback_origin = loopback_origin.into();
        let (observed_tx, observed_rx) = watch::channel(Observed::default());
        // Seed the served-origin channel with the loopback fallback: nothing is
        // dialing yet, so the live origin is the loopback one until a reconcile
        // flips `running` for a configured public host.
        let (served_origin_tx, _) = watch::channel(loopback_origin.clone());
        Self {
            client,
            loopback_origin,
            local_port,
            observed_tx,
            observed_rx,
            supervisor: Mutex::new(None),
            served_origin_tx: Arc::new(served_origin_tx),
            backoff,
        }
    }

    pub(crate) fn loopback_origin(&self) -> &str {
        &self.loopback_origin
    }

    /// A snapshot of the current observed runtime.
    pub(crate) fn observed(&self) -> Observed {
        self.observed_rx.borrow().clone()
    }

    /// The current served origin (`https://{publicHost}` while the tunnel is
    /// dialing a configured host, else the loopback fallback).
    pub fn served_origin(&self) -> String {
        self.served_origin_tx.borrow().clone()
    }

    /// Subscribe to served-origin changes. Consumers hold the receiver and
    /// read `borrow()` for the live value, or `await changed()` for
    /// transitions. The composition root hands one of these to the apps
    /// slice's launch handler so `requires_tunnel` launches resolve to the
    /// live public origin.
    pub fn watch_served_origin(&self) -> watch::Receiver<String> {
        self.served_origin_tx.subscribe()
    }

    /// Bring the live tunnel in line with `settings`: cancel the previous
    /// supervisor, set the immediate observed state (so the PUT response and an
    /// immediate GET are coherent before the supervisor task runs), then spawn a
    /// supervisor for this revision.
    ///
    /// Skips when `settings.revision` is not strictly greater than the live
    /// observed revision. Two PUTs that both win the SQLite CAS race towards
    /// different revisions can both reach `reconcile`; without this guard the
    /// later-arriving (lower-revision) reconcile would cancel the live
    /// (higher-revision) supervisor and rewind `observed.revision`, leaving the
    /// DB and the live tunnel disagreeing on which revision is current. Holding
    /// `supervisor` across the whole body keeps the revision check, the
    /// cancel + handle swap, the observed update, and the spawn atomic against
    /// a racing reconcile.
    ///
    /// The new supervisor task begins by draining the cancelled previous one
    /// (bounded by [`CANCEL_GRACE`], then `JoinHandle::abort`) so two rathole
    /// clients can't briefly hold the same `service_name` at the relay — the
    /// relay rejects the duplicate, which would otherwise surface as a
    /// spurious error on a tunnel that's actually fine.
    pub(crate) fn reconcile(&self, settings: &TunnelSettings) {
        let mut supervisor = self.supervisor.lock();

        if let Some(current) = self.observed_tx.borrow().revision {
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

        // The immediate observed state for a freshly-reconciled `settings`, before the
        // supervisor task runs: optimistic `running` when requested + configured,
        // terminal "not configured" when requested without a relay, else idle.
        let revision = settings.revision;
        let running = settings.requested_running && settings.relay_settings.is_some();
        let error = if settings.requested_running && settings.relay_settings.is_none() {
            Some(NOT_CONFIGURED.to_string())
        } else {
            None
        };

        self.observed_tx.send_modify(|o| {
            o.revision = Some(revision);
            o.running = running;
            o.error = error;
            o.attempt = 0;
        });

        // Publish the served origin from the revision's *configuration*
        // (`running` here is `requested_running && relay_settings.is_some()` —
        // a stable property of the settings row, not the live connection
        // state). This is the single writer of the served-origin watch: the
        // per-attempt supervisor deliberately does NOT republish it. Otherwise
        // a healthy tunnel's normal reconnect churn — each `run_once` return
        // momentarily flips the observed `running` flag false — would flap the
        // served origin between `https://{host}` and the loopback fallback,
        // and a `requires_tunnel` launch resolved during a reconnect gap would
        // redirect to the wrong (non-public) origin. The optimistic semantics
        // match `observed`: `running` means "requested + configured to dial",
        // not "reachable". A `requested_running = false` reconcile (the user
        // turning the tunnel off) publishes the loopback fallback here, since
        // it bumps the revision and runs this path.
        self.served_origin_tx.send_replace(compute_served_origin(
            running,
            settings.public_host.as_deref(),
            &self.loopback_origin,
        ));

        let join = tokio::spawn(handover_and_supervise(
            previous.map(|h| h.join),
            SupervisorJob {
                observed: self.observed_tx.clone(),
                client: Arc::clone(&self.client),
                local_addr: format!("127.0.0.1:{}", self.local_port),
                settings: settings.clone(),
                cancel: cancel.clone(),
                backoff: self.backoff,
            },
        ));

        *supervisor = Some(SupervisorHandle { cancel, join });
    }
}

/// Everything one spawned supervisor needs for the revision it drives, bundled
/// so `reconcile` hands off a single value (rather than a long argument list)
/// to the handover task. The served-origin watch is intentionally absent: it is
/// published once per revision by [`TunnelDaemon::reconcile`] from the row's
/// configuration and must not be rewound by this supervisor's per-attempt
/// `running` transitions.
struct SupervisorJob {
    observed: watch::Sender<Observed>,
    client: Arc<dyn RelayClient>,
    local_addr: String,
    settings: TunnelSettings,
    cancel: CancellationToken,
    backoff: Backoff,
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

/// Drive one revision's tunnel: reconnect with backoff until cancelled. Updates
/// to the observed state are dropped if a newer revision has taken over.
async fn supervise(job: SupervisorJob) {
    let SupervisorJob {
        observed,
        client,
        local_addr,
        settings,
        cancel,
        backoff,
    } = job;
    let revision = settings.revision;
    if !settings.requested_running {
        set_observed(&observed, revision, false, None, 0);
        return;
    }
    let Some(relay) = settings.relay_settings else {
        set_observed(
            &observed,
            revision,
            false,
            Some(NOT_CONFIGURED.to_string()),
            0,
        );
        return;
    };

    let mut delay = backoff.initial;
    let mut attempt: i64 = 0;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        attempt = attempt.saturating_add(1);
        // Optimistic: the attempt is starting (rathole exposes no "connected"
        // signal, so this flips to true before the handshake completes).
        set_observed(&observed, revision, true, None, attempt);
        // tokio's Instant tracks the runtime clock so tests can run this
        // against virtual time; in normal runs it's a thin wrapper over the
        // monotonic clock.
        let attempt_started = tokio::time::Instant::now();
        let result = client
            .run_once(&relay, &local_addr, cancel.child_token())
            .await;
        if cancel.is_cancelled() {
            return;
        }
        // An attempt that ran long enough to count as a real session resets
        // the backoff to `initial` — without this, a tunnel that ran cleanly
        // for hours then dropped would wait the full climbed `max` before
        // reconnecting instead of the cheap initial delay.
        let attempt_was_stable = attempt_started.elapsed() >= backoff.stable_threshold;
        match result {
            Ok(()) => {
                delay = backoff.initial;
                set_observed(&observed, revision, false, None, attempt)
            }
            Err(error) => {
                if attempt_was_stable {
                    delay = backoff.initial;
                }
                set_observed(
                    &observed,
                    revision,
                    false,
                    Some(format!("{error:#}")),
                    attempt,
                )
            }
        }
        // Jittered sleep — N devices losing the relay together would otherwise
        // retry in lockstep (thundering herd). Equal jitter keeps a minimum
        // gap (half the base) while spreading the rest across [0, base/2].
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

/// Apply an observed-state update for `revision`, ignored when a newer revision
/// is live (a superseded supervisor must not clobber the current one).
///
/// This touches only the `observed` watch. The served-origin watch is
/// deliberately left alone: it is published once per revision by
/// [`TunnelDaemon::reconcile`] from the row's configuration, so the per-attempt
/// `running` churn this function applies never flaps the origin a
/// `requires_tunnel` launch resolves against.
fn set_observed(
    observed: &watch::Sender<Observed>,
    revision: i64,
    running: bool,
    error: Option<String>,
    attempt: i64,
) {
    observed.send_if_modified(|o| {
        if o.revision != Some(revision) {
            return false;
        }
        if o.running == running && o.error == error && o.attempt == attempt {
            return false;
        }
        o.running = running;
        o.error = error;
        o.attempt = attempt;
        true
    });
}

#[cfg(test)]
impl TunnelDaemon {
    /// Build with a near-zero backoff so reconnect tests don't wait on wall
    /// time. 1ms (not zero) keeps the retry loop from busy-spinning the runtime.
    pub(crate) fn new_test(
        client: Arc<dyn RelayClient>,
        loopback_origin: impl Into<String>,
        local_port: u16,
    ) -> Self {
        Self::with_backoff(
            client,
            loopback_origin,
            local_port,
            Backoff {
                initial: Duration::from_millis(1),
                max: Duration::from_millis(1),
                // Far larger than anything a test will let an attempt run, so
                // the stable-attempt reset doesn't fire by accident — tests
                // that exercise it construct their own `Backoff` directly.
                stable_threshold: Duration::from_secs(3600),
            },
        )
    }

    /// Subscribe to observed-state transitions (deterministic awaits in tests).
    pub(crate) fn watch_observed(&self) -> watch::Receiver<Observed> {
        self.observed_tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RelaySettings;
    use tokio::sync::mpsc;

    /// A `RelayClient` that returns `Ok` immediately so any spawned supervisor
    /// exits without dialing — these tests are about `reconcile`'s monotonicity,
    /// not the dial loop.
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

    fn settings_at(revision: i64) -> TunnelSettings {
        TunnelSettings {
            revision,
            ..Default::default()
        }
    }

    fn daemon() -> TunnelDaemon {
        TunnelDaemon::new_test(Arc::new(NoopRelayClient), "http://127.0.0.1:8080", 8080)
    }

    /// The first reconcile after construction must pass even at DB rev 0 —
    /// otherwise a fresh install's `setup_tunnel` resume is a silent no-op.
    #[tokio::test]
    async fn first_reconcile_at_db_default_revision_is_applied() {
        let daemon = daemon();
        daemon.reconcile(&settings_at(0));
        assert_eq!(daemon.observed().revision, Some(0));
    }

    /// Two PUTs that both win the SQLite CAS race (rev 1 then rev 2) can both
    /// reach `reconcile`. If the higher-revision one runs first, the
    /// lower-revision one must skip — otherwise it cancels the live supervisor
    /// and rewinds `observed.revision` below the persisted revision.
    #[tokio::test]
    async fn stale_reconcile_after_newer_one_is_skipped() {
        let daemon = daemon();
        daemon.reconcile(&settings_at(2));
        daemon.reconcile(&settings_at(1));
        assert_eq!(
            daemon.observed().revision,
            Some(2),
            "stale reconcile must not rewind observed below the live revision",
        );
    }

    /// Same-revision reconciles are also no-ops (the guard is strictly greater,
    /// not `>=`) — a duplicate dispatch can't cancel and re-spawn the live
    /// supervisor for the revision it's already running.
    #[tokio::test]
    async fn same_revision_reconcile_is_a_noop() {
        let daemon = daemon();
        daemon.reconcile(&settings_at(3));
        daemon.reconcile(&settings_at(3));
        assert_eq!(daemon.observed().revision, Some(3));
    }

    /// A configured, running, public-host settings row — the only shape that
    /// resolves the served origin to a public `https://` value.
    fn running_settings_with_host(revision: i64, host: &str) -> TunnelSettings {
        TunnelSettings {
            public_host: Some(host.to_string()),
            ..running_settings(revision)
        }
    }

    /// Before any reconcile, nothing is dialing, so the served origin is the
    /// loopback fallback the launch handler redirects non-tunnel apps to.
    #[tokio::test]
    async fn served_origin_starts_at_the_loopback_fallback() {
        let daemon = daemon();
        assert_eq!(daemon.served_origin(), "http://127.0.0.1:8080");
    }

    /// A reconcile that optimistically flips `running` for a configured public
    /// host publishes `https://{host}` synchronously — read before the spawned
    /// supervisor task runs, so the value is the optimistic one the PUT/launch
    /// path sees immediately.
    #[tokio::test]
    async fn reconcile_to_running_publishes_the_public_https_origin() {
        let daemon = daemon();
        daemon.reconcile(&running_settings_with_host(1, "dev1.example.com"));
        assert_eq!(daemon.served_origin(), "https://dev1.example.com");
    }

    /// Requested-on but relay-unconfigured stays on the loopback fallback: the
    /// daemon can't dial, so there is no public origin to hand a launch even
    /// though a public host is set.
    #[tokio::test]
    async fn served_origin_stays_loopback_when_relay_unconfigured() {
        let daemon = daemon();
        let settings = TunnelSettings {
            revision: 1,
            public_host: Some("dev1.example.com".into()),
            requested_running: true,
            relay_settings: None,
        };
        daemon.reconcile(&settings);
        assert_eq!(daemon.served_origin(), "http://127.0.0.1:8080");
    }

    /// A `watch_served_origin` subscriber observes the transition the launch
    /// handler reacts to: loopback → public `https://` on a running reconcile.
    #[tokio::test]
    async fn watch_served_origin_observes_the_public_transition() {
        let daemon = daemon();
        let mut rx = daemon.watch_served_origin();
        assert_eq!(*rx.borrow_and_update(), "http://127.0.0.1:8080");
        daemon.reconcile(&running_settings_with_host(1, "dev1.example.com"));
        assert!(rx.has_changed().expect("sender alive"));
        assert_eq!(*rx.borrow_and_update(), "https://dev1.example.com");
    }

    /// A relay client whose `run_once` returns `Ok(())` immediately, modelling a
    /// tunnel that keeps cleanly reconnecting. Each return flips the observed
    /// `running` flag false until the next attempt starts.
    struct CleanReconnectRelayClient;

    #[async_trait::async_trait]
    impl RelayClient for CleanReconnectRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    /// Regression for the served-origin flap: a healthy tunnel's reconnect
    /// churn must NOT move the served origin. The supervisor flips
    /// `observed.running` false on every clean `run_once` return, but the
    /// served origin — published once from the revision's configuration — must
    /// stay `https://{host}` throughout, so a `requires_tunnel` launch resolved
    /// during a reconnect gap never redirects to the loopback fallback.
    #[tokio::test(start_paused = true)]
    async fn served_origin_does_not_flap_during_reconnect_churn() {
        let daemon = TunnelDaemon::new_test(
            Arc::new(CleanReconnectRelayClient),
            "http://127.0.0.1:8080",
            8080,
        );
        daemon.reconcile(&running_settings_with_host(1, "dev1.example.com"));
        assert_eq!(daemon.served_origin(), "https://dev1.example.com");

        // Drive many reconnect cycles in virtual time; `observed.running`
        // toggles true→false every loop, which previously flapped the origin.
        for _ in 0..50 {
            tokio::time::advance(Duration::from_millis(5)).await;
            tokio::task::yield_now().await;
            assert_eq!(
                daemon.served_origin(),
                "https://dev1.example.com",
                "served origin flapped during reconnect churn",
            );
        }
    }

    /// What a `TracingRelayClient.run_once` call did across its lifetime.
    #[derive(Debug, PartialEq, Eq)]
    enum DialEvent {
        Started,
        Ended,
    }

    /// A `RelayClient` that holds each attempt until cancelled and signals both
    /// edges — used to assert ordering across a supervisor handover.
    struct TracingRelayClient {
        events: mpsc::UnboundedSender<DialEvent>,
    }

    #[async_trait::async_trait]
    impl RelayClient for TracingRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            let _ = self.events.send(DialEvent::Started);
            cancel.cancelled().await;
            let _ = self.events.send(DialEvent::Ended);
            Ok(())
        }
    }

    fn running_settings(revision: i64) -> TunnelSettings {
        TunnelSettings {
            revision,
            requested_running: true,
            relay_settings: Some(RelaySettings {
                remote_addr: "relay.example.com:2333".into(),
                token: "tok".into(),
                public_key: "key".into(),
                service_name: "dev1".into(),
            }),
            ..Default::default()
        }
    }

    /// On reconcile, the new supervisor's first dial must not start until the
    /// previous supervisor's dial has ended — otherwise two rathole clients
    /// briefly hold the same `service_name` and the relay rejects one of them.
    #[tokio::test]
    async fn new_supervisor_dials_only_after_old_has_exited() {
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let client = Arc::new(TracingRelayClient { events: events_tx });
        let daemon = TunnelDaemon::new_test(client, "http://127.0.0.1:8080", 8080);

        daemon.reconcile(&running_settings(1));
        assert_eq!(events_rx.recv().await, Some(DialEvent::Started), "rev 1");

        daemon.reconcile(&running_settings(2));

        // The handover invariant: rev 1's dial ends (cancel propagated through
        // run_once) before rev 2's dial starts.
        assert_eq!(events_rx.recv().await, Some(DialEvent::Ended), "rev 1");
        assert_eq!(events_rx.recv().await, Some(DialEvent::Started), "rev 2");
    }

    /// A `RelayClient` that holds each attempt for a fixed duration then
    /// returns `Err`, recording the virtual-time start of every attempt so a
    /// test can verify the inter-attempt gap stays bounded.
    struct StableFlapperRelayClient {
        starts: Arc<std::sync::Mutex<Vec<tokio::time::Duration>>>,
        hold: tokio::time::Duration,
        origin: tokio::time::Instant,
    }

    #[async_trait::async_trait]
    impl RelayClient for StableFlapperRelayClient {
        async fn run_once(
            &self,
            _relay: &RelaySettings,
            _local_addr: &str,
            _cancel: CancellationToken,
        ) -> anyhow::Result<()> {
            self.starts.lock().unwrap().push(self.origin.elapsed());
            tokio::time::sleep(self.hold).await;
            Err(anyhow::anyhow!("simulated drop"))
        }
    }

    /// An attempt that stayed up beyond `stable_threshold` before erroring
    /// must reset the backoff to `initial` — without this, a tunnel that
    /// flaps at startup (climbs `delay` to `max`), runs cleanly for hours,
    /// then drops, would wait the full climbed `max` before reconnecting.
    #[tokio::test(start_paused = true)]
    async fn backoff_resets_after_a_stable_attempt_errors() {
        let backoff = Backoff {
            initial: Duration::from_millis(100),
            max: Duration::from_secs(10),
            stable_threshold: Duration::from_millis(500),
        };
        let hold = Duration::from_secs(1); // > stable_threshold
        let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
        let origin = tokio::time::Instant::now();
        let client = Arc::new(StableFlapperRelayClient {
            starts: Arc::clone(&starts),
            hold,
            origin,
        });
        let daemon = TunnelDaemon::with_backoff(client, "http://127.0.0.1:8080", 8080, backoff);
        daemon.reconcile(&running_settings(1));

        // Let several retry cycles play out in virtual time. The supervise
        // loop and the fake's `sleep(hold)` are both on the virtual clock.
        for _ in 0..40 {
            tokio::time::advance(Duration::from_millis(200)).await;
            tokio::task::yield_now().await;
        }

        let starts = starts.lock().unwrap();
        assert!(
            starts.len() >= 4,
            "expected several attempts in 8s of virtual time, got {}: {:?}",
            starts.len(),
            *starts,
        );
        // Every inter-attempt gap is roughly `hold + jittered(initial)` ∈
        // [hold + initial/2, hold + initial] = [1.05s, 1.10s]. Without the
        // reset, the gap would climb: 1s + 200ms, 1s + 400ms, …, capped at
        // 1s + 10s. A 1.5s ceiling tests "didn't climb" with slack.
        let ceiling = hold + Duration::from_millis(500);
        for i in 1..starts.len() {
            let gap = starts[i] - starts[i - 1];
            assert!(
                gap <= ceiling,
                "attempt gap {i} ({gap:?}) climbed past {ceiling:?} — \
                 stable-attempt reset didn't fire; all starts: {:?}",
                *starts,
            );
        }
    }
}
