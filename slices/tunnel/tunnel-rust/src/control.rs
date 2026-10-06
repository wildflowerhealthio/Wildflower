//! Programmatic tunnel control — the in-process seam the apps slice (and any
//! other host-side consumer) drives.
//!
//! [`TunnelControl::request_start`] **awaits the daemon's liveness FSM reaching
//! `Verified`** — i.e. a `/health` probe through the public origin has come back
//! healthy — before reporting `Ok(origin)`. So the apps launch handler's
//! `requires_tunnel` resolution gets a *verified-reachable* origin, not an
//! optimistic one (the gap
//! <https://github.com/Assessment-is/Wildflower/issues/184> closes). The tunnel
//! dials for as long as the server runs, and the probe itself lives in the
//! daemon's supervisor (see [`crate::domain`]); the control only reads the
//! published state.

use std::sync::Arc;

use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};
use tokio::sync::watch;

use crate::domain::TunnelDaemon;
use crate::live_bindings::state::TunnelState;

/// A handle onto the running tunnel's control seam. Cheap to clone (just an
/// `Arc`); hand a clone to each consumer. Implements [`TunnelService`] — the
/// contract the apps slice consumes.
///
/// There's no background machinery: a start awaits the daemon's liveness watch
/// inline. Concurrent launches coalesce on the daemon's single verification, so
/// no queue or resident task is needed.
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

    /// Wait for the tunnel to verify. `Ok(origin)` carries the public
    /// `https://{publicHost}` only once a `/health` probe through it has come
    /// back healthy; `Err(reason)` is a human-readable failure ("did not become
    /// reachable" within the daemon's
    /// [`verify_deadline`](crate::domain::TunnelDaemon::verify_deadline), or the
    /// last relay or probe error seen while waiting) suitable for surfacing
    /// inline. Backs [`TunnelService::try_start`].
    ///
    /// A tunnel that is already `Verified` returns the live origin at once.
    pub async fn request_start(&self) -> Result<String, String> {
        await_verified(&self.state.daemon).await
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

/// Await the daemon's liveness reaching a verdict: `Verified` → `Ok(origin)`,
/// otherwise wait up to the daemon's
/// [`verify_deadline`](crate::domain::TunnelDaemon::verify_deadline) for a
/// `/health` probe to verify reachability (a caller shouldn't hang on a dead
/// tunnel). Returns immediately when the liveness already holds a verdict.
async fn await_verified(daemon: &TunnelDaemon) -> Result<String, String> {
    let mut rx = daemon.watch_liveness();
    // Long enough for the first probe to land (one interval) and complete (one
    // timeout); shorter and a healthy-but-slow tunnel loses the race.
    let deadline_after = daemon.verify_deadline();
    let started = tokio::time::Instant::now();
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
                    tracing::info!(%origin, elapsed = ?started.elapsed(), "tunnel: verified");
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
                    "tunnel: deadline elapsed before the tunnel verified \
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
        TunnelStatus::Off => Some(Err("the server has no tunnel".to_string())),
        // Dialing / Unreachable: not yet a verdict — keep waiting.
        TunnelStatus::Dialing | TunnelStatus::Unreachable => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::HealthProbe;
    use crate::test_support::{relay, HoldUntilCancelRelayClient, StubProbe};

    /// A control over a daemon dialing `dev1.example.com`'s relay, probed by
    /// `probe`.
    fn control_probed_by(probe: Arc<dyn HealthProbe>) -> TunnelControl {
        TunnelControl::new(Arc::new(TunnelState {
            daemon: Arc::new(TunnelDaemon::spawn_test(
                Arc::new(HoldUntilCancelRelayClient),
                probe,
                relay(),
                "dev1.example.com",
            )),
        }))
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_returns_the_public_origin_once_verified() {
        let control = control_probed_by(Arc::new(StubProbe::passing()));
        // The supervisor's probe verifies in virtual time before the deadline.
        assert_eq!(
            control.request_start().await,
            Ok("https://dev1.example.com".to_string())
        );
        // A second launch against the now-verified tunnel returns the same
        // origin at once.
        assert_eq!(
            control.request_start().await,
            Ok("https://dev1.example.com".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn request_start_that_never_verifies_times_out() {
        let control = control_probed_by(Arc::new(StubProbe::failing()));
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
