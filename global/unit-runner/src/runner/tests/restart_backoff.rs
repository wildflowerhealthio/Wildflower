//! Restart backoff, on the paused clock: each restart in a row waits twice as
//! long as the one before, up to the cap; a run that stays running long enough,
//! a fresh instruction, and a stretch where the unit shouldn't run start the
//! delay over; a removed unit's pending restart never fires.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;

use super::fakes::{eventually_on_the_paused_clock, Harness, Probe, Script};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::runner::{MAX_RESTART_DELAY, RESTART_DELAY, STABLE_RUN_DURATION};
use crate::status::{PlatformStopReason, RunState};
use crate::unit::UnitId;

/// The paused clock's smallest step that a timer tells apart.
const CLOCK_TICK: Duration = Duration::from_millis(1);

/// Advance the paused clock by `duration`, and let every task a timer woke
/// run. `tokio::time::advance` returns once the timers have fired, before the
/// tasks they woke have run; the yield after it runs every task that is ready.
async fn advance_paused_clock(duration: Duration) {
    tokio::time::advance(duration).await;
    tokio::task::yield_now().await;
}

/// The unit `"unit"`, whose runs each fail once the test
/// allows it, and report running first only while the test says so.
struct FailingUnit {
    announces_running: Arc<AtomicBool>,
    allow_failure: Arc<Semaphore>,
    probe: Probe,
}

impl FailingUnit {
    /// Set the unit on `harness` with `policy`, and wait until its first run
    /// begins.
    async fn set(harness: &Harness, policy: RunPolicy) -> Self {
        let failing_unit = Self {
            announces_running: Arc::new(AtomicBool::new(false)),
            allow_failure: Arc::new(Semaphore::new(0)),
            probe: Probe::default(),
        };
        harness.set_unit(
            "unit",
            policy,
            Script::FailWhenAllowed {
                announces_running: Arc::clone(&failing_unit.announces_running),
                allow_failure: Arc::clone(&failing_unit.allow_failure),
                error: "the configuration can't be built",
            },
            &failing_unit.probe,
        );
        eventually_on_the_paused_clock("the first run begins", || failing_unit.probe.starts() == 1)
            .await;
        failing_unit
    }

    /// Whether the runs from now on report running before they fail.
    fn set_announces_running(&self, announces_running: bool) {
        self.announces_running
            .store(announces_running, Ordering::SeqCst);
    }

    /// Wait until the run in progress has announced running.
    async fn wait_until_running(&self, harness: &Harness) {
        eventually_on_the_paused_clock("the run announces running", || {
            harness
                .status("unit")
                .is_some_and(|status| status.run_state == RunState::Running)
        })
        .await;
    }

    /// Let the run in progress fail, and wait until its restart is pending.
    async fn fail(&self, harness: &Harness) {
        self.allow_failure.add_permits(1);
        eventually_on_the_paused_clock("the run fails and its restart is pending", || {
            harness.phase("unit") == Some(UnitPhase::AwaitingRestart)
        })
        .await;
    }

    /// Check that the pending restart waits exactly `restart_delay`, and wait
    /// until the run it starts begins.
    async fn wait_out_restart(&self, harness: &Harness, restart_delay: Duration) {
        let starts_before = self.probe.starts();
        advance_paused_clock(restart_delay - CLOCK_TICK).await;
        assert_eq!(
            harness.phase("unit"),
            Some(UnitPhase::AwaitingRestart),
            "the restart waits {restart_delay:?}"
        );
        assert_eq!(self.probe.starts(), starts_before);
        advance_paused_clock(CLOCK_TICK).await;
        eventually_on_the_paused_clock("the restart begins a run", || {
            self.probe.starts() == starts_before + 1
        })
        .await;
    }

    /// Let the run in progress fail, and check that its restart waits exactly
    /// `restart_delay`.
    async fn fail_and_wait_out_restart(&self, harness: &Harness, restart_delay: Duration) {
        self.fail(harness).await;
        self.wait_out_restart(harness, restart_delay).await;
    }
}

#[tokio::test(start_paused = true)]
async fn each_restart_in_a_row_waits_twice_as_long_up_to_the_cap() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    for restart_delay_secs in [5, 10, 20, 40, 80, 160, 300, 300] {
        failing_unit
            .fail_and_wait_out_restart(&harness, Duration::from_secs(restart_delay_secs))
            .await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_run_that_stays_running_long_enough_starts_the_delay_over() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit.fail(&harness).await;
    failing_unit.set_announces_running(true);
    failing_unit
        .wait_out_restart(&harness, Duration::from_secs(10))
        .await;
    failing_unit.wait_until_running(&harness).await;
    harness.clock.advance(STABLE_RUN_DURATION);

    // This run stayed running for `STABLE_RUN_DURATION` before it failed, so
    // its restart waits the first delay, and the next failure in a row the
    // second.
    failing_unit.fail(&harness).await;
    failing_unit.set_announces_running(false);
    failing_unit
        .wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_run_that_fails_soon_after_announcing_running_keeps_backing_off() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit.set_announces_running(true);
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit.wait_until_running(&harness).await;
    harness
        .clock
        .advance(STABLE_RUN_DURATION - Duration::from_secs(1));
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;
    failing_unit.wait_until_running(&harness).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(20))
        .await;
}

#[tokio::test(start_paused = true)]
async fn set_unit_policy_after_failures_starts_at_once_and_starts_the_delay_over() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit.fail(&harness).await;

    harness.set_unit_policy("unit", RunPolicy::Always);
    eventually_on_the_paused_clock("the unit starts at once", || {
        failing_unit.probe.starts() == 3
    })
    .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_restart_of_running_units_starts_the_delay_over() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;

    // The third run is in progress, not yet up.
    harness.unit_runner.restart_running_units();
    eventually_on_the_paused_clock("the unit starts again at once", || {
        failing_unit.probe.starts() == 4
    })
    .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_restart_of_running_units_starts_a_unit_waiting_out_its_delay_at_once() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;
    failing_unit.fail(&harness).await;

    harness.unit_runner.restart_running_units();
    eventually_on_the_paused_clock("the unit starts at once", || {
        failing_unit.probe.starts() == 4
    })
    .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}

#[tokio::test(start_paused = true)]
async fn the_app_becoming_present_starts_a_unit_waiting_out_its_delay_at_once() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;
    failing_unit.fail(&harness).await;

    harness.unit_runner.set_app_present(true);
    eventually_on_the_paused_clock("the unit starts at once", || {
        failing_unit.probe.starts() == 4
    })
    .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}

#[tokio::test(start_paused = true)]
async fn failures_before_the_platform_ended_the_session_don_t_carry_over() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let session = harness.unit_runner.session_started();
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(10))
        .await;
    failing_unit.fail(&harness).await;

    harness
        .unit_runner
        .session_ended(session, Some(PlatformStopReason::PlatformExpiration));
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Idle));

    // The platform starts a session again: the unit starts at once, and its
    // next restart waits the first delay.
    harness.unit_runner.session_started();
    eventually_on_the_paused_clock("the unit starts again", || failing_unit.probe.starts() == 4)
        .await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}

#[tokio::test(start_paused = true)]
async fn a_removed_unit_s_pending_restart_never_fires() {
    let harness = Harness::with_restart_delay(RESTART_DELAY);
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
    failing_unit.fail(&harness).await;

    harness.unit_runner.remove_unit(&UnitId::from("unit")).await;
    assert_eq!(harness.phase("unit"), None);
    advance_paused_clock(MAX_RESTART_DELAY).await;
    assert_eq!(harness.phase("unit"), None);
    assert_eq!(harness.status("unit"), None);
    assert_eq!(failing_unit.probe.starts(), 2);

    // Set again, the unit starts over from the first delay.
    let failing_unit = FailingUnit::set(&harness, RunPolicy::Always).await;
    failing_unit
        .fail_and_wait_out_restart(&harness, Duration::from_secs(5))
        .await;
}
