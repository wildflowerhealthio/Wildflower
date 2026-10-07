//! The background session: started while any unit should run, ended when
//! none should, and what happens to every unit when the platform ends it.

use std::sync::Arc;
use std::time::Duration;

use super::fakes::{eventually, FakeBackgroundSession, Harness, Probe, Script};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::status::{PlatformStopReason, StopReason};

/// A harness whose background session the fake platform runs.
fn harness_with_background_session() -> (Harness, Arc<FakeBackgroundSession>) {
    harness_with_background_session_and_restart_delay(Duration::from_millis(100))
}

fn harness_with_background_session_and_restart_delay(
    restart_delay: Duration,
) -> (Harness, Arc<FakeBackgroundSession>) {
    let harness = Harness::with_restart_delay(restart_delay);
    let session = FakeBackgroundSession::new(&harness.unit_runner);
    harness
        .unit_runner
        .start_driving_background_session(Arc::clone(&session));
    (harness, session)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_runs_exactly_while_some_unit_should_run() {
    let (harness, session) = harness_with_background_session();
    for unit_id in ["first", "second"] {
        harness.set_unit(
            unit_id,
            RunPolicy::Off,
            Script::RunUntilStopped { detail: None },
            &Probe::default(),
        );
    }
    // The driver starts a session only once some unit should run.
    assert!(
        !harness.session_demand().some_unit_should_run,
        "no unit should run"
    );
    assert_eq!(session.session_start_requests(), 0);

    harness.set_unit_policy("first", RunPolicy::Always);
    harness.set_unit_policy("second", RunPolicy::Always);
    eventually("a session runs", || session.session_running()).await;
    assert_eq!(
        session.session_start_requests(),
        1,
        "one session for every unit"
    );

    harness.set_unit_policy("first", RunPolicy::Off);
    // The driver ends the session only once no unit should run.
    assert!(
        harness.session_demand().some_unit_should_run,
        "the second unit still should run"
    );
    assert!(session.session_running());

    harness.set_unit_policy("second", RunPolicy::Off);
    eventually("the session ends", || !session.session_running()).await;
    assert_eq!(session.session_end_requests(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_waiting_to_restart_still_wants_a_session() {
    let (harness, session) =
        harness_with_background_session_and_restart_delay(Duration::from_secs(3600));
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &Probe::default(),
    );
    harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    // `UnitRunner` recorded the end, and published its demand, before the
    // status said `Stopped`.
    assert_eq!(harness.phase("unit"), Some(UnitPhase::AwaitingRestart));
    assert!(harness.session_demand().some_unit_should_run);
    eventually("a session runs", || session.session_running()).await;
    assert_eq!(session.session_end_requests(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_platform_ending_the_session_stops_every_unit_without_restart() {
    let (harness, session) = harness_with_background_session();
    let probe = Probe::default();
    for unit_id in ["first", "second"] {
        harness.set_unit(
            unit_id,
            RunPolicy::Always,
            Script::RunUntilStopped { detail: None },
            &probe,
        );
    }
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
    eventually("a session runs", || session.session_running()).await;

    session.platform_ends_session(PlatformStopReason::PlatformExpiration);
    let expired = StopReason::SessionEndedByPlatform {
        platform_reason: PlatformStopReason::PlatformExpiration,
    };
    harness.wait_until_stopped_for("first", expired).await;
    harness.wait_until_stopped_for("second", expired).await;
    // Neither unit waits to restart, and no unit should run.
    assert_eq!(harness.phase("first"), Some(UnitPhase::Idle));
    assert_eq!(harness.phase("second"), Some(UnitPhase::Idle));
    assert!(!harness.session_demand().some_unit_should_run);
    assert_eq!(
        probe.starts(),
        2,
        "nothing restarts after the platform ends the session"
    );
    assert_eq!(
        session.session_start_requests(),
        1,
        "`UnitRunner` doesn't start one again"
    );

    // The platform starts a session again (an iOS background task).
    session.platform_starts_session();
    eventually("both units run again", || probe.starts() == 4).await;
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_becoming_present_starts_a_session_again() {
    let (harness, session) = harness_with_background_session();
    let probe = Probe::default();
    harness.unit_runner.set_app_present(true);
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    eventually("a session runs", || session.session_running()).await;

    harness.unit_runner.set_app_present(false);
    session.platform_ends_session(PlatformStopReason::NativeNotificationStop);
    harness
        .wait_until_stopped_for(
            "unit",
            StopReason::SessionEndedByPlatform {
                platform_reason: PlatformStopReason::NativeNotificationStop,
            },
        )
        .await;

    harness.unit_runner.set_app_present(true);
    eventually("a session starts again", || {
        session.session_start_requests() == 2
    })
    .await;
    harness.wait_until_running("unit").await;
    assert_eq!(probe.starts(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_platform_starts_with_nothing_to_run_is_ended() {
    let (harness, session) = harness_with_background_session();
    harness.set_unit(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    session.platform_starts_session();
    eventually("the session ends", || session.session_end_requests() == 1).await;
    assert!(!session.session_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_runner_s_own_end_of_the_session_stops_no_unit() {
    let (harness, session) = harness_with_background_session();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    // Stopped only once its run is up: a run stopped before it passes its
    // gate never starts, and leaves no stop of its own.
    harness.wait_until_running("unit").await;
    eventually("a session runs", || session.session_running()).await;
    harness.set_unit_policy("unit", RunPolicy::Off);
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
    eventually("the session ends", || !session.session_running()).await;

    harness.set_unit_policy("unit", RunPolicy::Always);
    eventually("the unit and a session come back", || {
        probe.starts() == 2 && session.session_running()
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_that_should_run_while_the_session_ends_gets_a_new_session() {
    let (harness, session) = harness_with_background_session();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    eventually("a session runs", || session.session_running()).await;

    session.hold_ends();
    harness.set_unit_policy("unit", RunPolicy::Off);
    eventually("the session is asked to end", || {
        session.session_end_requests() == 1
    })
    .await;

    // The unit should run again before the session finishes ending.
    harness.set_unit_policy("unit", RunPolicy::Always);
    eventually("the unit runs again", || probe.starts() == 2).await;
    assert!(session.session_running(), "the session is still ending");

    session.finish_ending_session();
    eventually("a new session runs", || session.session_running()).await;
    assert_eq!(session.session_start_requests(), 2, "one start per session");
}
