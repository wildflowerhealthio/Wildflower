//! [`ServerRunState`], the lifecycle each server run reports and the host
//! watches.

/// Where the current server run is.
///
/// Runs are ordered by the [`RunGate`](crate::domain::run_gate::RunGate) and
/// each run writes its states in this order, so the host's watch of it never
/// goes backwards: `Starting` → `Running` → `Stopped`, or `Starting` →
/// `Stopped` when startup fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerRunState {
    /// A run holds the gate and is setting the server up.
    Starting,
    /// The server is bound and serving.
    Running,
    /// No run is serving. `error` is the most recent run's failure as its full
    /// `{:#}` chain, or `None` when it stopped cleanly or none has run yet.
    Stopped { error: Option<String> },
}
