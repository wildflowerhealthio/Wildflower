//! Stops: `subscribe_stops` reports each run's stop once, including the ones a
//! reader of the statuses can't tell apart.

use std::time::Duration;

use tokio::sync::broadcast;

use super::fakes::{Harness, Probe, Script, HANG_TIMEOUT};
use crate::domain::run_policy::RunPolicy;
use crate::status::{RunStopped, StopReason};
use crate::unit::UnitId;

/// The next stop on `stops`, failing the test after [`HANG_TIMEOUT`].
async fn next_stop(stops: &mut broadcast::Receiver<RunStopped>) -> RunStopped {
    tokio::time::timeout(HANG_TIMEOUT, stops.recv())
        .await
        .expect("a stop arrives")
        .expect("the stop isn't missed")
}

#[tokio::test(flavor = "multi_thread")]
async fn every_retry_s_failure_is_reported_even_when_its_status_repeats() {
    let harness = Harness::with_restart_delay(Duration::from_millis(20));
    let mut stops = harness.unit_runner.subscribe_stops();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &Probe::default(),
    );
    // The test clock stands still, so every failure's `RunStop` is the same,
    // and a reader comparing statuses would see one stop.
    let first = next_stop(&mut stops).await;
    for _ in 0..2 {
        assert_eq!(next_stop(&mut stops).await, first);
    }
    assert_eq!(first.unit_id, UnitId::from("unit"));
    assert_eq!(first.stop.reason, StopReason::EndedOnItsOwn);
    assert_eq!(
        first.stop.error.as_deref(),
        Some("the scripted unit failed: lost the connection")
    );
    assert!(first.announced_running);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_never_came_up_is_reported_as_not_having_announced_running() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    let mut stops = harness.unit_runner.subscribe_stops();
    harness.unit_runner.set_unit(
        UnitId::from("unit"),
        RunPolicy::Always,
        || -> anyhow::Result<super::fakes::ScriptedUnit> {
            Err(anyhow::anyhow!("no configuration"))
        },
    );
    let stopped = next_stop(&mut stops).await;
    assert_eq!(stopped.stop.reason, StopReason::EndedOnItsOwn);
    assert!(!stopped.announced_running);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_unit_s_last_stop_is_reported() {
    let harness = Harness::new();
    let mut stops = harness.unit_runner.subscribe_stops();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    harness.wait_until_running("unit").await;
    harness.unit_runner.remove_unit(&UnitId::from("unit")).await;
    let stopped = next_stop(&mut stops).await;
    assert_eq!(stopped.stop.reason, StopReason::Removed);
    assert!(stopped.announced_running);
    assert_eq!(harness.status("unit"), None);
}
