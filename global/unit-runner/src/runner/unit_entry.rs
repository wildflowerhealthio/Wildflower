//! [`UnitEntry`], `UnitRunner`'s record of one unit: its policy, its factory,
//! its run gate, its current run, its pending restart and how many times in a
//! row it has restarted.

use chrono::{DateTime, Utc};
use tokio::sync::watch;
use tokio_util::sync::{CancellationToken, DropGuard};

use super::erased_unit::UnitFactory;
use super::run_stop_signal::RunStopSignal;
use super::unit_run_gate::UnitRunGate;
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::status::StopReason;

/// `UnitRunner`'s record of one unit.
pub(crate) struct UnitEntry<D> {
    pub(crate) policy: RunPolicy,
    pub(crate) factory: UnitFactory<D>,
    /// Shared by every run of the unit, the next one included after a
    /// `set_unit`, or a `remove_unit` that the app undoes with a `set_unit`.
    pub(crate) gate: UnitRunGate,
    /// The latest run, until it has ended.
    pub(crate) current_run: Option<UnitRun>,
    pub(crate) pending_restart: Option<PendingRestart>,
    /// How many times in a row the unit has restarted after a run that ended
    /// on its own; each restart waits twice as long as the one before. Back
    /// to zero after a run that stayed running for
    /// [`STABLE_RUN_DURATION`](crate::STABLE_RUN_DURATION), while the unit
    /// shouldn't run, and when its restarts start over
    /// ([`start_restarts_over`](Self::start_restarts_over)).
    pub(crate) restarts_in_a_row: u32,
    /// `remove_unit` is waiting for the unit's run to end before forgetting
    /// it.
    pub(crate) awaiting_removal: bool,
}

impl<D> UnitEntry<D> {
    pub(crate) fn new(policy: RunPolicy, factory: UnitFactory<D>) -> Self {
        Self {
            policy,
            factory,
            gate: UnitRunGate::default(),
            current_run: None,
            pending_restart: None,
            restarts_in_a_row: 0,
            awaiting_removal: false,
        }
    }

    /// Whether the unit should run at the wall-clock instant `now`, given
    /// whether the app is present or within its grace period and whether the
    /// platform's end of the background session discourages runs. A unit being
    /// removed never should, and no unit should while runs are discouraged.
    pub(crate) fn should_run(
        &self,
        now: DateTime<Utc>,
        app_present_or_in_grace: bool,
        runs_discouraged_by_platform: bool,
    ) -> bool {
        !self.awaiting_removal
            && !runs_discouraged_by_platform
            && self.policy.wants_running(now, app_present_or_in_grace)
    }

    /// Where the unit is, as starting and stopping runs per policy sees it.
    pub(crate) fn phase(&self) -> UnitPhase {
        match (&self.current_run, &self.pending_restart) {
            (Some(run), _) if run.stop_requested() => UnitPhase::Stopping,
            (Some(_), _) => UnitPhase::Running,
            (None, Some(_)) => UnitPhase::AwaitingRestart,
            (None, None) => UnitPhase::Idle,
        }
    }

    /// Start the unit's restarts over, on a fresh instruction for it: its
    /// pending restart is dropped, so it starts at once if it should run, and
    /// its next restart waits [`RESTART_DELAY`](crate::RESTART_DELAY).
    pub(crate) fn start_restarts_over(&mut self) {
        self.pending_restart = None;
        self.restarts_in_a_row = 0;
    }

    /// Ask the unit's run, if it has one, to stop for `reason`.
    pub(crate) fn stop_run(&self, reason: StopReason) {
        if let Some(run) = &self.current_run {
            run.request_stop(reason);
        }
    }
}

/// Numbers runs, so a late end of one tells it from a later run of the same
/// unit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct RunGeneration(u64);

impl RunGeneration {
    /// The generation after this one.
    #[must_use]
    pub(crate) fn next(self) -> Self {
        Self(self.0 + 1)
    }
}

/// One run of a unit that has begun and not yet ended.
pub(crate) struct UnitRun {
    /// Tells this run's end from a later run's.
    pub(crate) generation: RunGeneration,
    pub(crate) stop_signal: RunStopSignal,
    /// `true` once the run's thread and runtime are gone and `UnitRunner` has
    /// recorded its end.
    pub(crate) run_finished_rx: watch::Receiver<bool>,
}

impl UnitRun {
    /// Ask the run to stop for `reason`. A run that already has a stop reason
    /// keeps it.
    pub(crate) fn request_stop(&self, reason: StopReason) {
        self.stop_signal.request_stop(reason);
    }

    pub(crate) fn stop_requested(&self) -> bool {
        self.stop_signal.stop_reason().is_some()
    }
}

/// A restart waiting out the restart delay. Dropping it (when it is
/// cancelled, replaced, done, or its unit removed) cancels its timer.
pub(crate) struct PendingRestart {
    /// Cancels the timer's token when this restart is dropped.
    _cancel_timer_when_dropped: DropGuard,
}

impl PendingRestart {
    /// A pending restart, and the token its timer waits with.
    pub(crate) fn new() -> (Self, CancellationToken) {
        let restart_token = CancellationToken::new();
        let pending_restart = Self {
            _cancel_timer_when_dropped: restart_token.clone().drop_guard(),
        };
        (pending_restart, restart_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_or_dropping_a_pending_restart_cancels_its_timer() {
        let (first, first_token) = PendingRestart::new();
        let mut pending_restart = Some(first);
        assert!(!first_token.is_cancelled());

        let (second, second_token) = PendingRestart::new();
        drop(pending_restart.replace(second));
        assert!(first_token.is_cancelled(), "the replaced restart's timer");
        assert!(!second_token.is_cancelled());

        drop(pending_restart.take());
        assert!(second_token.is_cancelled(), "the dropped restart's timer");
    }
}
