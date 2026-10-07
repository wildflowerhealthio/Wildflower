//! Policies on the wall clock: `Until`, `WhileOpen` and its grace.

use std::time::Duration;

use chrono::TimeDelta;

use super::fakes::{Harness, Probe, Script};
use crate::domain::app_presence::WHILE_OPEN_GRACE;
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::status::{StopReason, UnitStatus};

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_until_never_starts_and_stays_as_set() {
    let harness = Harness::new();
    let probe = Probe::default();
    let at = harness.now() - TimeDelta::seconds(1);
    harness.set_unit(
        "unit",
        RunPolicy::Until { at },
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    // `set_unit` reconciles before it returns: a start would show here.
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Idle));
    assert_eq!(probe.starts(), 0);
    assert_eq!(harness.status("unit"), Some(UnitStatus::never_run()));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_until_stops_its_unit_once_the_wall_clock_passes_it() {
    let harness = Harness::new();
    harness.set_unit(
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
    harness.unit_runner.reconcile();
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn while_open_runs_while_open_and_through_the_grace() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::WhileOpen,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    assert_eq!(
        harness.phase("unit"),
        Some(UnitPhase::Idle),
        "the app isn't open yet"
    );

    harness.unit_runner.set_app_open(true);
    harness.wait_until_running("unit").await;

    harness.unit_runner.set_app_open(false);
    harness
        .clock
        .advance(WHILE_OPEN_GRACE - Duration::from_secs(1));
    harness.unit_runner.reconcile();
    assert_eq!(
        harness.phase("unit"),
        Some(UnitPhase::Running),
        "still within the grace"
    );
    assert_eq!(probe.starts(), 1);

    harness.clock.advance(Duration::from_secs(1));
    harness.unit_runner.reconcile();
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_again_within_the_grace_keeps_the_same_run() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::WhileOpen,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.unit_runner.set_app_open(true);
    harness.wait_until_running("unit").await;
    harness.unit_runner.set_app_open(false);
    harness.clock.advance(Duration::from_secs(30));
    harness.unit_runner.set_app_open(true);
    harness.clock.advance(WHILE_OPEN_GRACE * 2);
    harness.unit_runner.reconcile();
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Running));
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wall_clock_reconcile_waits_for_the_next_deadline() {
    let harness = Harness::new();
    harness.set_unit(
        "unit",
        RunPolicy::Until {
            at: harness.now() + TimeDelta::seconds(3),
        },
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    assert_eq!(
        harness.unit_runner.time_until_next_reconcile(),
        Duration::from_secs(3)
    );
    harness.set_unit_policy(
        "unit",
        RunPolicy::Until {
            at: harness.now() + TimeDelta::hours(3),
        },
    );
    assert_eq!(
        harness.unit_runner.time_until_next_reconcile(),
        Duration::from_secs(10),
        "never longer than the wall-clock interval"
    );
}
