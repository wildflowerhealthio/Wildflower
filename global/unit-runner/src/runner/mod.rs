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

/// How long `UnitRunner` waits before the second restart in a row of a unit
/// whose runs end on their own while it should still run. The first restart in
/// a row is at once; each after this one waits twice as long as the one
/// before, up to [`MAX_UNIT_RESTART_BACKOFF`], until a run stays running for
/// [`STABLE_UNIT_UPTIME`].
pub const FIRST_UNIT_RESTART_BACKOFF: Duration = Duration::from_secs(5);

/// The longest `UnitRunner` waits before restarting a unit, however many times
/// in a row it has restarted.
pub const MAX_UNIT_RESTART_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// How long a run must have been running when it ends for its unit's restarts
/// in a row to start over, so it restarts at once again. A run that comes up
/// and fails sooner counts as one more restart in a row.
pub const STABLE_UNIT_UPTIME: Duration = Duration::from_secs(2 * 60);

/// The longest `UnitRunner` goes without starting and stopping runs per policy
/// on the wall clock.
/// `tokio::time` runs on the monotonic clock, which stops while a laptop
/// sleeps; doing so this often catches an `Until` or a grace period that
/// ran out during a sleep soon after waking.
pub const START_AND_STOP_RUNS_PER_POLICY_INTERVAL: Duration = Duration::from_secs(10);

/// How many stops a subscriber of
/// [`UnitRunner::subscribe_stops`](UnitRunner::subscribe_stops) can fall behind
/// before it misses the oldest. Past its immediate first restart, a failing
/// unit stops at most once per [`FIRST_UNIT_RESTART_BACKOFF`], so a reader that
/// keeps up never gets near it.
pub const RUN_STOPS_CAPACITY: usize = 64;

/// `UnitRunner`'s timings: the public constants in an app, shorter in tests.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunnerTimings {
    pub(crate) first_unit_restart_backoff: Duration,
    pub(crate) max_unit_restart_backoff: Duration,
    pub(crate) stable_unit_uptime: Duration,
    pub(crate) run_runtime_shutdown_timeout: Duration,
    pub(crate) start_and_stop_runs_per_policy_interval: Duration,
}

impl Default for RunnerTimings {
    fn default() -> Self {
        Self {
            first_unit_restart_backoff: FIRST_UNIT_RESTART_BACKOFF,
            max_unit_restart_backoff: MAX_UNIT_RESTART_BACKOFF,
            stable_unit_uptime: STABLE_UNIT_UPTIME,
            run_runtime_shutdown_timeout: RUN_RUNTIME_SHUTDOWN_TIMEOUT,
            start_and_stop_runs_per_policy_interval: START_AND_STOP_RUNS_PER_POLICY_INTERVAL,
        }
    }
}
