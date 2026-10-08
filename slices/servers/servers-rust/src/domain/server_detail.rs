//! [`ServerDetail`], what a server's run reports to `UnitRunner` beyond its
//! run state.

use gatekeeper_rust::PendingConsentHead;
use wildflower_server_rust::ServerHealth;

/// A server's own status: `UnitRunner`'s `Detail` for a
/// [`ServerUnit`](crate::ServerUnit). `UnitRunner` reports it in the server's
/// `UnitStatus` while a run is in progress, and clears it when the run ends.
/// A run reports it once the server is set up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerDetail {
    /// Whether the server's `/health` has answered through its public origin
    /// (the relay and the tunnel), as the server's reachability monitor
    /// publishes it; `None` until its first probe.
    pub health: Option<ServerHealth>,
    /// The oldest consent waiting for the Owner's answer on this server, as
    /// its gatekeeper publishes it; `None` when nothing waits.
    pub pending_consent: Option<PendingConsentHead>,
}
