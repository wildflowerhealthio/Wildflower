//! The wall-clock reconcile: reconciling when a policy or grace period runs
//! out, and at least every
//! [`WALL_CLOCK_RECONCILE_INTERVAL`](super::WALL_CLOCK_RECONCILE_INTERVAL).

use std::sync::Arc;

use super::UnitRunner;

/// Reconcile at the next wall-clock deadline, or after the wall-clock interval,
/// whichever is sooner, and again whenever the next deadline moves.
///
/// The wait runs on `tokio::time`, whose clock stops while a laptop sleeps, so
/// a deadline that passed during a sleep is caught by the first interval after
/// waking, when the reconcile reads the wall clock.
pub(super) async fn reconcile_on_the_wall_clock<D: Clone + Send + Sync + 'static>(
    unit_runner: Arc<UnitRunner<D>>,
) {
    loop {
        let wait = unit_runner.time_until_next_reconcile();
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = unit_runner.next_deadline_moved.notified() => {}
        }
        unit_runner.reconcile();
    }
}
