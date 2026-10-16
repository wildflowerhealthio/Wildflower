//! Arrivals in the foreground: `subscribe_foreground_arrivals` changes with
//! the app's first time present and each return, and with nothing else; and
//! `units_to_run` names the units an arrival brings up before their runs
//! begin.

use super::fakes::{Harness, Probe, Script};
use crate::domain::app_presence::Presence;
use crate::domain::run_policy::RunPolicy;
use crate::unit::UnitId;

#[tokio::test(flavor = "multi_thread")]
async fn the_first_time_present_and_each_return_are_arrivals() {
    let harness = Harness::new();
    let mut arrivals = harness.unit_runner.subscribe_foreground_arrivals();

    harness.unit_runner.set_app_presence(Presence::Present);
    assert!(arrivals.has_changed().unwrap());
    assert_eq!(*arrivals.borrow_and_update(), 1);

    for expected in 2..=3 {
        harness.unit_runner.set_app_presence(Presence::Absent);
        assert!(!arrivals.has_changed().unwrap(), "leaving is no arrival");
        harness.unit_runner.set_app_presence(Presence::Present);

        assert!(arrivals.has_changed().unwrap());
        assert_eq!(*arrivals.borrow_and_update(), expected);
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
