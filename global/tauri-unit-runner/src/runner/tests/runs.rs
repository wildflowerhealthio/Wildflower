//! Runs: isolation, concurrency, the run gate, panics, details and removal.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Barrier;

use super::fakes::{eventually, last_stop, Harness, Probe, RunEvent, Script, A_WHILE};
use crate::domain::run_policy::RunPolicy;
use crate::status::{RunState, StopReason, UnitStatus};
use crate::unit::UnitId;

#[tokio::test(flavor = "multi_thread")]
async fn every_unit_runs_at_once_with_no_cap() {
    const UNITS: usize = 12;
    let harness = Harness::new();
    let probe = Probe::default();
    // Each unit reports running only once every unit has begun its run.
    let barrier = Arc::new(Barrier::new(UNITS));
    for index in 0..UNITS {
        harness.set(
            &format!("unit-{index}"),
            RunPolicy::Always,
            Script::MeetOthers {
                barrier: Arc::clone(&barrier),
            },
            &probe,
        );
    }
    for index in 0..UNITS {
        harness.wait_until_running(&format!("unit-{index}")).await;
    }
    assert_eq!(probe.most_in_progress(), UNITS);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_s_next_run_waits_for_its_previous_run_to_end() {
    let harness = Harness::new();
    let slow = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::WindDownSlowly {
            shutdown_takes: Duration::from_millis(300),
        },
        &slow,
    );
    harness.wait_until_running("unit").await;

    // Setting the unit again stops its run and starts the new definition,
    // which waits at the gate while the old run winds down.
    let replacement = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &replacement,
    );
    eventually("the replacement runs", || replacement.starts() == 1).await;
    assert_eq!(
        slow.events(),
        vec![
            RunEvent::Began(UnitId::from("unit")),
            RunEvent::Ended(UnitId::from("unit")),
        ],
        "the old run ended before the replacement began"
    );
    harness.wait_until_running("unit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn units_never_wait_for_each_other() {
    let harness = Harness::new();
    let slow = Probe::default();
    harness.set(
        "slow",
        RunPolicy::Always,
        Script::WindDownSlowly {
            shutdown_takes: Duration::from_millis(500),
        },
        &slow,
    );
    harness.wait_until_running("slow").await;
    harness
        .core
        .set_policy(&UnitId::from("slow"), RunPolicy::Off);

    let quick = Probe::default();
    harness.set(
        "quick",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &quick,
    );
    harness.wait_until_running("quick").await;
    assert!(
        harness
            .status("slow")
            .is_some_and(|status| status.run_state == RunState::Running),
        "the other unit started while the slow one was still winding down"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_panic_is_the_run_s_error() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Panic { message: "boom" },
        &Probe::default(),
    );
    let stop = harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    assert_eq!(stop.error.as_deref(), Some("the unit panicked: boom"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_factory_is_a_failed_run() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    harness.core.set(
        UnitId::from("unit"),
        RunPolicy::Always,
        crate::runner::erase_factory(|| -> anyhow::Result<super::fakes::ScriptedUnit> {
            Err(anyhow::anyhow!("no configuration"))
        }),
    );
    let stop = harness
        .wait_until_stopped_for("unit", StopReason::EndedOnItsOwn)
        .await;
    assert_eq!(
        stop.error.as_deref(),
        Some("the unit's factory failed: no configuration")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_error_is_reported_as_its_full_chain_and_the_detail_is_cleared() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::Fail {
            detail: Some("half way".to_owned()),
            error: "disk full",
        },
        &Probe::default(),
    );
    let status = harness
        .wait_for("unit", "stopped", |status| last_stop(status).is_some())
        .await;
    let stop = last_stop(&status).expect("stopped");
    assert_eq!(stop.reason, StopReason::EndedOnItsOwn);
    assert_eq!(
        stop.error.as_deref(),
        Some("the scripted unit failed: disk full")
    );
    assert_eq!(status.detail, None);
    assert_eq!(status.running_since, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_unit_reports_its_detail_until_its_run_ends() {
    let harness = Harness::new();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped {
            detail: Some("connected".to_owned()),
        },
        &Probe::default(),
    );
    let status = harness
        .wait_for("unit", "connected", |status| {
            status.detail.as_deref() == Some("connected")
        })
        .await;
    assert_eq!(status.run_state, RunState::Running);
    assert_eq!(status.running_since, Some(harness.now()));

    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Off);
    let status = harness
        .wait_for("unit", "stopped", |status| last_stop(status).is_some())
        .await;
    assert_eq!(
        last_stop(&status).map(|stop| (stop.reason, stop.error.clone())),
        Some((StopReason::StoppedByRunner, None))
    );
    assert_eq!(status.detail, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_context_used_after_its_run_ended_changes_nothing() {
    let harness = Harness::new();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::LeakContext {
            delay: Duration::from_millis(200),
        },
        &Probe::default(),
    );
    harness.wait_until_running("unit").await;
    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Off);
    let stopped = harness
        .wait_for("unit", "stopped", |status| last_stop(status).is_some())
        .await;
    tokio::time::sleep(A_WHILE + Duration::from_millis(200)).await;
    assert_eq!(harness.status("unit"), Some(stopped));
}

#[tokio::test(flavor = "multi_thread")]
async fn remove_waits_for_the_run_to_end_and_forgets_the_unit() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::WindDownSlowly {
            shutdown_takes: Duration::from_millis(300),
        },
        &probe,
    );
    harness.wait_until_running("unit").await;
    tokio::time::timeout(
        Duration::from_secs(10),
        harness.core.remove(&UnitId::from("unit")),
    )
    .await
    .expect("remove finishes");
    assert_eq!(
        probe.events().last(),
        Some(&RunEvent::Ended(UnitId::from("unit")))
    );
    assert_eq!(harness.status("unit"), None);
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 1, "a removed unit doesn't start again");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_set_again_while_being_removed_stays() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::WindDownSlowly {
            shutdown_takes: Duration::from_millis(300),
        },
        &probe,
    );
    harness.wait_until_running("unit").await;
    let removing = {
        let core = Arc::clone(&harness.core);
        tokio::spawn(async move { core.remove(&UnitId::from("unit")).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    removing.await.expect("remove finishes");
    eventually("the unit runs again", || probe.starts() == 2).await;
    harness.wait_until_running("unit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_unit_has_never_run() {
    let harness = Harness::new();
    harness.set(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    assert_eq!(harness.status("unit"), Some(UnitStatus::never_run()));
}
