//! [`StatusBoard`], where runs publish their units' statuses and the app reads
//! and subscribes to them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::watch;

use super::wall_clock::WallClock;
use crate::status::{RunState, RunStop, StopReason, UnitStatus, UnitStatuses};
use crate::unit::UnitId;

/// Whether a run is still in progress, as its statuses see it. A run's
/// [`RunContext`](crate::RunContext) may be held past its run's end (by a
/// thread the unit started, say); once the run has published `Stopped`, what
/// the context publishes is dropped, so the status never goes backwards.
#[derive(Clone, Default)]
pub(crate) struct RunLiveness(Arc<AtomicBool>);

impl RunLiveness {
    fn is_live(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn set(&self, live: bool) {
        self.0.store(live, Ordering::Relaxed);
    }
}

/// Every unit's status, in one watch. Every write happens inside the watch's
/// lock, where a run's liveness is also checked and changed, so a late write
/// from a finished run can't land after its `Stopped`.
pub(crate) struct StatusBoard<D> {
    statuses_tx: Arc<watch::Sender<UnitStatuses<D>>>,
    clock: Arc<dyn WallClock>,
}

impl<D> Clone for StatusBoard<D> {
    fn clone(&self) -> Self {
        Self {
            statuses_tx: Arc::clone(&self.statuses_tx),
            clock: Arc::clone(&self.clock),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> StatusBoard<D> {
    /// An empty board whose stop and running times are read on `clock`.
    pub(crate) fn new(clock: Arc<dyn WallClock>) -> Self {
        let (statuses_tx, _statuses_rx) = watch::channel(UnitStatuses::new());
        Self {
            statuses_tx: Arc::new(statuses_tx),
            clock,
        }
    }

    pub(crate) fn snapshot(&self) -> UnitStatuses<D> {
        self.statuses_tx.borrow().clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.statuses_tx.subscribe()
    }

    /// List `unit_id` as never having run, unless it is listed already.
    pub(crate) fn add_unit(&self, unit_id: &UnitId) {
        self.statuses_tx.send_if_modified(|statuses| {
            if statuses.contains_key(unit_id) {
                return false;
            }
            statuses.insert(unit_id.clone(), UnitStatus::never_run());
            true
        });
    }

    pub(crate) fn remove_unit(&self, unit_id: &UnitId) {
        self.statuses_tx
            .send_if_modified(|statuses| statuses.remove(unit_id).is_some());
    }

    /// A run of `unit_id` began: `Starting`, with no detail.
    pub(crate) fn publish_starting(&self, unit_id: &UnitId, run: &RunLiveness) {
        self.statuses_tx.send_if_modified(|statuses| {
            run.set(true);
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            *status = UnitStatus {
                run_state: RunState::Starting,
                running_since: None,
                detail: None,
            };
            true
        });
    }

    /// The run's unit is up: `Running` from now. Only a starting run moves.
    pub(crate) fn publish_running(&self, unit_id: &UnitId, run: &RunLiveness) {
        let now = self.clock.now();
        self.statuses_tx.send_if_modified(|statuses| {
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            if !run.is_live() || status.run_state != RunState::Starting {
                return false;
            }
            status.run_state = RunState::Running;
            status.running_since = Some(now);
            true
        });
    }

    /// The run's unit reports `detail`.
    pub(crate) fn publish_detail(&self, unit_id: &UnitId, run: &RunLiveness, detail: D) {
        self.statuses_tx.send_if_modified(|statuses| {
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            if !run.is_live() {
                return false;
            }
            status.detail = Some(detail);
            true
        });
    }

    /// The run's runtime is gone: `Stopped` for `reason`, with its `error`, and
    /// no detail. Nothing the run's context publishes afterwards lands.
    pub(crate) fn publish_stopped(
        &self,
        unit_id: &UnitId,
        run: &RunLiveness,
        reason: StopReason,
        error: Option<String>,
    ) {
        let stopped_at = self.clock.now();
        self.statuses_tx.send_if_modified(|statuses| {
            run.set(false);
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            *status = UnitStatus {
                run_state: RunState::Stopped {
                    last_stop: Some(RunStop {
                        reason,
                        error,
                        stopped_at,
                    }),
                },
                running_since: None,
                detail: None,
            };
            true
        });
    }
}
