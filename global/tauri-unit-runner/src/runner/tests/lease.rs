//! The lease: taken while any unit should run, released when none should, and
//! what happens to every unit when the platform ends it.

use std::sync::Arc;
use std::time::Duration;

use super::fakes::{eventually, FakeLease, Harness, Probe, Script, A_WHILE};
use crate::domain::run_policy::RunPolicy;
use crate::runner::lease_driver::{drive_lease, LeasePlatform};
use crate::status::{PlatformStopReason, StopReason};
use crate::unit::UnitId;

/// A harness whose lease the fake platform holds.
fn harness_with_lease() -> (Harness, Arc<FakeLease>) {
    let harness = Harness::new();
    let lease = FakeLease::new(&harness.core);
    tokio::spawn(drive_lease(
        Arc::clone(&harness.core),
        Arc::clone(&lease) as Arc<dyn LeasePlatform>,
    ));
    (harness, lease)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lease_is_held_exactly_while_some_unit_should_run() {
    let (harness, lease) = harness_with_lease();
    for unit_id in ["first", "second"] {
        harness.set(
            unit_id,
            RunPolicy::Off,
            Script::RunUntilStopped { detail: None },
            &Probe::default(),
        );
    }
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(lease.takes(), 0, "no unit should run");

    harness
        .core
        .set_policy(&UnitId::from("first"), RunPolicy::Always);
    harness
        .core
        .set_policy(&UnitId::from("second"), RunPolicy::Always);
    eventually("the lease is held", || lease.task_running()).await;
    assert_eq!(lease.takes(), 1, "one lease for every unit");

    harness
        .core
        .set_policy(&UnitId::from("first"), RunPolicy::Off);
    tokio::time::sleep(A_WHILE).await;
    assert!(lease.task_running(), "the second unit still should run");

    harness
        .core
        .set_policy(&UnitId::from("second"), RunPolicy::Off);
    eventually("the lease is released", || !lease.task_running()).await;
    assert_eq!(lease.releases(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_waiting_to_restart_keeps_the_lease() {
    let harness = Harness::with_restart_delay(Duration::from_secs(3600));
    let lease = FakeLease::new(&harness.core);
    tokio::spawn(drive_lease(
        Arc::clone(&harness.core),
        Arc::clone(&lease) as Arc<dyn LeasePlatform>,
    ));
    harness.set(
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
    tokio::time::sleep(A_WHILE).await;
    assert!(lease.task_running());
    assert_eq!(lease.releases(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_platform_ending_the_lease_stops_every_unit_without_restart() {
    let (harness, lease) = harness_with_lease();
    let probe = Probe::default();
    for unit_id in ["first", "second"] {
        harness.set(
            unit_id,
            RunPolicy::Always,
            Script::RunUntilStopped { detail: None },
            &probe,
        );
    }
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
    eventually("the lease is held", || lease.task_running()).await;

    lease.platform_ends(PlatformStopReason::PlatformExpiration);
    let expired = StopReason::LeaseEnded {
        platform_reason: PlatformStopReason::PlatformExpiration,
    };
    harness.wait_until_stopped_for("first", expired).await;
    harness.wait_until_stopped_for("second", expired).await;
    tokio::time::sleep(A_WHILE).await;
    assert_eq!(probe.starts(), 2, "nothing restarts without the lease");
    assert_eq!(lease.takes(), 1, "the runner doesn't take the lease back");

    // The platform hands the lease back (an iOS background task).
    lease.platform_starts();
    eventually("both units run again", || probe.starts() == 4).await;
    harness.wait_until_running("first").await;
    harness.wait_until_running("second").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn coming_back_into_use_takes_the_lease_back() {
    let (harness, lease) = harness_with_lease();
    let probe = Probe::default();
    harness.core.set_in_use(true);
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    harness.wait_until_running("unit").await;
    eventually("the lease is held", || lease.task_running()).await;

    harness.core.set_in_use(false);
    lease.platform_ends(PlatformStopReason::NativeNotificationStop);
    harness
        .wait_until_stopped_for(
            "unit",
            StopReason::LeaseEnded {
                platform_reason: PlatformStopReason::NativeNotificationStop,
            },
        )
        .await;

    harness.core.set_in_use(true);
    eventually("the lease is taken again", || lease.takes() == 2).await;
    harness.wait_until_running("unit").await;
    assert_eq!(probe.starts(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lease_the_platform_starts_with_nothing_to_run_is_released() {
    let (harness, lease) = harness_with_lease();
    harness.set(
        "unit",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    lease.platform_starts();
    eventually("the lease is released", || lease.releases() == 1).await;
    assert!(!lease.task_running());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_runner_s_own_release_stops_nothing() {
    let (harness, lease) = harness_with_lease();
    let probe = Probe::default();
    harness.set(
        "unit",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &probe,
    );
    eventually("the lease is held", || lease.task_running()).await;
    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Off);
    harness
        .wait_until_stopped_for("unit", StopReason::StoppedByRunner)
        .await;
    eventually("the lease is released", || !lease.task_running()).await;

    harness
        .core
        .set_policy(&UnitId::from("unit"), RunPolicy::Always);
    eventually("the unit and the lease come back", || {
        probe.starts() == 2 && lease.task_running()
    })
    .await;
}
