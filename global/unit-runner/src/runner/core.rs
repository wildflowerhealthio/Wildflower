//! [`UnitRunnerCore`]: the units, their runs and pending restarts, whether the
//! app is open, the keep-alive, and the reconcile that brings the runs in line
//! with the policies.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::runtime::Handle;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use super::erased_unit::{erase_factory, UnitFactory};
use super::keep_alive_sync::{sync_keep_alive, KeepAliveDemand};
use super::run_supervisor::{supervise_run, RunSpec};
use super::status_board::StatusBoard;
use super::unit_entry::{ActiveRun, PendingRestart, UnitEntry};
use super::wall_clock_ticker::reconcile_on_the_wall_clock;
use super::RunnerTimings;
use crate::domain::app_presence::{AppPresence, PresenceChange};
use crate::domain::keep_alive_ledger::{KeepAliveEnd, KeepAliveId, KeepAliveLedger};
use crate::domain::run_policy::RunPolicy;
#[cfg(test)]
use crate::domain::unit_plan::UnitPhase;
use crate::domain::unit_plan::{plan_unit, restarts_after, UnitAction};
use crate::ports::keep_alive_platform::KeepAlivePlatform;
use crate::ports::wall_clock::WallClock;
use crate::status::{PlatformStopReason, StopReason, UnitStatuses};
use crate::unit::{Unit, UnitId};

/// The runner, free of any platform: holds the units, reconciles their runs
/// with their policies, restarts the ones that end on their own, and publishes
/// their statuses and whether the keep-alive is wanted.
///
/// A host binds it to its platform. It tells the runner when the app opens or
/// closes ([`set_app_open`](Self::set_app_open)), when every running unit
/// should restart ([`restart_running_units`](Self::restart_running_units)),
/// and when the keep-alive task starts and ends
/// ([`keep_alive_started`](Self::keep_alive_started),
/// [`keep_alive_ended`](Self::keep_alive_ended)); and it hands the runner its
/// [`KeepAlivePlatform`] ([`start_keep_alive_sync`](Self::start_keep_alive_sync)).
///
/// Every method takes the one state lock briefly and never awaits under it;
/// runs, restart timers and the wall-clock reconcile are tasks on `runtime`.
pub struct UnitRunnerCore<D> {
    state: Mutex<RunnerState<D>>,
    board: StatusBoard<D>,
    runtime: Handle,
    clock: Arc<dyn WallClock>,
    timings: RunnerTimings,
    keep_alive_demand_tx: watch::Sender<KeepAliveDemand>,
    /// Wakes the wall-clock reconcile when the next deadline moves.
    pub(super) next_deadline_moved: Notify,
}

struct RunnerState<D> {
    units: BTreeMap<UnitId, UnitEntry<D>>,
    app_presence: AppPresence,
    keep_alive: KeepAliveLedger,
    /// The last generation handed out. Every run and every scheduled restart
    /// gets a new generation. A late event about one (a restart timer firing,
    /// a run ending) whose generation no longer matches its unit's entry is
    /// stale and ignored.
    last_generation: u64,
    /// The next wall-clock instant a policy or grace period runs out, as of
    /// the last reconcile.
    next_deadline: Option<DateTime<Utc>>,
}

impl<D> RunnerState<D> {
    fn issue_generation(&mut self) -> u64 {
        self.last_generation += 1;
        self.last_generation
    }
}

impl<D: Clone + Send + Sync + 'static> UnitRunnerCore<D> {
    /// A runner with no units, whose tasks run on `runtime`, judging policies
    /// on `clock`. Starts its wall-clock reconcile on `runtime`.
    #[must_use]
    pub fn new(runtime: Handle, clock: Arc<dyn WallClock>) -> Arc<Self> {
        Self::with_timings(runtime, clock, RunnerTimings::default())
    }

    /// [`new`](Self::new), with `timings` in place of the public constants.
    pub(crate) fn with_timings(
        runtime: Handle,
        clock: Arc<dyn WallClock>,
        timings: RunnerTimings,
    ) -> Arc<Self> {
        let (keep_alive_demand_tx, _keep_alive_demand_rx) =
            watch::channel(KeepAliveDemand::default());
        let core = Arc::new(Self {
            state: Mutex::new(RunnerState {
                units: BTreeMap::new(),
                app_presence: AppPresence::new(),
                keep_alive: KeepAliveLedger::new(),
                last_generation: 0,
                next_deadline: None,
            }),
            board: StatusBoard::new(Arc::clone(&clock)),
            runtime,
            clock,
            timings,
            keep_alive_demand_tx,
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

    /// The runtime the runner's tasks run on, for a host's own tasks that
    /// report back to the runner.
    #[must_use]
    pub fn runtime(&self) -> &Handle {
        &self.runtime
    }

    fn lock_state(&self) -> MutexGuard<'_, RunnerState<D>> {
        // Nothing under the lock panics midway through an update, so a
        // poisoned lock's state is still whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every unit's current status.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<D> {
        self.board.snapshot()
    }

    /// Every unit's status, as it changes. The receiver always holds the
    /// current statuses; a slow reader sees the latest, not every step.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.board.subscribe()
    }

    pub(crate) fn subscribe_keep_alive_demand(&self) -> watch::Receiver<KeepAliveDemand> {
        self.keep_alive_demand_tx.subscribe()
    }

    /// Where the unit `unit_id` is, as a reconcile sees it; `None` for a unit
    /// the runner doesn't hold. Lets tests check that nothing happened
    /// without waiting to see.
    #[cfg(test)]
    pub(crate) fn unit_phase(&self, unit_id: &UnitId) -> Option<UnitPhase> {
        self.lock_state().units.get(unit_id).map(UnitEntry::phase)
    }

    /// Start and stop the platform's keep-alive task through `platform`, to
    /// match whether any unit should run, for as long as the runner lives.
    /// Call it once, when the platform can take its first start.
    pub fn start_keep_alive_sync(self: &Arc<Self>, platform: Arc<dyn KeepAlivePlatform>) {
        self.runtime
            .spawn(sync_keep_alive(Arc::clone(self), platform));
    }

    /// Add the unit `unit_id` with `policy`, whose runs are built by `factory`;
    /// or, for a unit already set, replace its policy and factory, stopping a
    /// run of the old definition. The unit starts at once if it should run.
    ///
    /// A factory that fails is a failed run.
    pub fn set_unit<U: Unit<Detail = D>>(
        self: &Arc<Self>,
        unit_id: UnitId,
        policy: RunPolicy,
        factory: impl Fn() -> anyhow::Result<U> + Send + Sync + 'static,
    ) {
        let factory: UnitFactory<D> = erase_factory(factory);
        let mut state = self.lock_state();
        self.board.add_unit(&unit_id);
        match state.units.get_mut(&unit_id) {
            Some(entry) => {
                entry.policy = policy;
                entry.factory = factory;
                entry.removing = false;
                entry.pending_restart = None;
                entry.stop_run(StopReason::Replaced);
            }
            None => {
                state.units.insert(unit_id, UnitEntry::new(policy, factory));
            }
        }
        self.reconcile_locked(&mut state);
    }

    /// Replace the policy of the unit `unit_id`. Even with the policy it
    /// already has, this cancels a pending restart and clears a keep-alive
    /// revocation, so the unit starts at once if it should run. A unit never
    /// set is logged and ignored.
    pub fn set_unit_policy(self: &Arc<Self>, unit_id: &UnitId, policy: RunPolicy) {
        let mut state = self.lock_state();
        let Some(entry) = state.units.get_mut(unit_id) else {
            log::warn!("[unit-runner] set_unit_policy for {unit_id}, which was never set; ignored");
            return;
        };
        entry.policy = policy;
        entry.pending_restart = None;
        state.keep_alive.clear_revocation();
        self.reconcile_locked(&mut state);
    }

    /// Stop the unit `unit_id`, wait for its run to end, and forget it, status
    /// included. Run shutdown is bounded, so this always finishes. A unit never
    /// set is logged and ignored.
    pub async fn remove_unit(self: &Arc<Self>, unit_id: &UnitId) {
        let finished_rx = {
            let mut state = self.lock_state();
            let Some(entry) = state.units.get_mut(unit_id) else {
                log::warn!("[unit-runner] remove_unit for {unit_id}, which was never set; ignored");
                return;
            };
            entry.removing = true;
            entry.pending_restart = None;
            entry.stop_run(StopReason::Removed);
            let finished_rx = entry.run.as_ref().map(|run| run.finished_rx.clone());
            self.reconcile_locked(&mut state);
            finished_rx
        };
        // Wait without holding the lock until the run's thread and runtime
        // are gone. The sender lives until then, and says so first.
        if let Some(mut finished_rx) = finished_rx {
            let _run_finished = finished_rx.wait_for(|finished| *finished).await;
        }
        // Check again: a `set_unit` while we waited may have brought the unit
        // back, and then it stays.
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

    /// The app is open now, or closed. Opening clears a keep-alive
    /// revocation.
    pub fn set_app_open(self: &Arc<Self>, open: bool) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        match state.app_presence.update(open, now) {
            PresenceChange::Opened => state.keep_alive.clear_revocation(),
            PresenceChange::Closed | PresenceChange::Unchanged => {}
        }
        self.reconcile_locked(&mut state);
    }

    /// Restart every unit whose run is in progress: each run stops, and the
    /// unit starts again once it has ended.
    pub fn restart_running_units(self: &Arc<Self>) {
        let state = self.lock_state();
        for entry in state.units.values() {
            entry.stop_run(StopReason::StoppedForRestart);
        }
    }

    /// A keep-alive task started, whoever started it. It clears a
    /// revocation. The task reports its end with the returned id.
    pub fn keep_alive_started(self: &Arc<Self>) -> KeepAliveId {
        let mut state = self.lock_state();
        let id = state.keep_alive.task_started();
        log::info!("[unit-runner] keep-alive {id:?} started");
        self.reconcile_locked(&mut state);
        id
    }

    /// The runner is about to stop the keep-alive task; returns it, or `None`
    /// when there is none to stop or a unit should run again.
    pub(crate) fn request_keep_alive_release(self: &Arc<Self>) -> Option<KeepAliveId> {
        let mut state = self.lock_state();
        let keep_alive_wanted = self.reconcile_locked(&mut state);
        if keep_alive_wanted {
            // A unit should run again since the demand was read.
            return None;
        }
        let id = state.keep_alive.request_release();
        self.reconcile_locked(&mut state);
        id
    }

    /// The keep-alive task `id` ended, for `platform_reason` when the platform
    /// gave one. When the platform ended the current task, every run stops
    /// with the platform's reason, and no unit starts until the keep-alive
    /// starts again, the app opens, or a policy is set.
    pub fn keep_alive_ended(
        self: &Arc<Self>,
        id: KeepAliveId,
        platform_reason: Option<PlatformStopReason>,
    ) {
        let mut state = self.lock_state();
        match state.keep_alive.task_ended(id, platform_reason) {
            KeepAliveEnd::Revoked(platform_reason) => {
                log::warn!(
                    "[unit-runner] the platform revoked keep-alive {id:?}: {platform_reason:?}"
                );
                for entry in state.units.values_mut() {
                    entry.pending_restart = None;
                    entry.stop_run(StopReason::KeepAliveRevoked { platform_reason });
                }
            }
            KeepAliveEnd::Released => log::info!("[unit-runner] keep-alive {id:?} stopped"),
            KeepAliveEnd::Superseded => {}
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

    /// The run of `unit_id` with `generation` ended for `reason`. Restarts it
    /// after the restart delay when it ended on its own while its unit should
    /// still run.
    pub(super) fn run_ended(
        self: &Arc<Self>,
        unit_id: &UnitId,
        generation: u64,
        reason: StopReason,
    ) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        let app_open_or_in_grace = state.app_presence.open_or_in_grace(now);
        let keep_alive_revoked = state.keep_alive.is_revoked();
        let restart_generation = state.last_generation + 1;
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        if entry.run.as_ref().map(|run| run.generation) != Some(generation) {
            return;
        }
        entry.run = None;
        let should_run = entry.should_run(now, app_open_or_in_grace, keep_alive_revoked);
        if restarts_after(reason, should_run) {
            entry.pending_restart = Some(PendingRestart {
                generation: restart_generation,
            });
            state.last_generation = restart_generation;
            log::info!(
                "[unit-runner] {unit_id} restarts in {:?}",
                self.timings.restart_delay
            );
            let core = Arc::clone(self);
            let unit_id = unit_id.clone();
            self.runtime.spawn(async move {
                tokio::time::sleep(core.timings.restart_delay).await;
                core.restart_due(&unit_id, restart_generation);
            });
        }
        self.reconcile_locked(&mut state);
    }

    /// The restart of `unit_id` with `generation` has waited out its delay. A
    /// restart that was cancelled or replaced since does nothing.
    fn restart_due(self: &Arc<Self>, unit_id: &UnitId, generation: u64) {
        let mut state = self.lock_state();
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        if entry
            .pending_restart
            .as_ref()
            .is_some_and(|restart| restart.generation == generation)
        {
            entry.pending_restart = None;
            self.reconcile_locked(&mut state);
        }
    }

    /// Start every unit that should run and isn't running, stop every running
    /// unit that shouldn't be, publish whether the keep-alive is wanted
    /// (whenever any unit should run, one waiting out its restart delay
    /// included), and move the wall-clock reconcile's next deadline. Returns
    /// whether the keep-alive is wanted.
    fn reconcile_locked(self: &Arc<Self>, state: &mut RunnerState<D>) -> bool {
        let now = self.clock.now();
        let app_open_or_in_grace = state.app_presence.open_or_in_grace(now);
        let keep_alive_revoked = state.keep_alive.is_revoked();
        let mut starts = Vec::new();
        let mut keep_alive_wanted = false;
        for (unit_id, entry) in &mut state.units {
            let should_run = entry.should_run(now, app_open_or_in_grace, keep_alive_revoked);
            keep_alive_wanted |= should_run;
            match plan_unit(should_run, entry.phase()) {
                UnitAction::Start => starts.push(unit_id.clone()),
                // A unit being removed, or stopped by a revocation, already
                // has its run stopped with that reason. What's left is a
                // policy that is no longer active.
                UnitAction::Stop => entry.stop_run(StopReason::PolicyInactive),
                UnitAction::CancelRestart => entry.pending_restart = None,
                UnitAction::Keep => {}
            }
        }
        for unit_id in starts {
            self.start_run(state, unit_id);
        }

        self.publish_keep_alive_demand(state, keep_alive_wanted);
        let next_deadline = state
            .units
            .values()
            .filter_map(|entry| entry.policy.expires_after(now))
            .chain(
                state
                    .app_presence
                    .grace_ends_at()
                    .filter(|ends_at| now < *ends_at),
            )
            .min();
        if next_deadline != state.next_deadline {
            state.next_deadline = next_deadline;
            self.next_deadline_moved.notify_one();
        }
        keep_alive_wanted
    }

    fn publish_keep_alive_demand(&self, state: &RunnerState<D>, wanted: bool) {
        let demand = KeepAliveDemand {
            wanted,
            kept: state.keep_alive.is_kept(),
        };
        self.keep_alive_demand_tx.send_if_modified(|current| {
            let changed = *current != demand;
            *current = demand;
            changed
        });
    }

    fn start_run(self: &Arc<Self>, state: &mut RunnerState<D>, unit_id: UnitId) {
        let generation = state.issue_generation();
        let Some(entry) = state.units.get_mut(&unit_id) else {
            return;
        };
        let shutdown = CancellationToken::new();
        let stop_reason = Arc::new(OnceLock::new());
        let (finished_tx, finished_rx) = watch::channel(false);
        entry.run = Some(ActiveRun {
            generation,
            shutdown: shutdown.clone(),
            stop_reason: Arc::clone(&stop_reason),
            finished_rx,
        });
        log::info!("[unit-runner] starting {unit_id}");
        let spec = RunSpec {
            unit_id,
            generation,
            factory: Arc::clone(&entry.factory),
            gate: entry.gate.clone(),
            shutdown,
            stop_reason,
            finished_tx,
        };
        self.runtime.spawn(supervise_run(Arc::clone(self), spec));
    }
}
