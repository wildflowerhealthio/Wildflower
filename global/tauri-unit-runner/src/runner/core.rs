//! [`RunnerCore`]: the units, their runs and pending restarts, the app's use and
//! the lease, and the reconcile that brings the runs in line with the
//! policies.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::runtime::Handle;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use super::erased_unit::UnitFactory;
use super::lease_driver::LeaseDemand;
use super::run_supervisor::{supervise_run, RunSpec};
use super::status_board::StatusBoard;
use super::unit_entry::{ActiveRun, PendingRestart, UnitEntry};
use super::wall_clock::WallClock;
use super::wall_clock_ticker::reconcile_on_the_wall_clock;
use super::RunnerTimings;
use crate::domain::app_use::{AppUse, UseChange};
use crate::domain::lease_book::{LeaseBook, LeaseEnd, LeaseId};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::{plan_unit, restarts_after, UnitAction};
use crate::status::{PlatformStopReason, StopReason, UnitStatuses};
use crate::unit::UnitId;

/// The runner's engine. Every method takes the one state lock briefly and
/// never awaits under it; runs, restart timers and the wall-clock reconcile
/// are tasks on `runtime`.
pub(crate) struct RunnerCore<D> {
    state: Mutex<RunnerState<D>>,
    board: StatusBoard<D>,
    runtime: Handle,
    clock: Arc<dyn WallClock>,
    timings: RunnerTimings,
    lease_demand_tx: watch::Sender<LeaseDemand>,
    /// Wakes the wall-clock reconcile when the next deadline moves.
    pub(super) next_deadline_moved: Notify,
}

struct RunnerState<D> {
    units: BTreeMap<UnitId, UnitEntry<D>>,
    app_use: AppUse,
    lease: LeaseBook,
    /// The last run or restart number handed out.
    issued_numbers: u64,
    /// The next wall-clock instant a policy or grace period runs out, as of
    /// the last reconcile.
    next_deadline: Option<DateTime<Utc>>,
}

impl<D> RunnerState<D> {
    fn issue_number(&mut self) -> u64 {
        self.issued_numbers += 1;
        self.issued_numbers
    }
}

impl<D: Clone + Send + Sync + 'static> RunnerCore<D> {
    /// A runner with no units, whose tasks run on `runtime`, judging policies
    /// on `clock`. Starts its wall-clock reconcile.
    pub(crate) fn new(
        runtime: Handle,
        clock: Arc<dyn WallClock>,
        timings: RunnerTimings,
    ) -> Arc<Self> {
        let (lease_demand_tx, _lease_demand_rx) = watch::channel(LeaseDemand::default());
        let core = Arc::new(Self {
            state: Mutex::new(RunnerState {
                units: BTreeMap::new(),
                app_use: AppUse::new(),
                lease: LeaseBook::new(),
                issued_numbers: 0,
                next_deadline: None,
            }),
            board: StatusBoard::new(Arc::clone(&clock)),
            runtime,
            clock,
            timings,
            lease_demand_tx,
            next_deadline_moved: Notify::new(),
        });
        core.runtime
            .spawn(reconcile_on_the_wall_clock(Arc::clone(&core)));
        core
    }

    pub(super) fn board(&self) -> &StatusBoard<D> {
        &self.board
    }

    pub(super) fn timings(&self) -> RunnerTimings {
        self.timings
    }

    pub(crate) fn runtime(&self) -> &Handle {
        &self.runtime
    }

    fn lock_state(&self) -> MutexGuard<'_, RunnerState<D>> {
        // Nothing under the lock panics midway through an update, so a
        // poisoned lock's state is still whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn statuses(&self) -> UnitStatuses<D> {
        self.board.snapshot()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.board.subscribe()
    }

    pub(crate) fn subscribe_lease_demand(&self) -> watch::Receiver<LeaseDemand> {
        self.lease_demand_tx.subscribe()
    }

    /// Add the unit `unit_id`, or replace its policy and factory. A run of the
    /// replaced definition stops; the unit starts again from the new factory
    /// if it should run.
    pub(crate) fn set(
        self: &Arc<Self>,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: UnitFactory<D>,
    ) {
        let mut state = self.lock_state();
        self.board.add_unit(&unit_id);
        match state.units.get_mut(&unit_id) {
            Some(entry) => {
                entry.policy = policy;
                entry.factory = factory;
                entry.removing = false;
                entry.pending_restart = None;
                entry.stop_run(StopReason::StoppedByRunner);
            }
            None => {
                state.units.insert(unit_id, UnitEntry::new(policy, factory));
            }
        }
        self.reconcile_locked(&mut state);
    }

    /// Replace the policy of the unit `unit_id`. Drops a pending restart and
    /// lets units start again after the platform ended the lease, so the unit
    /// starts at once if it should run.
    pub(crate) fn set_policy(self: &Arc<Self>, unit_id: &UnitId, policy: RunPolicy) {
        let mut state = self.lock_state();
        let Some(entry) = state.units.get_mut(unit_id) else {
            log::warn!("[unit-runner] set_policy for {unit_id}, which was never set; ignored");
            return;
        };
        entry.policy = policy;
        entry.pending_restart = None;
        state.lease.forget_platform_end();
        self.reconcile_locked(&mut state);
    }

    /// Stop the unit `unit_id`, wait for its run to end, and forget it.
    pub(crate) async fn remove(self: &Arc<Self>, unit_id: &UnitId) {
        let ended_rx = {
            let mut state = self.lock_state();
            let Some(entry) = state.units.get_mut(unit_id) else {
                log::warn!("[unit-runner] remove for {unit_id}, which was never set; ignored");
                return;
            };
            entry.removing = true;
            entry.pending_restart = None;
            entry.stop_run(StopReason::StoppedByRunner);
            let ended_rx = entry.run.as_ref().map(|run| run.ended_rx.clone());
            self.reconcile_locked(&mut state);
            ended_rx
        };
        if let Some(mut ended_rx) = ended_rx {
            // The sender lives until the run has ended, and says so first.
            let _run_ended = ended_rx.wait_for(|ended| *ended).await;
        }
        let mut state = self.lock_state();
        let still_removing = state
            .units
            .get(unit_id)
            .is_some_and(|entry| entry.removing && entry.run.is_none());
        if still_removing {
            state.units.remove(unit_id);
            self.board.remove_unit(unit_id);
        }
    }

    /// The app is or isn't in use now. Coming back into use lets units start
    /// again after the platform ended the lease.
    pub(crate) fn set_in_use(self: &Arc<Self>, in_use: bool) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        match state.app_use.update(in_use, now) {
            UseChange::CameIntoUse => state.lease.forget_platform_end(),
            UseChange::LeftUse | UseChange::Unchanged => {}
        }
        self.reconcile_locked(&mut state);
    }

    /// Restart every unit whose run is in progress: each run stops, and the
    /// unit starts again once it has ended.
    pub(crate) fn restart_running_units(self: &Arc<Self>) {
        let state = self.lock_state();
        for entry in state.units.values() {
            entry.stop_run(StopReason::StoppedByRunner);
        }
    }

    /// A lease task began: the runner holds the lease.
    pub(crate) fn lease_gained(self: &Arc<Self>) -> LeaseId {
        let mut state = self.lock_state();
        let lease = state.lease.gained();
        log::info!("[unit-runner] lease {lease:?} gained");
        self.reconcile_locked(&mut state);
        lease
    }

    /// The runner is about to release the lease it holds; returns it, or `None`
    /// when there is none to release.
    pub(crate) fn begin_lease_release(self: &Arc<Self>) -> Option<LeaseId> {
        let mut state = self.lock_state();
        let lease_wanted = self.reconcile_locked(&mut state);
        if lease_wanted {
            // A unit should run again since the demand was read.
            return None;
        }
        let lease = state.lease.begin_release();
        self.reconcile_locked(&mut state);
        lease
    }

    /// The lease task for `lease` ended, for `platform_reason` when the
    /// platform gave one. When the platform ended the lease the runner holds,
    /// every run stops with the platform's reason, and no unit starts until
    /// the lease comes back, the app comes back into use, or a policy is set.
    pub(crate) fn lease_ended(
        self: &Arc<Self>,
        lease: LeaseId,
        platform_reason: Option<PlatformStopReason>,
    ) {
        let mut state = self.lock_state();
        match state.lease.ended(lease, platform_reason) {
            LeaseEnd::EndedByPlatform(platform_reason) => {
                log::warn!("[unit-runner] the platform ended lease {lease:?}: {platform_reason:?}");
                for entry in state.units.values_mut() {
                    entry.pending_restart = None;
                    entry.stop_run(StopReason::LeaseEnded { platform_reason });
                }
            }
            LeaseEnd::ReleasedByRunner => log::info!("[unit-runner] lease {lease:?} released"),
            LeaseEnd::Stale => {}
        }
        self.reconcile_locked(&mut state);
    }

    /// Bring every unit's run in line with its policy now.
    pub(crate) fn reconcile(self: &Arc<Self>) {
        let mut state = self.lock_state();
        self.reconcile_locked(&mut state);
    }

    /// How long until the wall-clock reconcile should run again: the next
    /// deadline, but never longer than the wall-clock interval.
    pub(crate) fn time_until_next_reconcile(&self) -> Duration {
        let next_deadline = self.lock_state().next_deadline;
        let interval = self.timings.wall_clock_reconcile_interval;
        next_deadline
            .and_then(|deadline| (deadline - self.clock.now()).to_std().ok())
            .map_or(interval, |until_deadline| until_deadline.min(interval))
    }

    /// The run `number` of `unit_id` ended for `reason`. Restarts it after the
    /// restart delay when it ended on its own while its unit should still run.
    pub(super) fn run_ended(self: &Arc<Self>, unit_id: &UnitId, number: u64, reason: StopReason) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        let in_use = state.app_use.in_use_or_in_grace(now);
        let lease_allows_runs = state.lease.allows_runs();
        let restart_number = state.issued_numbers + 1;
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        if entry.run.as_ref().map(|run| run.number) != Some(number) {
            return;
        }
        entry.run = None;
        let should_run = entry.should_run(now, in_use, lease_allows_runs);
        if restarts_after(reason, should_run) {
            entry.pending_restart = Some(PendingRestart {
                number: restart_number,
            });
            state.issued_numbers = restart_number;
            log::info!(
                "[unit-runner] {unit_id} restarts in {:?}",
                self.timings.restart_delay
            );
            let core = Arc::clone(self);
            let unit_id = unit_id.clone();
            self.runtime.spawn(async move {
                tokio::time::sleep(core.timings.restart_delay).await;
                core.restart_due(&unit_id, restart_number);
            });
        }
        self.reconcile_locked(&mut state);
    }

    /// The restart `number` of `unit_id` has waited out its delay. A restart
    /// that was cancelled or replaced since does nothing.
    fn restart_due(self: &Arc<Self>, unit_id: &UnitId, number: u64) {
        let mut state = self.lock_state();
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        if entry
            .pending_restart
            .as_ref()
            .is_some_and(|restart| restart.number == number)
        {
            entry.pending_restart = None;
            self.reconcile_locked(&mut state);
        }
    }

    /// Start every unit that should run and isn't running, stop every running
    /// unit that shouldn't be, publish whether the lease is wanted (whenever
    /// any unit should run, one waiting out its restart delay included), and
    /// move the wall-clock reconcile's next deadline. Returns whether the
    /// lease is wanted.
    fn reconcile_locked(self: &Arc<Self>, state: &mut RunnerState<D>) -> bool {
        let now = self.clock.now();
        let in_use = state.app_use.in_use_or_in_grace(now);
        let lease_allows_runs = state.lease.allows_runs();
        let mut starts = Vec::new();
        let mut lease_wanted = false;
        for (unit_id, entry) in &mut state.units {
            let should_run = entry.should_run(now, in_use, lease_allows_runs);
            lease_wanted |= should_run;
            match plan_unit(should_run, entry.activity()) {
                UnitAction::Start => starts.push(unit_id.clone()),
                UnitAction::Stop => entry.stop_run(StopReason::StoppedByRunner),
                UnitAction::CancelRestart => entry.pending_restart = None,
                UnitAction::Keep => {}
            }
        }
        for unit_id in starts {
            self.start_run(state, unit_id);
        }

        self.publish_lease_demand(state, lease_wanted);
        let next_deadline = state
            .units
            .values()
            .filter_map(|entry| entry.policy.expires_after(now))
            .chain(
                state
                    .app_use
                    .grace_ends_at()
                    .filter(|ends_at| now < *ends_at),
            )
            .min();
        if next_deadline != state.next_deadline {
            state.next_deadline = next_deadline;
            self.next_deadline_moved.notify_one();
        }
        lease_wanted
    }

    fn publish_lease_demand(&self, state: &RunnerState<D>, wanted: bool) {
        let demand = LeaseDemand {
            wanted,
            held: state.lease.holds_and_keeps(),
        };
        self.lease_demand_tx.send_if_modified(|current| {
            let changed = *current != demand;
            *current = demand;
            changed
        });
    }

    fn start_run(self: &Arc<Self>, state: &mut RunnerState<D>, unit_id: UnitId) {
        let number = state.issue_number();
        let Some(entry) = state.units.get_mut(&unit_id) else {
            return;
        };
        let shutdown = CancellationToken::new();
        let stop_reason = Arc::new(OnceLock::new());
        let (ended_tx, ended_rx) = watch::channel(false);
        entry.run = Some(ActiveRun {
            number,
            shutdown: shutdown.clone(),
            stop_reason: Arc::clone(&stop_reason),
            ended_rx,
        });
        log::info!("[unit-runner] starting {unit_id}");
        let spec = RunSpec {
            unit_id,
            number,
            factory: Arc::clone(&entry.factory),
            gate: entry.gate.clone(),
            shutdown,
            stop_reason,
            ended_tx,
        };
        self.runtime.spawn(supervise_run(Arc::clone(self), spec));
    }
}
