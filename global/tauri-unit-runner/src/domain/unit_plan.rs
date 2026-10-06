//! What a reconcile does to one unit, and whether a run that stopped restarts.

use crate::status::StopReason;

/// Where a unit is, as a reconcile sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitActivity {
    /// No run is in progress and no restart is pending.
    Idle,
    /// A run is in progress and nothing has asked it to stop.
    Running,
    /// A run is in progress and has been asked to stop.
    Stopping,
    /// The latest run ended on its own and its restart is waiting out the
    /// restart delay.
    RestartPending,
}

/// What a reconcile does to one unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitAction {
    /// Start a run.
    Start,
    /// Ask the run to stop, as the runner.
    Stop,
    /// Drop the pending restart.
    CancelRestart,
    /// Leave the unit as it is.
    Keep,
}

/// What a reconcile does to a unit in `activity` that should or shouldn't run.
///
/// A stopping run is left to end: the reconcile its end triggers starts the
/// unit again if it should still run. A pending restart is left to its delay.
#[must_use]
pub fn plan_unit(should_run: bool, activity: UnitActivity) -> UnitAction {
    match (should_run, activity) {
        (true, UnitActivity::Idle) => UnitAction::Start,
        (false, UnitActivity::Running) => UnitAction::Stop,
        (false, UnitActivity::RestartPending) => UnitAction::CancelRestart,
        (true, UnitActivity::Running | UnitActivity::Stopping | UnitActivity::RestartPending)
        | (false, UnitActivity::Idle | UnitActivity::Stopping) => UnitAction::Keep,
    }
}

/// Whether a run that stopped for `reason` is restarted after the restart
/// delay, given whether its unit should still run. Only a run that ended on
/// its own is: the runner doesn't undo its own stops, and units stopped with
/// the lease wait for it to come back.
#[must_use]
pub fn restarts_after(reason: StopReason, should_run: bool) -> bool {
    should_run && reason == StopReason::EndedOnItsOwn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::PlatformStopReason;
    use proptest::prelude::*;

    const ACTIVITIES: [UnitActivity; 4] = [
        UnitActivity::Idle,
        UnitActivity::Running,
        UnitActivity::Stopping,
        UnitActivity::RestartPending,
    ];

    #[test]
    fn a_unit_that_should_run_starts_only_from_idle() {
        for activity in ACTIVITIES {
            let expected = if activity == UnitActivity::Idle {
                UnitAction::Start
            } else {
                UnitAction::Keep
            };
            assert_eq!(plan_unit(true, activity), expected, "{activity:?}");
        }
    }

    #[test]
    fn a_unit_that_shouldn_t_run_is_stopped_and_its_restart_dropped() {
        assert_eq!(plan_unit(false, UnitActivity::Idle), UnitAction::Keep);
        assert_eq!(plan_unit(false, UnitActivity::Running), UnitAction::Stop);
        assert_eq!(plan_unit(false, UnitActivity::Stopping), UnitAction::Keep);
        assert_eq!(
            plan_unit(false, UnitActivity::RestartPending),
            UnitAction::CancelRestart
        );
    }

    #[test]
    fn only_a_run_that_ended_on_its_own_restarts() {
        assert!(restarts_after(StopReason::EndedOnItsOwn, true));
        assert!(!restarts_after(StopReason::EndedOnItsOwn, false));
        assert!(!restarts_after(StopReason::StoppedByRunner, true));
        assert!(!restarts_after(
            StopReason::LeaseEnded {
                platform_reason: PlatformStopReason::PlatformExpiration
            },
            true
        ));
    }

    fn activity() -> impl Strategy<Value = UnitActivity> {
        proptest::sample::select(ACTIVITIES.to_vec())
    }

    proptest! {
        /// Applying a reconcile's action and reconciling again asks for nothing
        /// more: a reconcile is idempotent.
        #[test]
        fn reconciling_twice_does_nothing_the_second_time(should_run: bool, before in activity()) {
            let after = match plan_unit(should_run, before) {
                UnitAction::Start => UnitActivity::Running,
                UnitAction::Stop => UnitActivity::Stopping,
                UnitAction::CancelRestart => UnitActivity::Idle,
                UnitAction::Keep => before,
            };
            prop_assert_eq!(plan_unit(should_run, after), UnitAction::Keep);
        }
    }
}
