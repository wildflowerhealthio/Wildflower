//! Policies on the wall clock: `Until`, `WhileInUse` and its grace.

use std::time::Duration;

use chrono::TimeDelta;

use super::fakes::{Harness, Probe, Script, A_WHILE};
use crate::domain::app_use::WHILE_IN_USE_GRACE;
use crate::domain::run_policy::RunPolicy;
use crate::status::{StopReason, UnitStatus};

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_until_never_starts_and_stays_as_set() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Until {
            at: harness.now() - TimeDelta::seconds(1),
        },
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 0);
    assert_eq!(harness.status("unit"), Some(UnitStatus::never_run()));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_until_stops_its_unit_once_the_wall_clock_passes_it() {
    let harness = Harness::new();
    harness.set(
        "unit",
        RunPolicy::Until {
            at: harness.now() + TimeDelta::minutes(30),
        },
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    harness.wait_until_running("unit").await;

    // As after a laptop sleep: the wall clock jumps, `tokio::time` doesn't.
    harness.clock.advance(Duration::from_secs(31 * 60));
    harness.core.reconcile();
    harness
        .wait_until_stopped_for("unit", StopReason::StoppedByRunner)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn while_in_use_runs_while_in_use_and_through_the_grace() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::WhileInUse,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 0, "the app isn't in use yet");

    harness.core.set_in_use(true);
    harness.wait_until_running("unit").await;

    harness.core.set_in_use(false);
    harness
        .clock
        .advance(WHILE_IN_USE_GRACE - Duration::from_secs(1));
    harness.core.reconcile();
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 1);
    harness.wait_until_running("unit").await;

    harness.clock.advance(Duration::from_secs(1));
    harness.core.reconcile();
    harness
        .wait_until_stopped_for("unit", StopReason::StoppedByRunner)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn coming_back_within_the_grace_keeps_the_same_run() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::WhileInUse,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.core.set_in_use(true);
    harness.wait_until_running("unit").await;
    harness.core.set_in_use(false);
    harness.clock.advance(Duration::from_secs(30));
    harness.core.set_in_use(true);
    harness.clock.advance(WHILE_IN_USE_GRACE * 2);
    harness.core.reconcile();
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 1);
    harness.wait_until_running("unit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wall_clock_reconcile_waits_for_the_next_deadline() {
    let harness = Harness::new();
    harness.set(
        "unit",
        RunPolicy::Until {
            at: harness.now() + TimeDelta::seconds(3),
        },
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    assert_eq!(
        harness.core.time_until_next_reconcile(),
        Duration::from_secs(3)
    );
    harness.core.set_policy(
        &crate::unit::UnitId::from("unit"),
        RunPolicy::Until {
            at: harness.now() + TimeDelta::hours(3),
        },
    );
    assert_eq!(
        harness.core.time_until_next_reconcile(),
        Duration::from_secs(10),
        "never longer than the wall-clock interval"
    );
}
