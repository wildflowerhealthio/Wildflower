//! [`StatusPublisher`], where runs publish their units' statuses and stops,
//! and the app reads and subscribes to them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{broadcast, watch};

use super::RUN_STOPS_CAPACITY;
use crate::ports::wall_clock::WallClock;
use crate::status::{RunState, RunStop, RunStopped, StopReason, UnitStatus, UnitStatuses};
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

    fn set_liveness(&self, live: bool) {
        self.0.store(live, Ordering::Relaxed);
    }
}

/// Every unit's status, in one watch, and each run's stop, on one broadcast.
/// Every write happens inside the watch's lock, where a run's liveness is also
/// checked and changed, so a late write from a finished run can't land after
/// its `Stopped`. A stop is broadcast inside the same lock, so stops go out in
/// the order the statuses took them.
pub(crate) struct StatusPublisher<D> {
    statuses_tx: Arc<watch::Sender<UnitStatuses<D>>>,
    stops_tx: broadcast::Sender<RunStopped>,
    clock: Arc<dyn WallClock>,
}

impl<D> Clone for StatusPublisher<D> {
    fn clone(&self) -> Self {
        Self {
            statuses_tx: Arc::clone(&self.statuses_tx),
            stops_tx: self.stops_tx.clone(),
            clock: Arc::clone(&self.clock),
        }
    }
}

impl<D: Clone + Send + Sync + 'static> StatusPublisher<D> {
    /// No statuses yet; stop and running times are read on `clock`.
    pub(crate) fn new(clock: Arc<dyn WallClock>) -> Self {
        Self {
            statuses_tx: Arc::new(watch::Sender::new(UnitStatuses::new())),
            stops_tx: broadcast::Sender::new(RUN_STOPS_CAPACITY),
            clock,
        }
    }

    pub(crate) fn snapshot(&self) -> UnitStatuses<D> {
        self.statuses_tx.borrow().clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.statuses_tx.subscribe()
    }

    pub(crate) fn subscribe_stops(&self) -> broadcast::Receiver<RunStopped> {
        self.stops_tx.subscribe()
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
    pub(crate) fn publish_starting(&self, unit_id: &UnitId, run_liveness: &RunLiveness) {
        self.statuses_tx.send_if_modified(|statuses| {
            run_liveness.set_liveness(true);
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
    pub(crate) fn publish_running(&self, unit_id: &UnitId, run_liveness: &RunLiveness) {
        let now = self.clock.now();
        self.statuses_tx.send_if_modified(|statuses| {
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            let is_currently_starting =
                run_liveness.is_live() && status.run_state == RunState::Starting;
            if !is_currently_starting {
                return false;
            }
            status.run_state = RunState::Running;
            status.running_since = Some(now);
            true
        });
    }

    /// The run's unit reports `detail`.
    pub(crate) fn publish_detail(&self, unit_id: &UnitId, run_liveness: &RunLiveness, detail: D) {
        self.statuses_tx.send_if_modified(|statuses| {
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            if !run_liveness.is_live() {
                return false;
            }
            status.detail = Some(detail);
            true
        });
    }

    /// The run's runtime is gone: nothing its context publishes from now on
    /// lands, so its unit's status stays as the run left it until
    /// [`publish_stopped`](Self::publish_stopped).
    pub(crate) fn stop_run_reports(&self, run_liveness: &RunLiveness) {
        self.statuses_tx.send_if_modified(|_statuses| {
            run_liveness.set_liveness(false);
            false
        });
    }

    /// Whether the latest run of `unit_id` is `Running`: it announced running,
    /// and its `Stopped` isn't published yet.
    pub(crate) fn announced_running(&self, unit_id: &UnitId) -> bool {
        self.statuses_tx
            .borrow()
            .get(unit_id)
            .is_some_and(|status| status.run_state == RunState::Running)
    }

    /// The run's runtime is gone: `Stopped` for `reason`, with its `error`, and
    /// no detail, and the stop broadcast. Nothing the run's context publishes
    /// afterwards lands.
    pub(crate) fn publish_stopped(
        &self,
        unit_id: &UnitId,
        run_liveness: &RunLiveness,
        reason: StopReason,
        error: Option<String>,
    ) {
        let stopped_at = self.clock.now();
        self.statuses_tx.send_if_modified(|statuses| {
            run_liveness.set_liveness(false);
            let Some(status) = statuses.get_mut(unit_id) else {
                return false;
            };
            let stop = RunStop {
                reason,
                error,
                stopped_at,
            };
            let announced_running = status.run_state == RunState::Running;
            *status = UnitStatus {
                run_state: RunState::Stopped {
                    last_stop: Some(stop.clone()),
                },
                running_since: None,
                detail: None,
            };
            // An error means no one is subscribed, which is fine.
            let _subscribers = self.stops_tx.send(RunStopped {
                unit_id: unit_id.clone(),
                stop,
                announced_running,
            });
            true
        });
    }
}
