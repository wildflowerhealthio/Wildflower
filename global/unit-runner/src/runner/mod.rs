//! [`UnitRunner`]: the units and their runs, starting and stopping runs per
//! policy, the restarts and the background session's demand. It knows the
//! session only through the
//! [`BackgroundSessionPlatform`](crate::BackgroundSessionPlatform) port, so it
//! runs on any platform.

mod dedicated_runtime;
mod erased_unit;
mod platform_session_requests;
mod run_stop_signal;
mod run_supervisor;
pub(crate) mod status_publisher;
mod unit_entry;
mod unit_run_gate;
mod unit_runner;
mod wall_clock_ticker;

#[cfg(test)]
mod tests;

use std::time::Duration;

pub use self::unit_runner::UnitRunner;
pub use dedicated_runtime::RUN_RUNTIME_SHUTDOWN_TIMEOUT;

/// How long `UnitRunner` waits before restarting a run that ended on its own
/// while its unit should still run.
pub const RESTART_DELAY: Duration = Duration::from_secs(5);

/// The longest `UnitRunner` goes without starting and stopping runs per policy
/// on the wall clock.
/// `tokio::time` runs on the monotonic clock, which stops while a laptop
/// sleeps; doing so this often catches an `Until` or a grace period that
/// ran out during a sleep soon after waking.
pub const START_AND_STOP_RUNS_PER_POLICY_INTERVAL: Duration = Duration::from_secs(10);

/// How many stops a subscriber of
/// [`UnitRunner::subscribe_stops`](UnitRunner::subscribe_stops) can fall behind
/// before it misses the oldest. A run stops at most once per
/// [`RESTART_DELAY`] per unit, so a reader that keeps up never gets near it.
pub const RUN_STOPS_CAPACITY: usize = 64;

/// `UnitRunner`'s timings: the public constants in an app, shorter in tests.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunnerTimings {
    pub(crate) restart_delay: Duration,
    pub(crate) run_runtime_shutdown_timeout: Duration,
    pub(crate) start_and_stop_runs_per_policy_interval: Duration,
}

impl Default for RunnerTimings {
    fn default() -> Self {
        Self {
            restart_delay: RESTART_DELAY,
            run_runtime_shutdown_timeout: RUN_RUNTIME_SHUTDOWN_TIMEOUT,
            start_and_stop_runs_per_policy_interval: START_AND_STOP_RUNS_PER_POLICY_INTERVAL,
        }
    }
}
