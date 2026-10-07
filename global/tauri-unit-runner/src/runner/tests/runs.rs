//! Runs: isolation, concurrency, the run gate, panics, details and removal.

use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use tokio::sync::{Barrier, Semaphore};

use super::fakes::{
    eventually, last_stop, Harness, LeakedContextSignals, Probe, RunEvent, Script, HANG_TIMEOUT,
};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
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
        harness.set_unit(
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
    // One probe for both definitions, so its events show the runs' order.
    let probe = Probe::default();
    let release = Arc::new(Semaphore::new(0));
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::WindDownWhenReleased {
            release: Arc::clone(&release),
        },
        &probe,
    );
    harness.wait_until_running("unit").await;

    // Setting the unit again stops its run and starts the new definition,
    // which waits at the gate while the old run winds down.
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    assert_eq!(
        harness.status("unit").map(|status| status.run_state),
        Some(RunState::Running),
        "the old run's state stands until it has stopped"
    );

    release.add_permits(1);
    eventually("the replacement runs", || probe.starts() == 2).await;
    assert_eq!(
        probe.events(),
        vec![
            RunEvent::Began(UnitId::from("unit")),
            RunEvent::Ended(UnitId::from("unit")),
            RunEvent::Began(UnitId::from("unit")),
        ],
        "the old run ended before the replacement began"
    );
    harness.wait_until_running("unit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn setting_a_unit_again_stops_its_run_as_replaced() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    // The new definition shouldn't run, so the old run's stop stays on show.
    harness.set_unit(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness
        .wait_until_stopped_for("unit", StopReason::Replaced)
        .await;
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Idle));
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn units_never_wait_for_each_other() {
    let harness = Harness::new();
    let slow = Probe::default();
    let release = Arc::new(Semaphore::new(0));
    harness.set_unit(
        "slow",
        RunPolicy::Always,
        Script::WindDownWhenReleased {
            release: Arc::clone(&release),
        },
        &slow,
    );
    harness.wait_until_running("slow").await;
    harness.set_unit_policy("slow", RunPolicy::Off);

    let quick = Probe::default();
    harness.set_unit(
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
    release.add_permits(1);
    harness
        .wait_until_stopped_for("slow", StopReason::PolicyInactive)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_panic_is_the_run_s_error() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    harness.set_unit(
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
    harness.core.set_unit(
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
    harness.set_unit(
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
    harness.set_unit(
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

    harness.set_unit_policy("unit", RunPolicy::Off);
    let status = harness
        .wait_for("unit", "stopped", |status| last_stop(status).is_some())
        .await;
    assert_eq!(
        last_stop(&status).map(|stop| (stop.reason, stop.error.clone())),
        Some((StopReason::PolicyInactive, None))
    );
    assert_eq!(status.detail, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_context_used_after_its_run_ended_changes_nothing() {
    let harness = Harness::new();
    let leaked = Arc::new(LeakedContextSignals::default());
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::LeakContext {
            leaked: Arc::clone(&leaked),
        },
        &Probe::default(),
    );
    harness.wait_until_running("unit").await;
    harness.set_unit_policy("unit", RunPolicy::Off);
    let stopped = harness
        .wait_for("unit", "stopped", |status| last_stop(status).is_some())
        .await;
    leaked.write_now.store(true, Ordering::SeqCst);
    eventually("the leaked context is written to", || {
        leaked.written.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(harness.status("unit"), Some(stopped));
}

#[tokio::test(flavor = "multi_thread")]
async fn remove_unit_waits_for_the_run_to_end_and_forgets_the_unit() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::WindDownSlowly {
            shutdown_takes: Duration::from_millis(300),
        },
        &probe,
    );
    harness.wait_until_running("unit").await;
    tokio::time::timeout(
        HANG_TIMEOUT,
        harness.core.remove_unit(&UnitId::from("unit")),
    )
    .await
    .expect("remove_unit finishes");
    assert_eq!(
        probe.events().last(),
        Some(&RunEvent::Ended(UnitId::from("unit")))
    );
    assert_eq!(harness.status("unit"), None);
    // The runner no longer holds the unit, so nothing can start it again.
    assert_eq!(harness.phase("unit"), None);
    assert_eq!(probe.starts(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_set_again_while_being_removed_stays() {
    let harness = Harness::new();
    let probe = Probe::default();
    let release = Arc::new(Semaphore::new(0));
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::WindDownWhenReleased {
            release: Arc::clone(&release),
        },
        &probe,
    );
    harness.wait_until_running("unit").await;
    let unit_id = UnitId::from("unit");
    let mut removing = Box::pin(harness.core.remove_unit(&unit_id));
    // The first poll marks the unit as being removed and stops its run; the
    // removal then waits for the run, which waits for `release`.
    let first_poll = std::future::poll_fn(|cx| Poll::Ready(removing.as_mut().poll(cx))).await;
    assert!(first_poll.is_pending(), "the removal waits for the run");
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    release.add_permits(1);
    tokio::time::timeout(HANG_TIMEOUT, removing)
        .await
        .expect("remove_unit finishes");
    eventually("the unit runs again", || probe.starts() == 2).await;
    harness.wait_until_running("unit").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_unit_has_never_run() {
    let harness = Harness::new();
    harness.set_unit(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    assert_eq!(harness.status("unit"), Some(UnitStatus::never_run()));
}

/// On a current-thread runtime the run spawned by `set_unit` can't pass its
/// gate before the test yields, so the stop lands on a run that hasn't
/// started.
#[tokio::test]
async fn a_run_stopped_before_it_starts_publishes_nothing() {
    let harness = Harness::new();
    let probe = Probe::default();
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.set_unit_policy("unit", RunPolicy::Off);
    assert_eq!(harness.phase("unit"), Some(UnitPhase::Stopping));
    // The run passes its gate, sees it was stopped, and ends without
    // starting.
    eventually("the stopped run has ended", || {
        harness.phase("unit") == Some(UnitPhase::Idle)
    })
    .await;
    assert_eq!(probe.starts(), 0, "the stopped run never started");
    assert_eq!(harness.status("unit"), Some(UnitStatus::never_run()));

    // The runner's record of the unit is whole: it starts when set to.
    harness.set_unit_policy("unit", RunPolicy::Always);
    harness.wait_until_running("unit").await;
    assert_eq!(probe.starts(), 1);
}
