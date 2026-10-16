//! Arrivals in the foreground: `subscribe_foreground_arrivals` counts the
//! app's first time present, each return, and each return to the foreground
//! it left while present, and says whether the app is in the foreground; and
//! `units_to_run` names the units an arrival brings up before their runs
//! begin, and none waiting out a restart delay.

use std::time::Duration;

use super::fakes::{eventually, Harness, Probe, Script};
use crate::domain::app_presence::{ForegroundArrivals, Presence};
use crate::domain::run_policy::RunPolicy;
use crate::domain::unit_plan::UnitPhase;
use crate::unit::UnitId;

/// `arrivals` arrivals, the app in the foreground or not as `in_foreground`
/// says.
fn foreground(arrivals: u64, in_foreground: bool) -> ForegroundArrivals {
    ForegroundArrivals {
        arrivals,
        in_foreground,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_time_present_and_each_return_are_arrivals() {
    let harness = Harness::new();
    let mut arrivals = harness.unit_runner.subscribe_foreground_arrivals();

    harness.unit_runner.set_app_presence(Presence::Present);
    assert!(arrivals.has_changed().unwrap());
    assert_eq!(*arrivals.borrow_and_update(), foreground(1, true));

    for expected in 2..=3 {
        harness.unit_runner.set_app_presence(Presence::Absent);
        assert_eq!(
            *arrivals.borrow_and_update(),
            foreground(expected - 1, false),
            "leaving is no arrival"
        );
        harness.unit_runner.set_app_presence(Presence::Present);

        assert!(arrivals.has_changed().unwrap());
        assert_eq!(*arrivals.borrow_and_update(), foreground(expected, true));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_background_is_no_arrival() {
    let harness = Harness::new();
    harness.unit_runner.set_app_presence(Presence::Present);
    let arrivals = harness.unit_runner.subscribe_foreground_arrivals();

    harness
        .unit_runner
        .set_app_presence(Presence::PresentInBackground);
    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(!arrivals.has_changed().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn coming_back_to_the_foreground_left_while_present_is_an_arrival() {
    let harness = Harness::new();
    let mut arrivals = harness.unit_runner.subscribe_foreground_arrivals();
    harness.unit_runner.set_in_foreground_while_present(true);
    assert!(
        !arrivals.has_changed().unwrap(),
        "an absent app's presence says when it arrives"
    );
    harness.unit_runner.set_app_presence(Presence::Present);
    arrivals.borrow_and_update();

    harness.unit_runner.set_in_foreground_while_present(false);
    assert_eq!(*arrivals.borrow_and_update(), foreground(1, false));
    harness.unit_runner.set_in_foreground_while_present(false);
    assert!(!arrivals.has_changed().unwrap(), "it left once");
    harness.unit_runner.set_in_foreground_while_present(true);

    assert_eq!(*arrivals.borrow_and_update(), foreground(2, true));
    harness.unit_runner.set_in_foreground_while_present(true);
    assert!(!arrivals.has_changed().unwrap(), "it came back once");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_units_to_run_are_those_the_policies_want_running_now() {
    let harness = Harness::new();
    for (unit_id, policy) in [
        ("always", RunPolicy::Always),
        ("while-open", RunPolicy::WhileOpen),
        ("off", RunPolicy::Off),
    ] {
        harness.set_unit(
            unit_id,
            policy,
            Script::RunUntilStopped { detail: None },
            &Probe::default(),
        );
    }
    assert_eq!(
        harness.unit_runner.units_to_run(),
        [UnitId::from("always")].into()
    );

    harness.unit_runner.set_app_presence(Presence::Present);

    assert_eq!(
        harness.unit_runner.units_to_run(),
        [UnitId::from("always"), UnitId::from("while-open")].into(),
        "at once, its run not begun yet"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_unit_waiting_out_its_restart_delay_is_not_to_run() {
    let harness = Harness::with_restart_delay(Duration::from_secs(600));
    let probe = Probe::default();
    harness.set_unit(
        "failing",
        RunPolicy::Always,
        Script::Fail {
            detail: None,
            error: "lost the connection",
        },
        &probe,
    );
    harness.set_unit(
        "running",
        RunPolicy::Always,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    // Its first restart is at once; the second waits out the delay.
    eventually("the second failure's restart is pending", || {
        probe.starts() == 2 && harness.phase("failing") == Some(UnitPhase::AwaitingRestart)
    })
    .await;

    assert_eq!(
        harness.unit_runner.units_to_run(),
        [UnitId::from("running")].into()
    );
}
