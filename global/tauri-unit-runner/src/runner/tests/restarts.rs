//! Restarts: a run that ends on its own restarts after the delay; the runner's
//! own stops don't; `set_policy` cuts a pending restart short.

use std::time::Duration;

use super::fakes::{eventually, last_stop, Harness, Probe, Script, A_WHILE};
use crate::domain::run_policy::RunPolicy;
use crate::status::{RunState, StopReason};
use crate::unit::UnitId;

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_run_restarts_after_the_delay() {
    let harness = Harness::with_restart_delay(Duration::from_millis(200));
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &probe,
    );
    harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    eventually("the unit restarts", || probe.starts() >= 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_returns_unasked_restarts_too() {
    let harness = Harness::with_restart_delay(Duration::from_millis(100));
    let probe = Probe::default();
    harness.set("unit", RunPolicy::Always, Script::Return, &probe);
    eventually("the unit restarts", || probe.starts() >= 2).await;
    let stop = harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    assert_eq!(stop.error, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_waits_out_the_delay() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &probe,
    );
    harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn set_policy_cancels_a_pending_restart_and_starts_at_once() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &probe,
    );
    harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    // The unchanged policy still counts.
    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Always);
    eventually("the unit starts at once", || probe.starts() == 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pending_restart_is_dropped_when_the_unit_shouldn_t_run() {
    let harness = Harness::with_restart_delay(Duration::from_millis(200));
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &probe,
    );
    harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Off);
    tokio::time::sleep(A_WHILE + Duration::from_millis(200)).await;
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_the_runner_stopped_is_not_restarted() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Off);
    harness
        .wait_until_stopped_for("unit", StopReason::StoppedByRunner)
        .await;
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_of_running_units_stops_and_starts_each_one() {
    let harness = Harness::new();
    let first = Probe::default();
    let second = Probe::default();
    let idle = Probe::default();
    for (unit_id, policy, probe) in [
        ("first", RunPolicy::Always, &first),
        ("second", RunPolicy::Always, &second),
        ("idle", RunPolicy::Off, &idle),
    ] {
        harness.set(
            unit_id,
            policy,
            Script::RunUntilStopped { detail: None },
            probe,
        );
    }
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;

    harness.core.restart_running_units();
    eventually("both running units start again", || {
        first.starts() == 2 && second.starts() == 2
    })
    .await;
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
    assert_eq!(idle.starts(), 0, "a unit that wasn't running stays stopped");
    assert!(harness
        .status("idle")
        .is_some_and(|status| last_stop(&status).is_none()
            && matches!(status.run_state, RunState::Stopped { .. })));
}
