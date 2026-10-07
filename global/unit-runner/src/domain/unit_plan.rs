//! What a reconcile does to one unit, and whether a run that stopped restarts.

use crate::status::StopReason;

/// Where a unit is, as a reconcile sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitPhase {
    /// No run is in progress and no restart is pending.
    Idle,
    /// A run is in progress and nothing has asked it to stop.
    Running,
    /// A run is in progress and has been asked to stop.
    Stopping,
    /// The latest run ended on its own and its restart is waiting out the
    /// restart delay.
    AwaitingRestart,
}

/// What a reconcile does to one unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitAction {
    /// Start a run.
    Start,
    /// Ask the run to stop, because the unit shouldn't run.
    Stop,
    /// Drop the pending restart.
    CancelRestart,
    /// Leave the unit as it is.
    Keep,
}

/// What a reconcile does to a unit in `phase` that should or shouldn't run.
///
/// A stopping run is left to end: the reconcile its end triggers starts the
/// unit again if it should still run. A pending restart is left to its delay.
#[must_use]
pub fn plan_unit(should_run: bool, phase: UnitPhase) -> UnitAction {
    match (should_run, phase) {
        (true, UnitPhase::Idle) => UnitAction::Start,
        (false, UnitPhase::Running) => UnitAction::Stop,
        (false, UnitPhase::AwaitingRestart) => UnitAction::CancelRestart,
        (true, UnitPhase::Running | UnitPhase::Stopping | UnitPhase::AwaitingRestart)
        | (false, UnitPhase::Idle | UnitPhase::Stopping) => UnitAction::Keep,
    }
}

/// Whether a run that stopped for `reason` is restarted after the restart
/// delay, given whether its unit should still run. Only a run that ended on
/// its own is. `UnitRunner` doesn't undo its own stops; a run it stopped to
/// restart starts again on the next reconcile, with no delay. Units stopped by
/// the platform's end of the background session wait for that to be cleared.
#[must_use]
pub fn restarts_after(reason: StopReason, should_run: bool) -> bool {
    should_run && reason == StopReason::EndedOnItsOwn
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::PlatformStopReason;
    use proptest::prelude::*;

    const PHASES: [UnitPhase; 4] = [
        UnitPhase::Idle,
        UnitPhase::Running,
        UnitPhase::Stopping,
        UnitPhase::AwaitingRestart,
    ];

    #[test]
    fn a_unit_that_should_run_starts_only_from_idle() {
        for phase in PHASES {
            let expected = if phase == UnitPhase::Idle {
                UnitAction::Start
            } else {
                UnitAction::Keep
            };
            assert_eq!(plan_unit(true, phase), expected, "{phase:?}");
        }
    }

    #[test]
    fn a_unit_that_shouldn_t_run_is_stopped_and_its_restart_dropped() {
        assert_eq!(plan_unit(false, UnitPhase::Idle), UnitAction::Keep);
        assert_eq!(plan_unit(false, UnitPhase::Running), UnitAction::Stop);
        assert_eq!(plan_unit(false, UnitPhase::Stopping), UnitAction::Keep);
        assert_eq!(
            plan_unit(false, UnitPhase::AwaitingRestart),
            UnitAction::CancelRestart
        );
    }

    #[test]
    fn only_a_run_that_ended_on_its_own_restarts_after_the_delay() {
        assert!(restarts_after(StopReason::EndedOnItsOwn, true));
        assert!(!restarts_after(StopReason::EndedOnItsOwn, false));
        for reason in [
            StopReason::PolicyInactive,
            StopReason::Replaced,
            StopReason::Removed,
            StopReason::StoppedForRestart,
            StopReason::SessionEndedByPlatform {
                platform_reason: PlatformStopReason::PlatformExpiration,
            },
        ] {
            assert!(!restarts_after(reason, true), "{reason:?}");
        }
    }

    fn phase() -> impl Strategy<Value = UnitPhase> {
        proptest::sample::select(PHASES.to_vec())
    }

    proptest! {
        /// Applying a reconcile's action and reconciling again asks for nothing
        /// more: a reconcile is idempotent.
        #[test]
        fn reconciling_twice_does_nothing_the_second_time(should_run: bool, before in phase()) {
            let after = match plan_unit(should_run, before) {
                UnitAction::Start => UnitPhase::Running,
                UnitAction::Stop => UnitPhase::Stopping,
                UnitAction::CancelRestart => UnitPhase::Idle,
                UnitAction::Keep => before,
            };
            prop_assert_eq!(plan_unit(should_run, after), UnitAction::Keep);
        }
    }
}
