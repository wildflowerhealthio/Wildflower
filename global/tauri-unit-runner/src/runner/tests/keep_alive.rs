//! The keep-alive: started while any unit should run, stopped when none
//! should, and what happens to every unit when the platform revokes it.

use std::sync::Arc;
use std::time::Duration;

use super::fakes::{eventually, FakeKeepAlive, Harness, Probe, Script};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::runner::keep_alive_sync::{sync_keep_alive, KeepAlivePlatform};
use crate::status::{PlatformStopReason, StopReason};

/// A harness whose keep-alive the fake platform runs.
fn harness_with_keep_alive() -> (Harness, Arc<FakeKeepAlive>) {
    harness_with_keep_alive_and_restart_delay(Duration::from_millis(100))
}

fn harness_with_keep_alive_and_restart_delay(
    restart_delay: Duration,
) -> (Harness, Arc<FakeKeepAlive>) {
    let harness = Harness::with_restart_delay(restart_delay);
    let keep_alive = FakeKeepAlive::new(&harness.core);
    tokio::spawn(sync_keep_alive(
        Arc::clone(&harness.core),
        Arc::clone(&keep_alive) as Arc<dyn KeepAlivePlatform>,
    ));
    (harness, keep_alive)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_keep_alive_runs_exactly_while_some_unit_should_run() {
    let (harness, keep_alive) = harness_with_keep_alive();
    for unit_id in ["first", "second"] {
        harness.set_unit(
            unit_id,
            RunPolicy::Off,
            Script::RunUntilStopped { detail: None },
            &Probe::default(),
        );
    }
    // The sync starts the keep-alive only when the demand wants it.
    assert!(!harness.keep_alive_demand().wanted, "no unit should run");
    assert_eq!(keep_alive.starts(), 0);

    harness.set_unit_policy("first", RunPolicy::Always);
    harness.set_unit_policy("second", RunPolicy::Always);
    eventually("the keep-alive runs", || keep_alive.task_running()).await;
    assert_eq!(keep_alive.starts(), 1, "one keep-alive for every unit");

    harness.set_unit_policy("first", RunPolicy::Off);
    // The sync stops the keep-alive only when the demand stops wanting it.
    assert!(
        harness.keep_alive_demand().wanted,
        "the second unit still should run"
    );
    assert!(keep_alive.task_running());

    harness.set_unit_policy("second", RunPolicy::Off);
    eventually("the keep-alive stops", || !keep_alive.task_running()).await;
    assert_eq!(keep_alive.stops(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_waiting_to_restart_keeps_the_keep_alive() {
    let (harness, keep_alive) =
        harness_with_keep_alive_and_restart_delay(Duration::from_secs(3600));
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
    // The runner recorded the end, and published its demand, before the
    // status said `Stopped`.
    assert_eq!(harness.phase("unit"), Some(UnitPhase::RestartPending));
    assert!(harness.keep_alive_demand().wanted);
    eventually("the keep-alive runs", || keep_alive.task_running()).await;
    assert_eq!(keep_alive.stops(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revocation_stops_every_unit_without_restart() {
    let (harness, keep_alive) = harness_with_keep_alive();
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
    eventually("the keep-alive runs", || keep_alive.task_running()).await;

    keep_alive.platform_revokes(PlatformStopReason::PlatformExpiration);
    let expired = StopReason::KeepAliveRevoked {
        platform_reason: PlatformStopReason::PlatformExpiration,
    };
    harness.wait_until_stopped_for("first", expired).await;
    harness.wait_until_stopped_for("second", expired).await;
    // Neither unit waits to restart, and nothing wants the keep-alive back.
    assert_eq!(harness.phase("first"), Some(UnitPhase::Idle));
    assert_eq!(harness.phase("second"), Some(UnitPhase::Idle));
    assert!(!harness.keep_alive_demand().wanted);
    assert_eq!(probe.starts(), 2, "nothing restarts after a revocation");
    assert_eq!(keep_alive.starts(), 1, "the runner doesn't start it again");

    // The platform starts the keep-alive again (an iOS background task).
    keep_alive.platform_starts();
    eventually("both units run again", || probe.starts() == 4).await;
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opening_the_app_starts_the_keep_alive_again() {
    let (harness, keep_alive) = harness_with_keep_alive();
    let probe = Probe::default();
    harness.core.set_app_open(true);
    harness.set_unit(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    eventually("the keep-alive runs", || keep_alive.task_running()).await;

    harness.core.set_app_open(false);
    keep_alive.platform_revokes(PlatformStopReason::NativeNotificationStop);
    harness
        .wait_until_stopped_for(
            "unit",
            StopReason::KeepAliveRevoked {
                platform_reason: PlatformStopReason::NativeNotificationStop,
            },
        )
        .await;

    harness.core.set_app_open(true);
    eventually("the keep-alive starts again", || keep_alive.starts() == 2).await;
    harness.wait_until_running("unit").await;
    assert_eq!(probe.starts(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_keep_alive_the_platform_starts_with_nothing_to_run_is_stopped() {
    let (harness, keep_alive) = harness_with_keep_alive();
    harness.set_unit(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    keep_alive.platform_starts();
    eventually("the keep-alive stops", || keep_alive.stops() == 1).await;
    assert!(!keep_alive.task_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_runner_s_own_stop_of_the_keep_alive_stops_no_unit() {
    let (harness, keep_alive) = harness_with_keep_alive();
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
    eventually("the keep-alive runs", || keep_alive.task_running()).await;
    harness.set_unit_policy("unit", RunPolicy::Off);
    harness
        .wait_until_stopped_for("unit", StopReason::PolicyInactive)
        .await;
    eventually("the keep-alive stops", || !keep_alive.task_running()).await;

    harness.set_unit_policy("unit", RunPolicy::Always);
    eventually("the unit and the keep-alive come back", || {
        probe.starts() == 2 && keep_alive.task_running()
    })
    .await;
}
