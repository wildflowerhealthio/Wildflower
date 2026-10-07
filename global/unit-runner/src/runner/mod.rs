//! The runner, [`UnitRunnerCore`]: the units and their runs, the reconcile,
//! the restarts and the background session's demand. It knows the session
//! only through the
//! [`BackgroundSessionPlatform`](crate::BackgroundSessionPlatform) port, so it
//! runs on any platform.

mod background_session_driver;
mod core;
mod dedicated_runtime;
mod erased_unit;
mod run_gate;
mod run_supervisor;
pub(crate) mod status_board;
mod unit_entry;
mod wall_clock_ticker;

#[cfg(test)]
mod tests;

use std::time::Duration;

pub use self::core::UnitRunnerCore;
pub use dedicated_runtime::RUN_RUNTIME_SHUTDOWN_TIMEOUT;

/// How long the runner waits before restarting a run that ended on its own
/// while its unit should still run.
pub const RESTART_DELAY: Duration = Duration::from_secs(5);

/// The longest the runner goes without reconciling on the wall clock.
/// `tokio::time` runs on the monotonic clock, which stops while a laptop
/// sleeps; reconciling this often catches an `Until` or a grace period that
/// ran out during a sleep soon after waking.
pub const WALL_CLOCK_RECONCILE_INTERVAL: Duration = Duration::from_secs(10);

/// The runner's timings: the public constants in an app, shorter in tests.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunnerTimings {
    pub(crate) restart_delay: Duration,
    pub(crate) run_runtime_shutdown_timeout: Duration,
    pub(crate) wall_clock_reconcile_interval: Duration,
}

impl Default for RunnerTimings {
    fn default() -> Self {
        Self {
            restart_delay: RESTART_DELAY,
            run_runtime_shutdown_timeout: RUN_RUNTIME_SHUTDOWN_TIMEOUT,
            wall_clock_reconcile_interval: WALL_CLOCK_RECONCILE_INTERVAL,
        }
    }
}
