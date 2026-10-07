//! [`UnitRunner`]: the units, their runs and pending restarts, whether the
//! app is present, the background session, and starting and stopping runs per
//! policy.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::runtime::Handle;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;

use super::background_session_driver::{drive_background_session, SessionDemand};
use super::erased_unit::{erase_factory, UnitFactory};
use super::run_stop_signal::RunStopSignal;
use super::run_supervisor::{supervise_run, SuperviseRunArgs};
use super::status_publisher::{RunLiveness, StatusPublisher};
use super::unit_entry::{PendingRestart, RunGeneration, UnitEntry, UnitRun};
use super::wall_clock_ticker::start_and_stop_runs_on_the_wall_clock;
use super::RunnerTimings;
use crate::domain::app_presence::{AppPresence, PresenceChange};
use crate::domain::run_policy::RunPolicy;
use crate::domain::session_ledger::{SessionEnd, SessionId, SessionLedger};
#[cfg(test)]
use crate::domain::unit_plan::UnitPhase;
use crate::domain::unit_plan::{plan_unit, restarts_after, UnitAction};
use crate::ports::background_session_platform::BackgroundSessionPlatform;
use crate::ports::wall_clock::WallClock;
use crate::run_context::RunContext;
use crate::status::{PlatformStopReason, StopReason, UnitStatuses};
use crate::unit::{Unit, UnitId};

/// Runs an app's units, free of any platform: holds the units, starts and stops
/// their runs per their policies, restarts the ones that end on their own, and
/// publishes their statuses and whether a background session is wanted.
///
/// A host binds it to its platform. It tells `UnitRunner` when the app becomes
/// present or absent ([`set_app_present`](Self::set_app_present)), when every
/// running unit should restart
/// ([`restart_running_units`](Self::restart_running_units)), and when a
/// background session starts and ends
/// ([`session_started`](Self::session_started),
/// [`session_ended`](Self::session_ended)); and it hands `UnitRunner` its
/// [`BackgroundSessionPlatform`]
/// ([`start_driving_background_session`](Self::start_driving_background_session)).
///
/// Every method takes the one state lock briefly and never awaits under it;
/// runs, restart timers and the wall-clock ticker are tasks on `runtime`.
pub struct UnitRunner<D> {
    state: Mutex<UnitRunnerState<D>>,
    status_publisher: StatusPublisher<D>,
    runtime: Handle,
    clock: Arc<dyn WallClock>,
    timings: RunnerTimings,
    session_demand_tx: watch::Sender<SessionDemand>,
    /// Wakes the wall-clock ticker when the next deadline moves.
    pub(super) next_start_and_stop_runs_moved: Notify,
}

struct UnitRunnerState<D> {
    units: BTreeMap<UnitId, UnitEntry<D>>,
    app_presence: AppPresence,
    session_ledger: SessionLedger,
    /// The last generation handed out. Every run gets a new generation. A late
    /// end of a run whose generation no longer matches its unit's current run
    /// is stale and ignored.
    last_generation: RunGeneration,
    /// The next wall-clock instant a policy or grace period runs out, as of
    /// the last `start_and_stop_runs_per_policy`.
    next_start_and_stop_runs_at: Option<DateTime<Utc>>,
}

impl<D> UnitRunnerState<D> {
    fn issue_generation(&mut self) -> RunGeneration {
        self.last_generation = self.last_generation.next();
        self.last_generation
    }
}

impl<D: Clone + Send + Sync + 'static> UnitRunner<D> {
    /// A `UnitRunner` with no units, whose tasks run on `runtime`, judging
    /// policies on `clock`. Starts its wall-clock ticker on `runtime`.
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
        let unit_runner = Arc::new(Self {
            state: Mutex::new(UnitRunnerState {
                units: BTreeMap::new(),
                app_presence: AppPresence::new(),
                session_ledger: SessionLedger::new(),
                last_generation: RunGeneration::default(),
                next_start_and_stop_runs_at: None,
            }),
            status_publisher: StatusPublisher::new(Arc::clone(&clock)),
            runtime,
            clock,
            timings,
            session_demand_tx: watch::Sender::new(SessionDemand::default()),
            next_start_and_stop_runs_moved: Notify::new(),
        });
        unit_runner
            .runtime
            .spawn(start_and_stop_runs_on_the_wall_clock(Arc::clone(
                &unit_runner,
            )));
        unit_runner
    }

    /// The runtime `UnitRunner`'s tasks run on, for a host's own tasks that
    /// report back to `UnitRunner`.
    #[must_use]
    pub fn runtime(&self) -> &Handle {
        &self.runtime
    }

    fn lock_state(&self) -> MutexGuard<'_, UnitRunnerState<D>> {
        // Nothing under the lock panics midway through an update, so a
        // poisoned lock's state is still whole.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every unit's current status.
    #[must_use]
    pub fn statuses(&self) -> UnitStatuses<D> {
        self.status_publisher.snapshot()
    }

    /// Every unit's status, as it changes. The receiver always holds the
    /// current statuses; a slow reader sees the latest, not every step.
    #[must_use]
    pub fn subscribe(&self) -> watch::Receiver<UnitStatuses<D>> {
        self.status_publisher.subscribe()
    }

    pub(crate) fn subscribe_session_demand(&self) -> watch::Receiver<SessionDemand> {
        self.session_demand_tx.subscribe()
    }

    /// Where the unit `unit_id` is, as starting and stopping runs per policy
    /// sees it; `None` for a unit `UnitRunner` doesn't hold. Lets tests check
    /// that nothing happened without waiting to see.
    #[cfg(test)]
    pub(crate) fn unit_phase(&self, unit_id: &UnitId) -> Option<UnitPhase> {
        self.lock_state().units.get(unit_id).map(UnitEntry::phase)
    }

    /// Start and end the platform's background session through `platform`, to
    /// match whether any unit should run, for as long as `UnitRunner` lives.
    /// Call it once, when the platform can take its first start.
    pub fn start_driving_background_session(
        self: &Arc<Self>,
        platform: Arc<dyn BackgroundSessionPlatform>,
    ) {
        self.runtime
            .spawn(drive_background_session(Arc::clone(self), platform));
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
        self.status_publisher.add_unit(&unit_id);
        match state.units.get_mut(&unit_id) {
            Some(entry) => {
                entry.policy = policy;
                entry.factory = factory;
                entry.awaiting_removal = false;
                entry.pending_restart = None;
                entry.stop_run(StopReason::Replaced);
            }
            None => {
                state.units.insert(unit_id, UnitEntry::new(policy, factory));
            }
        }
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// Replace the policy of the unit `unit_id`, even with the policy it
    /// already has. A unit never set is logged and ignored. Setting a policy:
    ///
    ///  - drops a pending restart, so a fresh instruction acts now rather than
    ///    after the delay left over from the last run;
    ///  - clears an end of the background session by the platform, so the
    ///    app's instruction counts for more than the platform's earlier end;
    ///  - starts and stops runs per policy, so the unit starts at once if it
    ///    should run.
    pub fn set_unit_policy(self: &Arc<Self>, unit_id: &UnitId, policy: RunPolicy) {
        let mut state = self.lock_state();
        let Some(entry) = state.units.get_mut(unit_id) else {
            log::warn!("[unit-runner] set_unit_policy for {unit_id}, which was never set; ignored");
            return;
        };
        entry.policy = policy;
        entry.pending_restart = None;
        state.session_ledger.clear_ended_by_platform();
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// Stop the unit `unit_id`, wait for its run to end, and forget it, status
    /// included. Run shutdown is bounded, so this always finishes. A unit never
    /// set is logged and ignored.
    pub async fn remove_unit(self: &Arc<Self>, unit_id: &UnitId) {
        let run_finished_rx = {
            let mut state = self.lock_state();
            let Some(entry) = state.units.get_mut(unit_id) else {
                log::warn!("[unit-runner] remove_unit for {unit_id}, which was never set; ignored");
                return;
            };
            entry.awaiting_removal = true;
            entry.pending_restart = None;
            entry.stop_run(StopReason::Removed);
            let run_finished_rx = entry
                .current_run
                .as_ref()
                .map(|run| run.run_finished_rx.clone());
            self.start_and_stop_runs_per_policy_locked(&mut state);
            run_finished_rx
        };
        // Wait without holding the lock until the run's thread and runtime
        // are gone. The sender lives until then, and says so first.
        if let Some(mut run_finished_rx) = run_finished_rx {
            let _run_finished = run_finished_rx.wait_for(|finished| *finished).await;
        }
        // Check again: a `set_unit` while we waited may have brought the unit
        // back, and then it stays.
        let mut state = self.lock_state();
        let still_awaiting_removal = state
            .units
            .get(unit_id)
            .is_some_and(|entry| entry.awaiting_removal && entry.current_run.is_none());
        if still_awaiting_removal {
            state.units.remove(unit_id);
            self.status_publisher.remove_unit(unit_id);
        }
    }

    /// The app is present now, or absent. Becoming present clears an end of
    /// the background session by the platform.
    pub fn set_app_present(self: &Arc<Self>, present: bool) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        match state.app_presence.update(present, now) {
            PresenceChange::BecamePresent => state.session_ledger.clear_ended_by_platform(),
            PresenceChange::BecameAbsent | PresenceChange::Unchanged => {}
        }
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// Restart every unit whose run is in progress: each run stops, and the
    /// unit starts again once it has ended.
    pub fn restart_running_units(self: &Arc<Self>) {
        let state = self.lock_state();
        for entry in state.units.values() {
            entry.stop_run(StopReason::StoppedForRestart);
        }
    }

    /// A background session started, whoever started it. It clears an end of
    /// the session by the platform. The session reports its end with the
    /// returned id.
    pub fn session_started(self: &Arc<Self>) -> SessionId {
        let mut state = self.lock_state();
        let id = state.session_ledger.session_started();
        log::info!("[unit-runner] background session {id:?} started");
        self.start_and_stop_runs_per_policy_locked(&mut state);
        id
    }

    /// `UnitRunner` is about to end the background session because no unit
    /// should run; returns it, or `None` when there is none to end or a unit
    /// should run again.
    pub(crate) fn mark_session_no_longer_needed(self: &Arc<Self>) -> Option<SessionId> {
        let mut state = self.lock_state();
        let some_unit_should_run = self.start_and_stop_runs_per_policy_locked(&mut state);
        if some_unit_should_run {
            // A unit should run again since the demand was read.
            return None;
        }
        let id = state.session_ledger.mark_no_longer_needed();
        self.start_and_stop_runs_per_policy_locked(&mut state);
        id
    }

    /// The background session `id` ended, for `platform_reason` when the
    /// platform gave one. When the platform ended the current session, every
    /// run stops with the platform's reason, and no unit starts until a
    /// session starts again, the app becomes present, or a policy is set.
    pub fn session_ended(
        self: &Arc<Self>,
        id: SessionId,
        platform_reason: Option<PlatformStopReason>,
    ) {
        let mut state = self.lock_state();
        match state.session_ledger.session_ended(id, platform_reason) {
            SessionEnd::EndedByPlatform(platform_reason) => {
                log::warn!(
                    "[unit-runner] the platform ended background session {id:?}: \
                     {platform_reason:?}"
                );
                for entry in state.units.values_mut() {
                    entry.pending_restart = None;
                    entry.stop_run(StopReason::SessionEndedByPlatform { platform_reason });
                }
            }
            SessionEnd::NoLongerNeeded => {
                log::info!("[unit-runner] background session {id:?} ended");
            }
            SessionEnd::Stale => {
                log::debug!("[unit-runner] earlier background session {id:?} ended");
            }
        }
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// Start and stop every unit's run per its policy now.
    pub(crate) fn start_and_stop_runs_per_policy(self: &Arc<Self>) {
        let mut state = self.lock_state();
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// How long until the wall-clock ticker should start and stop runs per
    /// policy again: the next deadline, but never longer than the wall-clock
    /// interval.
    pub(crate) fn time_until_start_and_stop_runs(&self) -> Duration {
        let next_start_and_stop_runs_at = self.lock_state().next_start_and_stop_runs_at;
        let interval = self.timings.start_and_stop_runs_per_policy_interval;
        next_start_and_stop_runs_at
            .and_then(|deadline| (deadline - self.clock.now()).to_std().ok())
            .map_or(interval, |until_deadline| until_deadline.min(interval))
    }

    /// The run of `unit_id` passed its gate and is starting: publishes
    /// `Starting`, and returns the run's liveness, which its context reports
    /// with.
    pub(super) fn run_admitted(&self, unit_id: &UnitId) -> RunLiveness {
        let run_liveness = RunLiveness::default();
        self.status_publisher
            .publish_starting(unit_id, &run_liveness);
        run_liveness
    }

    /// What the run of `unit_id` is handed: `shutdown_token` to stop by, and
    /// `run_liveness` to report through.
    pub(super) fn context_for_run(
        &self,
        unit_id: UnitId,
        shutdown_token: CancellationToken,
        run_liveness: RunLiveness,
    ) -> RunContext<D> {
        RunContext::new(
            unit_id,
            shutdown_token,
            self.status_publisher.clone(),
            run_liveness,
        )
    }

    /// The run of `unit_id` with `generation` has ended for `reason`, with
    /// `error` when it failed, and its runtime is gone. Records the end, then
    /// publishes `Stopped`, so whatever the app does on seeing `Stopped`, a
    /// `set_unit_policy` included, acts on a run that has ended.
    pub(super) fn run_finished(
        self: &Arc<Self>,
        unit_id: &UnitId,
        generation: RunGeneration,
        run_liveness: &RunLiveness,
        reason: StopReason,
        error: Option<String>,
    ) {
        self.record_run_end(unit_id, generation, reason);
        self.status_publisher
            .publish_stopped(unit_id, run_liveness, reason, error);
    }

    /// The run of `unit_id` with `generation` was stopped for `reason` while
    /// it waited at its gate, and never started. Records the end; there is
    /// nothing to publish.
    pub(super) fn run_finished_before_starting(
        self: &Arc<Self>,
        unit_id: &UnitId,
        generation: RunGeneration,
        reason: StopReason,
    ) {
        self.record_run_end(unit_id, generation, reason);
    }

    /// The run of `unit_id` with `generation` ended for `reason`. Restarts it
    /// after the restart delay when it ended on its own while its unit should
    /// still run.
    fn record_run_end(
        self: &Arc<Self>,
        unit_id: &UnitId,
        generation: RunGeneration,
        reason: StopReason,
    ) {
        let mut state = self.lock_state();
        let now = self.clock.now();
        let app_present_or_in_grace = state.app_presence.present_or_in_grace(now);
        let runs_discouraged_by_platform = state.session_ledger.runs_discouraged_by_platform();
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        if entry.current_run.as_ref().map(|run| run.generation) != Some(generation) {
            return;
        }
        entry.current_run = None;
        let should_run =
            entry.should_run(now, app_present_or_in_grace, runs_discouraged_by_platform);
        if restarts_after(reason, should_run) {
            let (pending_restart, restart_token) = PendingRestart::new();
            entry.pending_restart = Some(pending_restart);
            let restart_delay = self.timings.restart_delay;
            log::info!("[unit-runner] {unit_id} restarts in {restart_delay:?}");
            let unit_runner = Arc::clone(self);
            let unit_id = unit_id.clone();
            self.runtime.spawn(async move {
                tokio::select! {
                    () = tokio::time::sleep(restart_delay) => {
                        unit_runner.finish_restart_delay(&unit_id, &restart_token);
                    }
                    () = restart_token.cancelled() => {}
                }
            });
        }
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// The restart of `unit_id` whose timer waits with `restart_token` has
    /// waited out its delay. A restart dropped since (cancelled, replaced, or
    /// its unit removed) does nothing.
    fn finish_restart_delay(self: &Arc<Self>, unit_id: &UnitId, restart_token: &CancellationToken) {
        let mut state = self.lock_state();
        // A pending restart cancels its token as it is dropped, which happens
        // only under this lock. So a token still live here is the unit's
        // pending restart.
        if restart_token.is_cancelled() {
            return;
        }
        let Some(entry) = state.units.get_mut(unit_id) else {
            return;
        };
        entry.pending_restart = None;
        self.start_and_stop_runs_per_policy_locked(&mut state);
    }

    /// Start every unit that should run and isn't running, stop every running
    /// unit that shouldn't be, publish the background session's demand (some
    /// unit should run, one waiting out its restart delay included), and move
    /// the wall-clock ticker's next deadline. Returns whether some unit
    /// should run.
    fn start_and_stop_runs_per_policy_locked(
        self: &Arc<Self>,
        state: &mut UnitRunnerState<D>,
    ) -> bool {
        let now = self.clock.now();
        let app_present_or_in_grace = state.app_presence.present_or_in_grace(now);
        let runs_discouraged_by_platform = state.session_ledger.runs_discouraged_by_platform();
        let mut starts = Vec::new();
        let mut some_unit_should_run = false;
        for (unit_id, entry) in &mut state.units {
            let should_run =
                entry.should_run(now, app_present_or_in_grace, runs_discouraged_by_platform);
            some_unit_should_run |= should_run;
            match plan_unit(should_run, entry.phase()) {
                UnitAction::Start => starts.push(unit_id.clone()),
                // A unit being removed, or stopped by the platform ending the
                // session, already has its run stopped with that reason. What's
                // left is a policy that no longer wants the unit running.
                UnitAction::Stop => entry.stop_run(StopReason::PolicyInactive),
                UnitAction::CancelRestart => entry.pending_restart = None,
                UnitAction::Keep => {}
            }
        }
        for unit_id in starts {
            self.start_run(state, unit_id);
        }

        self.publish_session_demand(state, some_unit_should_run);
        let next_start_and_stop_runs_at = state
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
        if next_start_and_stop_runs_at != state.next_start_and_stop_runs_at {
            state.next_start_and_stop_runs_at = next_start_and_stop_runs_at;
            self.next_start_and_stop_runs_moved.notify_one();
        }
        some_unit_should_run
    }

    fn publish_session_demand(&self, state: &UnitRunnerState<D>, some_unit_should_run: bool) {
        let demand = SessionDemand {
            some_unit_should_run,
            session_running_and_not_ending: state.session_ledger.session_running_and_not_ending(),
        };
        self.session_demand_tx.send_if_modified(|current| {
            let changed = *current != demand;
            *current = demand;
            changed
        });
    }

    fn start_run(self: &Arc<Self>, state: &mut UnitRunnerState<D>, unit_id: UnitId) {
        let generation = state.issue_generation();
        let Some(entry) = state.units.get_mut(&unit_id) else {
            return;
        };
        let stop_signal = RunStopSignal::default();
        let (run_finished_tx, run_finished_rx) = watch::channel(false);
        entry.current_run = Some(UnitRun {
            generation,
            stop_signal: stop_signal.clone(),
            run_finished_rx,
        });
        log::info!("[unit-runner] starting {unit_id}");
        let args = SuperviseRunArgs {
            unit_id,
            generation,
            factory: Arc::clone(&entry.factory),
            gate: entry.gate.clone(),
            stop_signal,
            shutdown_timeout: self.timings.run_runtime_shutdown_timeout,
            run_finished_tx,
        };
        self.runtime.spawn(supervise_run(Arc::clone(self), args));
    }
}
