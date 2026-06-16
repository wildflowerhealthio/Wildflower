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
use tokio_util::sync::CancellationToken;

use crate::domain::{RelayClient, TunnelSettings};

/// Message shown when the tunnel is requested on but the relay isn't configured.
const NOT_CONFIGURED: &str = "tunnel relay is not configured";

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
    pub running: bool,
    pub error: Option<String>,
}

/// Exponential reconnect backoff, configurable so tests don't wait on wall time.
#[derive(Debug, Clone, Copy)]
struct Backoff {
    initial: Duration,
    max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }
}

pub struct TunnelDaemon {
    client: Arc<dyn RelayClient>,
    loopback_origin: String,
    local_port: u16,
    observed_tx: watch::Sender<Observed>,
    observed_rx: watch::Receiver<Observed>,
    /// Cancels the live supervisor; replaced on every reconcile.
    cancel: Mutex<Option<CancellationToken>>,
    backoff: Backoff,
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
        let (observed_tx, observed_rx) = watch::channel(Observed::default());
        Self {
            client,
            loopback_origin: loopback_origin.into(),
            local_port,
            observed_tx,
            observed_rx,
            cancel: Mutex::new(None),
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
    /// `cancel` across the whole body keeps the revision check, the cancel
    /// swap, the observed update, and the spawn atomic against a racing
    /// reconcile.
    pub(crate) fn reconcile(&self, settings: &TunnelSettings) {
        let mut cancel = self.cancel.lock();

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

        let token = CancellationToken::new();
        if let Some(old) = cancel.replace(token.clone()) {
            old.cancel();
        }

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
        });

        tokio::spawn(supervise(
            self.observed_tx.clone(),
            Arc::clone(&self.client),
            format!("127.0.0.1:{}", self.local_port),
            settings.clone(),
            token,
            self.backoff,
        ));
    }
}

/// Drive one revision's tunnel: reconnect with backoff until cancelled. Updates
/// to the observed state are dropped if a newer revision has taken over.
async fn supervise(
    observed: watch::Sender<Observed>,
    client: Arc<dyn RelayClient>,
    local_addr: String,
    settings: TunnelSettings,
    cancel: CancellationToken,
    backoff: Backoff,
) {
    let revision = settings.revision;
    if !settings.requested_running {
        set_observed(&observed, revision, false, None);
        return;
    }
    let Some(relay) = settings.relay_settings else {
        set_observed(&observed, revision, false, Some(NOT_CONFIGURED.to_string()));
        return;
    };

    let mut delay = backoff.initial;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        // Optimistic: the attempt is starting (rathole exposes no "connected"
        // signal, so this flips to true before the handshake completes).
        set_observed(&observed, revision, true, None);
        let result = client
            .run_once(&relay, &local_addr, cancel.child_token())
            .await;
        if cancel.is_cancelled() {
            return;
        }
        match result {
            Ok(()) => {
                delay = backoff.initial;
                set_observed(&observed, revision, false, None)
            }
            Err(error) => set_observed(&observed, revision, false, Some(format!("{error:#}"))),
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = cancel.cancelled() => return,
        }
        delay = (delay * 2).min(backoff.max);
    }
}

/// Apply an observed-state update for `revision`, ignored when a newer revision
/// is live (a superseded supervisor must not clobber the current one).
fn set_observed(
    observed: &watch::Sender<Observed>,
    revision: i64,
    running: bool,
    error: Option<String>,
) {
    observed.send_if_modified(|o| {
        if o.revision != Some(revision) || (o.running == running && o.error == error) {
            return false;
        }
        o.running = running;
        o.error = error;
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
}
