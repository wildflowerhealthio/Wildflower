//! Programmatic tunnel control — the in-process seam the apps slice (and any
//! other host-side consumer) drives instead of issuing an HTTP `PUT /tunnel`.
//!
//! [`TunnelControl::request_start`] persists `requested_running = true`,
//! reconciles, and then **awaits the daemon's liveness FSM reaching
//! `Verified`** — i.e. a `/health` probe through the public origin has come back
//! healthy — before reporting `Ok(origin)`. So the apps launch
//! handler's `requires_tunnel` resolution gets a *verified-reachable* origin, not
//! an optimistic one (the gap
//! <https://github.com/Assessment-is/Wildflower/issues/184> closes). The probe
//! itself lives in the daemon's supervisor (see [`crate::domain`]); the control
//! only triggers a start and reads the published state.

use std::sync::Arc;
use std::time::Duration;

use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};
use tokio::sync::{mpsc, oneshot, watch};

use crate::db::{SettingsUpdate, SettingsUpdateOutcome};
use crate::http::TunnelState;

/// How many bounded start requests can queue before `request_start` awaits a
/// free slot. Starts are cheap and rare (a user launching a tunnel app), so a
/// small buffer is plenty; the bound just stops an unbounded backlog if the
/// resident task ever stalls.
const START_QUEUE_DEPTH: usize = 16;

/// How many times the start path re-reads and retries its persist
/// compare-and-swap when a racing write bumps the settings revision between the
/// read and the write. A settings CAS contends with the (rare) tunnel PUT
/// surface, so a handful of retries is ample before surfacing a "please retry".
const START_CAS_RETRIES: usize = 8;

/// How long `request_start` waits for the daemon to reach `Verified` before
/// declaring the tunnel unreachable. Matches the per-probe deadline: a launch
/// fails fast rather than hanging on a tunnel that started dialing but never
/// carried traffic.
const START_VERIFY_DEADLINE: Duration = Duration::from_secs(3);

/// A handle onto the running tunnel's control seam. Cheap to clone (an `mpsc`
/// sender plus a `watch` receiver); hand a clone to each consumer. Implements
/// [`TunnelService`] — the contract the apps slice consumes.
#[derive(Clone)]
pub struct TunnelControl {
    start_tx: mpsc::Sender<oneshot::Sender<Result<String, String>>>,
    /// The public liveness contract, mapped from the daemon's internal watch by
    /// the forwarder task in [`spawn_control`].
    liveness_rx: watch::Receiver<TunnelLiveness>,
}

impl TunnelControl {
    /// Request the tunnel turn on, awaiting a *verified* outcome. `Ok(origin)`
    /// carries the public `https://{publicHost}` only once a `/health` probe
    /// through it has come back healthy; `Err(reason)` is a
    /// human-readable failure (relay unconfigured, no public host, persistence
    /// contention, or "did not become reachable" within
    /// [`START_VERIFY_DEADLINE`]) suitable for surfacing inline. Backs
    /// [`TunnelService::try_start`].
    pub async fn request_start(&self) -> Result<String, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.start_tx
            .send(reply_tx)
            .await
            .map_err(|_| "tunnel control task is no longer running".to_string())?;
        reply_rx
            .await
            .map_err(|_| "tunnel control task dropped the start request".to_string())?
    }

    /// The current served origin (`https://{publicHost}` only while the tunnel
    /// is `Verified`, else the loopback fallback).
    pub fn served_origin(&self) -> String {
        self.liveness_rx.borrow().origin.clone()
    }

    /// The current liveness status.
    pub fn status(&self) -> TunnelStatus {
        self.liveness_rx.borrow().status
    }
}

#[async_trait::async_trait]
impl TunnelService for TunnelControl {
    fn current_origin(&self) -> String {
        self.liveness_rx.borrow().origin.clone()
    }

    async fn try_start(&self) -> Result<String, String> {
        self.request_start().await
    }

    fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
        self.liveness_rx.clone()
    }
}

/// Spawn the resident control task over the shared `state` and return a
/// [`TunnelControl`] handle. The task lives until every [`TunnelControl`] clone
/// is dropped (process lifetime for the host). The handle reads the daemon's
/// [`TunnelLiveness`] watch directly — that watch *is* the public contract, so
/// there is nothing to map.
pub(crate) fn spawn_control(state: Arc<TunnelState>) -> TunnelControl {
    let (start_tx, mut start_rx) =
        mpsc::channel::<oneshot::Sender<Result<String, String>>>(START_QUEUE_DEPTH);
    let liveness_rx = state.daemon.watch_liveness();

    // Start-trigger loop: each request persist-then-reconciles and awaits a
    // verified outcome.
    tokio::spawn(async move {
        while let Some(reply) = start_rx.recv().await {
            let outcome = start_and_verify(&state).await;
            // A dropped receiver means the requester superseded or timed out;
            // the persisted intent still stands, so nothing to undo.
            let _ = reply.send(outcome);
        }
    });

    TunnelControl {
        start_tx,
        liveness_rx,
    }
}

/// Persist-then-reconcile the start, then await the daemon's liveness reaching a
/// verdict: `Verified` → `Ok(origin)`, a terminal `Misconfigured`/`Off` → the
/// matching error, otherwise wait up to [`START_VERIFY_DEADLINE`] for the probe
/// to verify reachability (a launch shouldn't hang on a dead tunnel).
async fn start_and_verify(state: &Arc<TunnelState>) -> Result<String, String> {
    persist_start(state).await?;

    let mut rx = state.daemon.watch_liveness();
    let deadline = tokio::time::sleep(START_VERIFY_DEADLINE);
    tokio::pin!(deadline);
    loop {
        // Check the current value without holding the borrow across the await.
        if let Some(verdict) = verdict(&rx.borrow_and_update()) {
            return verdict;
        }
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() {
                    return Err("tunnel daemon stopped before the tunnel verified".to_string());
                }
            }
            () = &mut deadline => {
                let live = rx.borrow();
                return Err(live.error.clone().unwrap_or_else(|| {
                    format!("tunnel did not become reachable within {START_VERIFY_DEADLINE:?}")
                }));
            }
        }
    }
}

/// The terminal verdict for a liveness, or `None` while still dialing/retrying
/// (the caller keeps waiting until `Verified` or the deadline).
fn verdict(live: &TunnelLiveness) -> Option<Result<String, String>> {
    match live.status {
        TunnelStatus::Verified => Some(Ok(live.origin.clone())),
        TunnelStatus::Misconfigured => Some(Err(live
            .error
            .clone()
            .unwrap_or_else(|| "tunnel is misconfigured".to_string()))),
        TunnelStatus::Off => Some(Err("tunnel is not turned on".to_string())),
        // Dialing / Unreachable: not yet a verdict — keep waiting.
        TunnelStatus::Dialing | TunnelStatus::Unreachable => None,
    }
}

/// Persist `requested_running = true` and reconcile on a blocking thread (the
/// store locks a `parking_lot` mutex and runs synchronous SQL, which must not
/// park a runtime worker under contention with the `PUT /tunnel` surface).
async fn persist_start(state: &Arc<TunnelState>) -> Result<(), String> {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || persist_start_blocking(&state))
        .await
        .map_err(|e| format!("tunnel start task failed: {e}"))?
}

/// The blocking persist-then-reconcile body. Runs the same compare-and-swap the
/// `PUT` handler does, retrying a bounded number of times if a racing write
/// bumps the revision between our read and write.
fn persist_start_blocking(state: &TunnelState) -> Result<(), String> {
    for _ in 0..START_CAS_RETRIES {
        let current = state
            .store
            .get_settings()
            .map_err(|e| format!("failed to read tunnel settings: {e}"))?;

        if current.requested_running {
            // Already requested on — make the daemon reflect the persisted
            // intent (a no-op when it's already the live revision).
            state.daemon.reconcile(&current);
            return Ok(());
        }

        let outcome = state
            .store
            .replace_settings(
                current.revision,
                SettingsUpdate {
                    public_host: current.public_host.clone(),
                    requested_running: true,
                    // Keep the stored relay connection — start never edits it.
                    relay_settings: None,
                },
            )
            .map_err(|e| format!("failed to persist tunnel start: {e}"))?;

        if let SettingsUpdateOutcome::Applied(settings) = outcome {
            state.daemon.reconcile(&settings);
            return Ok(());
        }
        // Conflict: a racing write moved the revision — re-read and retry.
    }
    Err("tunnel settings changed under concurrent writes; please retry".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TunnelStore;
    use crate::domain::{RelayClient, RelaySettings, TunnelDaemon};
    use crate::health::HealthProbe;
    use tokio_util::sync::CancellationToken;

    /// A relay client that holds the session until cancelled — a stable dial the
    /// probe runs against.
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

    fn relay() -> RelaySettings {
        RelaySettings {
            remote_addr: "relay.example.com:2333".into(),
            token: "tok".into(),
            public_key: "key".into(),
            service_name: "dev1".into(),
        }
    }

    /// A resumed `TunnelState` with `public_host`/`relay` configured (the tunnel
    /// not yet requested on), mirroring `setup_tunnel`'s post-seed resume.
    fn resumed_state(
        public_host: Option<&str>,
        relay_settings: Option<RelaySettings>,
        client: Arc<dyn RelayClient>,
        probe: Arc<dyn HealthProbe>,
    ) -> Arc<TunnelState> {
        let store = TunnelStore::open_in_memory().expect("open in-memory store");
        store
            .replace_settings(
                0,
                SettingsUpdate {
                    public_host: public_host.map(str::to_owned),
                    requested_running: false,
                    relay_settings,
                },
            )
            .expect("seed settings");
        let daemon = TunnelDaemon::new_test(client, probe, "http://127.0.0.1:8080", 8080);
        daemon.reconcile(&store.get_settings().expect("read settings"));
        Arc::new(TunnelState { store, daemon })
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_returns_the_public_origin_once_verified() {
        let control = spawn_control(resumed_state(
            Some("dev1.example.com"),
            Some(relay()),
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::passing()),
        ));
        // The supervisor's probe verifies in virtual time before the deadline.
        assert_eq!(
            control.request_start().await,
            Ok("https://dev1.example.com".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_without_a_relay_reports_not_configured() {
        let control = spawn_control(resumed_state(
            Some("dev1.example.com"),
            None,
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::passing()),
        ));
        assert_eq!(
            control.request_start().await,
            Err("tunnel relay is not configured".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_with_relay_but_no_public_host_errs() {
        let control = spawn_control(resumed_state(
            None,
            Some(relay()),
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::passing()),
        ));
        assert_eq!(
            control.request_start().await,
            Err("tunnel is running but no public host is configured".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_that_never_verifies_times_out() {
        let control = spawn_control(resumed_state(
            Some("dev1.example.com"),
            Some(relay()),
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        ));
        // The probe never passes, so the start fails (rather than hanging) once
        // the verify deadline elapses in virtual time.
        assert!(control.request_start().await.is_err());
    }
}
