//! What starting and stopping runs per policy does to one unit, whether a run
//! that stopped restarts, and how long its restart waits.

use std::time::Duration;

use crate::status::StopReason;

/// Where a unit is, as starting and stopping runs per policy sees it.
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

/// What starting and stopping runs per policy does to one unit.
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

/// What starting and stopping runs per policy does to a unit in `phase` that
/// should or shouldn't run.
///
/// A stopping run is left to end: the `start_and_stop_runs_per_policy` its end
/// triggers starts the unit again if it should still run. A pending restart is
/// left to its delay.
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
/// restart starts again the next time runs start and stop per policy, with no
/// delay. Units stopped by
/// the platform's end of the background session wait for that to be cleared.
#[must_use]
pub fn restarts_after(reason: StopReason, should_run: bool) -> bool {
    should_run && reason == StopReason::EndedOnItsOwn
}

/// How long a restart waits when its unit has already restarted
/// `restarts_in_a_row` times in a row: `restart_delay`, doubled for each of
/// those restarts, and never longer than `max_restart_delay`.
#[must_use]
pub fn backed_off_restart_delay(
    restarts_in_a_row: u32,
    restart_delay: Duration,
    max_restart_delay: Duration,
) -> Duration {
    2_u32
        .checked_pow(restarts_in_a_row)
        .and_then(|factor| restart_delay.checked_mul(factor))
        .map_or(max_restart_delay, |delay| delay.min(max_restart_delay))
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

    #[test]
    fn the_restart_delay_doubles_with_each_restart_in_a_row_up_to_the_cap() {
        let delays: Vec<u64> = (0..9)
            .map(|restarts_in_a_row| {
                backed_off_restart_delay(
                    restarts_in_a_row,
                    Duration::from_secs(5),
                    Duration::from_secs(5 * 60),
                )
                .as_secs()
            })
            .collect();
        assert_eq!(delays, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
    }

    #[test]
    fn the_restart_delay_stays_at_the_cap_however_many_restarts_in_a_row() {
        let max_restart_delay = Duration::from_secs(5 * 60);
        for restarts_in_a_row in [31, 32, 64, u32::MAX] {
            assert_eq!(
                backed_off_restart_delay(
                    restarts_in_a_row,
                    Duration::from_secs(5),
                    max_restart_delay
                ),
                max_restart_delay,
                "{restarts_in_a_row}"
            );
        }
    }

    fn phase() -> impl Strategy<Value = UnitPhase> {
        proptest::sample::select(PHASES.to_vec())
    }

    proptest! {
        /// Applying a planned action and planning again asks for nothing more:
        /// starting and stopping runs per policy is idempotent.
        #[test]
        fn planning_twice_does_nothing_the_second_time(should_run: bool, before in phase()) {
            let after = match plan_unit(should_run, before) {
                UnitAction::Start => UnitPhase::Running,
                UnitAction::Stop => UnitPhase::Stopping,
                UnitAction::CancelRestart => UnitPhase::Idle,
                UnitAction::Keep => before,
            };
            prop_assert_eq!(plan_unit(should_run, after), UnitAction::Keep);
        }

        /// One more restart in a row never waits less, and no restart waits
        /// longer than the cap.
        #[test]
        fn one_more_restart_in_a_row_never_waits_less(
            restarts_in_a_row in 0_u32..80,
            restart_delay_ms in 1_u64..10_000,
            max_restart_delay_ms in 1_u64..1_000_000,
        ) {
            let restart_delay = Duration::from_millis(restart_delay_ms);
            let max_restart_delay = Duration::from_millis(max_restart_delay_ms);
            let delay =
                backed_off_restart_delay(restarts_in_a_row, restart_delay, max_restart_delay);
            let next_delay =
                backed_off_restart_delay(restarts_in_a_row + 1, restart_delay, max_restart_delay);
            prop_assert!(delay <= next_delay);
            prop_assert!(next_delay <= max_restart_delay);
        }
    }
}
