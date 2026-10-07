//! The wall-clock ticker: starting and stopping runs per policy when a policy
//! or grace period runs out, and at least every
//! [`START_AND_STOP_RUNS_PER_POLICY_INTERVAL`](super::START_AND_STOP_RUNS_PER_POLICY_INTERVAL).

use std::sync::Arc;

use super::UnitRunner;

/// Start and stop runs per policy at the next wall-clock deadline, or after the
/// wall-clock interval, whichever is sooner, and again whenever the next
/// deadline moves, until the runtime shuts down.
///
/// The wait runs on `tokio::time`, whose clock stops while a laptop sleeps, so
/// a deadline that passed during a sleep is caught by the first interval after
/// waking, when starting and stopping runs per policy reads the wall clock.
pub(super) async fn start_and_stop_runs_on_the_wall_clock<D: Clone + Send + Sync + 'static>(
    unit_runner: Arc<UnitRunner<D>>,
) {
    loop {
        let wait = unit_runner.time_until_start_and_stop_runs();
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = unit_runner.next_start_and_stop_runs_moved.notified() => {}
        }
        unit_runner.start_and_stop_runs_per_policy();
    }
}
