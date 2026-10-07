//! [`ServerDetail`], what a server's run reports to the unit runner beyond its
//! run state.

use wildflower_server_rust::ServerHealth;

/// A server's own status: the unit runner's `Detail` for a
/// [`ServerUnit`](crate::ServerUnit). The runner reports it in the server's
/// `UnitStatus` while a run is in progress, and clears it when the run ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDetail {
    /// Whether the server's `/health` has answered through its public origin
    /// (the relay and the tunnel), as the server's reachability monitor
    /// publishes it; `None` until its first probe.
    pub health: Option<ServerHealth>,
}
