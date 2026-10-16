//! Returns to the foreground: `subscribe_returns` reports each, with the
//! statuses of the units whose run carries on across it and of those it
//! resumes.

use super::fakes::{Harness, Probe, Script};
use crate::domain::app_presence::{Presence, WHILE_OPEN_GRACE};
use crate::domain::run_policy::RunPolicy;
use crate::status::{StopReason, UnitStatuses};
use crate::unit::UnitId;

/// A harness with the app present and `unit_id` running under `policy`,
/// reporting its detail.
async fn running(unit_id: &str, policy: RunPolicy) -> Harness {
    let harness = Harness::new();
    harness.unit_runner.set_app_presence(Presence::Present);
    harness.set_unit(
        unit_id,
        policy,
        Script::RunUntilStopped {
            detail: Some("up".to_owned()),
        },
        &Probe::default(),
    );
    harness
        .wait_for(unit_id, "reporting", |status| status.detail.is_some())
        .await;
    harness
}

/// The ids of `statuses`' units, in order.
fn unit_ids<D>(statuses: &UnitStatuses<D>) -> Vec<&UnitId> {
    statuses.keys().collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_return_reports_the_runs_that_carried_on_and_the_units_it_resumes() {
    let harness = running("kept", RunPolicy::Always).await;
    harness.set_unit(
        "stopped",
        RunPolicy::WhileOpen,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    harness.set_unit(
        "off",
        RunPolicy::Off,
        Script::RunUntilStopped { detail: None },
        &Probe::default(),
    );
    harness.wait_until_running("stopped").await;
    let mut returns = harness.unit_runner.subscribe_returns();

    harness.unit_runner.set_app_presence(Presence::Absent);
    harness.clock.advance(WHILE_OPEN_GRACE);
    harness.unit_runner.start_and_stop_runs_per_policy();
    harness
        .wait_until_stopped_for("stopped", StopReason::PolicyInactive)
        .await;
    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(returns.has_changed().unwrap());
    let app_return = returns.borrow_and_update().clone();
    assert_eq!(unit_ids(&app_return.carried_on), [&UnitId::from("kept")]);
    assert_eq!(
        app_return.carried_on[&UnitId::from("kept")]
            .detail
            .as_deref(),
        Some("up")
    );
    assert_eq!(
        unit_ids(&app_return.resumed),
        [&UnitId::from("stopped")],
        "a unit that shouldn't run is in neither"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_asked_to_restart_before_the_return_is_resumed() {
    let harness = running("unit", RunPolicy::Always).await;
    let mut returns = harness.unit_runner.subscribe_returns();
    harness.unit_runner.set_app_presence(Presence::Absent);

    harness.unit_runner.restart_running_units();
    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(returns.has_changed().unwrap());
    let app_return = returns.borrow_and_update().clone();
    assert!(app_return.carried_on.is_empty());
    assert_eq!(unit_ids(&app_return.resumed), [&UnitId::from("unit")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_s_first_time_present_is_no_return() {
    let harness = Harness::new();
    let returns = harness.unit_runner.subscribe_returns();

    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(!returns.has_changed().unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_the_background_is_no_return() {
    let harness = running("unit", RunPolicy::Always).await;
    let returns = harness.unit_runner.subscribe_returns();

    harness
        .unit_runner
        .set_app_presence(Presence::PresentInBackground);
    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(!returns.has_changed().unwrap());
}
