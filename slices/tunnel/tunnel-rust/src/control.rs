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

use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};
use tokio::sync::watch;

use crate::db::{SettingsUpdate, SettingsUpdateOutcome};
use crate::http::TunnelState;

/// How many times the start path re-reads and retries its persist
/// compare-and-swap when a racing write bumps the settings revision between the
/// read and the write. A settings CAS contends with the (rare) tunnel PUT
/// surface, so a handful of retries is ample before surfacing a "please retry".
const START_CAS_RETRIES: usize = 8;

/// A handle onto the running tunnel's control seam. Cheap to clone (just an
/// `Arc`); hand a clone to each consumer. Implements [`TunnelService`] — the
/// contract the apps slice consumes.
///
/// There's no background machinery: a start persists-then-reconciles and awaits
/// the daemon's liveness watch inline. Concurrent launches are safe (the persist
/// is a retrying compare-and-swap, `reconcile` is monotonic) and coalesce on the
/// daemon's single verification, so no queue or resident task is needed.
#[derive(Clone)]
pub struct TunnelControl {
    state: Arc<TunnelState>,
}

impl TunnelControl {
    /// Build a control handle over the shared tunnel `state`. The handle reads
    /// the daemon's [`TunnelLiveness`] watch directly — that watch *is* the
    /// public contract, so there is nothing to map.
    pub(crate) fn new(state: Arc<TunnelState>) -> Self {
        Self { state }
    }

    /// Request the tunnel turn on, awaiting a *verified* outcome. `Ok(origin)`
    /// carries the public `https://{publicHost}` only once a `/health` probe
    /// through it has come back healthy; `Err(reason)` is a
    /// human-readable failure (relay unconfigured, no public host, persistence
    /// contention, or "did not become reachable" within the daemon's
    /// [`verify_deadline`](crate::domain::TunnelDaemon::verify_deadline))
    /// suitable for surfacing inline. Backs [`TunnelService::try_start`].
    ///
    /// The hot path (already `Verified`) short-circuits inside
    /// [`start_and_verify`] without persisting, so a relaunch against an up
    /// tunnel returns the live origin cheaply.
    pub async fn request_start(&self) -> Result<String, String> {
        start_and_verify(&self.state).await
    }
}

#[async_trait::async_trait]
impl TunnelService for TunnelControl {
    fn current_origin(&self) -> String {
        self.state.daemon.served_origin()
    }

    async fn try_start(&self) -> Result<String, String> {
        self.request_start().await
    }

    fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
        self.state.daemon.watch_liveness()
    }
}

/// Persist-then-reconcile the start, then await the daemon's liveness reaching a
/// verdict: `Verified` → `Ok(origin)`, a terminal `Misconfigured`/`Off` → the
/// matching error, otherwise wait up to the daemon's
/// [`verify_deadline`](crate::domain::TunnelDaemon::verify_deadline) for the
/// probe to verify reachability (a launch shouldn't hang on a dead tunnel).
async fn start_and_verify(state: &Arc<TunnelState>) -> Result<String, String> {
    let mut rx = state.daemon.watch_liveness();
    // Already verified (a launch arrived after another start brought the tunnel
    // up): return the live origin without the blocking persist round-trip. Only
    // the `Verified` fast-path short-circuits here — a terminal *error* verdict
    // still persists first, so the start reflects the requested intent.
    if let Some(Ok(origin)) = verdict(&rx.borrow_and_update()) {
        tracing::info!(%origin, "tunnel launch: already verified, fast path");
        return Ok(origin);
    }

    persist_start(state).await?;

    // Long enough for the first probe to land (one interval) and complete (one
    // timeout); shorter and a healthy-but-slow tunnel loses the race.
    let deadline_after = state.daemon.verify_deadline();
    let started = tokio::time::Instant::now();
    tracing::info!(
        deadline = ?deadline_after,
        "tunnel launch: persisted start, waiting for the tunnel to verify"
    );
    let deadline = tokio::time::sleep(deadline_after);
    tokio::pin!(deadline);
    // The most recent concrete failure seen while dialing. The live `error` is
    // cleared to `None` at the top of every dial attempt, so reading it only at
    // the instant the deadline fires would surface the generic timeout text even
    // when a real relay error occurred moments earlier — remember the last one.
    let mut last_error: Option<String> = None;
    loop {
        // Check the current value without holding the borrow across the await.
        {
            let live = rx.borrow_and_update();
            if let Some(verdict) = verdict(&live) {
                if let Ok(origin) = &verdict {
                    tracing::info!(
                        %origin,
                        elapsed = ?started.elapsed(),
                        "tunnel launch: verified"
                    );
                }
                return verdict;
            }
            if live.error.is_some() {
                last_error = live.error.clone();
            }
        }
        tokio::select! {
            changed = rx.changed() => {
                if changed.is_err() {
                    return Err("tunnel daemon stopped before the tunnel verified".to_string());
                }
            }
            () = &mut deadline => {
                tracing::warn!(
                    deadline = ?deadline_after,
                    last_error = last_error.as_deref(),
                    "tunnel launch: deadline elapsed before the tunnel verified \
                     (if rathole/probe logs show it coming up just after this, the \
                     deadline is too tight for a cold start)"
                );
                return Err(last_error.unwrap_or_else(|| {
                    format!("tunnel did not become reachable within {deadline_after:?}")
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
    use crate::test_support::{HoldUntilCancelRelayClient, StubProbe};

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
        let control = TunnelControl::new(resumed_state(
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
        // A second launch against the now-verified tunnel takes the fast path
        // (short-circuits before persisting) and returns the same origin.
        assert_eq!(
            control.request_start().await,
            Ok("https://dev1.example.com".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_without_a_relay_reports_not_configured() {
        let control = TunnelControl::new(resumed_state(
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
        let control = TunnelControl::new(resumed_state(
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
        let control = TunnelControl::new(resumed_state(
            Some("dev1.example.com"),
            Some(relay()),
            Arc::new(HoldUntilCancelRelayClient),
            Arc::new(StubProbe::failing()),
        ));
        // The probe never passes, so the start fails (rather than hanging) once
        // the verify deadline elapses in virtual time. The surfaced error is the
        // concrete probe failure seen while dialing, not the generic timeout —
        // the daemon clears `error` to `None` at the top of each attempt, so the
        // wait remembers the last real reason rather than reading `None` at the
        // instant the deadline fires.
        let err = control.request_start().await.expect_err("never verifies");
        assert!(
            err.contains("connection refused"),
            "expected the probe failure reason, got: {err}"
        );
    }
}
