//! [`ServerHealth`]: what the host knows about the running server's
//! reachability and health.

use shared_structures_rust::health_check::HealthReport;

/// Whether the server's `/health`, requested through its public origin (the
/// relay and the tunnel), answered, and with what. The reachability monitor
/// publishes it on the host's channel (see
/// [`ServerObservers`](crate::ServerObservers)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerHealth {
    /// `/health` answered through the public origin with this report. A
    /// reachable server can still report `fail`: it answered, and said it is
    /// unhealthy.
    Reachable(HealthReport),
    /// `/health` didn't answer through the public origin: the request failed,
    /// timed out, or answered something other than a health report.
    Unreachable {
        /// Why, for the log and the host's notification.
        error: String,
    },
}
