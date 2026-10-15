//! Returns to the foreground: `subscribe_returns` reports each, with the
//! statuses of the units whose run carries on across it.

use super::fakes::{Harness, Probe, Script};
use crate::domain::app_presence::{Presence, WHILE_OPEN_GRACE};
use crate::domain::run_policy::RunPolicy;
use crate::status::StopReason;
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

#[tokio::test(flavor = "multi_thread")]
async fn a_return_reports_the_runs_that_carried_on_and_leaves_out_the_stopped_ones() {
    let harness = running("kept", RunPolicy::Always).await;
    harness.set_unit(
        "stopped",
        RunPolicy::WhileOpen,
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
    let carried_on = returns.borrow_and_update().clone();
    assert_eq!(
        carried_on.keys().collect::<Vec<_>>(),
        [&UnitId::from("kept")]
    );
    assert_eq!(
        carried_on[&UnitId::from("kept")].detail.as_deref(),
        Some("up")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_asked_to_restart_before_the_return_doesn_t_carry_on() {
    let harness = running("unit", RunPolicy::Always).await;
    let mut returns = harness.unit_runner.subscribe_returns();
    harness.unit_runner.set_app_presence(Presence::Absent);

    harness.unit_runner.restart_running_units();
    harness.unit_runner.set_app_presence(Presence::Present);

    assert!(returns.has_changed().unwrap());
    assert!(returns.borrow_and_update().is_empty());
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
