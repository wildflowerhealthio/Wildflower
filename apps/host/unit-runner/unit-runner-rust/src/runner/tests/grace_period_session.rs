//! A background session that lasts only the grace period: wanted only while
//! the app is absent, and every policy capped at the grace period while it
//! is.

use std::sync::Arc;
use std::time::Duration;

use chrono::TimeDelta;

use super::fakes::{eventually, FakeBackgroundSession, Harness, Probe, Script};
use crate::domain::app_presence::WHILE_OPEN_GRACE;
use crate::domain::background_session_length::BackgroundSessionLength;
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::status::StopReason;

/// A harness for a platform whose session lasts only the grace period, with
/// the fake platform running its session.
fn grace_period_harness() -> (Harness, Arc<FakeBackgroundSession>) {
    let harness = Harness::with_background_session_length(BackgroundSessionLength::GracePeriod);
    let session = FakeBackgroundSession::new(&harness.unit_runner);
    harness
        .unit_runner
        .attach_background_session_platform(Arc::clone(&session));
    (harness, session)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_session_runs_only_through_the_grace_after_the_app_becomes_absent() {
    let (harness, session) = grace_period_harness();
    let probe = Probe::default();
    harness.unit_runner.set_app_present(true);
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    assert!(
        !harness.session_demand().session_wanted,
        "no session while the app is present"
    );

    harness.unit_runner.set_app_present(false);
    eventually("a session runs", || session.session_running()).await;
    harness
        .clock
        .advance(WHILE_OPEN_GRACE - Duration::from_secs(1));
    harness.unit_runner.start_and_stop_runs_per_policy();
    assert_eq!(
        harness.phase("unit"),
        Some(UnitPhase::Running),
        "still within the grace"
    );

    harness.clock.advance(Duration::from_secs(1));
    harness.unit_runner.start_and_stop_runs_per_policy();
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
    eventually("the session ends as no longer needed", || {
        !session.session_running() && session.session_end_requests() == 1
    })
    .await;

    harness.unit_runner.set_app_present(true);
    harness.wait_until_running("unit").await;
    assert_eq!(probe.starts(), 2);
    assert!(!harness.session_demand().session_wanted);
    assert_eq!(session.session_start_requests(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn returning_within_the_grace_ends_the_session_and_keeps_the_run() {
    let (harness, session) = grace_period_harness();
    let probe = Probe::default();
    harness.unit_runner.set_app_present(true);
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    harness.unit_runner.set_app_present(false);
    eventually("a session runs", || session.session_running()).await;

    harness.clock.advance(Duration::from_secs(30));
    harness.unit_runner.set_app_present(true);
    eventually("the session ends", || !session.session_running()).await;
    harness.clock.advance(WHILE_OPEN_GRACE * 2);
    harness.unit_runner.start_and_stop_runs_per_policy();
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Running));
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_until_still_ahead_stops_when_the_grace_ends() {
    let (harness, session) = grace_period_harness();
    harness.unit_runner.set_app_present(true);
    harness.set_unit(
        "unit",
        RunPolicy::Until {
            at: harness.now() + TimeDelta::hours(3),
        },
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    harness.wait_until_running("unit").await;

    harness.unit_runner.set_app_present(false);
    eventually("a session runs", || session.session_running()).await;
    harness.clock.advance(WHILE_OPEN_GRACE);
    harness.unit_runner.start_and_stop_runs_per_policy();
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
    eventually("the session ends", || !session.session_running()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_runs_before_the_app_is_first_present() {
    let (harness, session) = grace_period_harness();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Idle));
    assert!(!harness.session_demand().session_wanted);

    // A session the platform starts on its own has nothing to cover.
    session.platform_starts_session();
    eventually("the session ends", || session.session_end_requests() == 1).await;
    assert_eq!(probe.starts(), 0);
}
