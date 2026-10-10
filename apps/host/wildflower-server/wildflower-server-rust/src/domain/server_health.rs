//! [`ServerHealth`]: what the host knows about the running server's
//! reachability and health.

use shared_structures_rust::health_check::HealthReport;

/// Whether the server's `/health`, requested through its public origin (the
/// relay and the tunnel), answered, and with what. The reachability monitor
/// publishes it on the host's channel (see
/// [`ServerObservers`](crate::ServerObservers)) until the first answer, so
/// `Reachable` is the last verdict of a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerHealth {
    /// `/health` answered through the public origin with this report. A
    /// reachable server can still report `fail`: it answered, and said it is
    /// unhealthy.
    Reachable(HealthReport),
    /// `/health` hasn't answered through the public origin yet: the latest
    /// request failed, timed out, or answered something other than a health
    /// report.
    Unreachable {
        /// Why, for the log.
        error: String,
    },
}
