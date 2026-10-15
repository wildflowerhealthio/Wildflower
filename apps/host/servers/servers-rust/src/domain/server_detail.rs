//! [`ServerDetail`], what a server's run reports to `UnitRunner` beyond its
//! run state.

use wildflowerhealthio_authorization_server::PendingConsentHead;
use wildflowerhealthio_tunnel::TunnelState;
use wildflowerhealthio_wildflower_server::{CertificateState, ServerHealth};

use crate::live_bindings::server_launch_minter::ServerLaunchMinter;
use crate::live_bindings::server_sign_in_code_minter::ServerSignInCodeMinter;

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
    /// Where the server's tunnel's connection to its relay stands, as its
    /// tunnel daemon publishes it for as long as the run lasts; `None` until
    /// the daemon starts.
    pub tunnel: Option<TunnelState>,
    /// Where the server's certificate stands, as the run publishes it while
    /// it deploys, orders and renews it; `None` until the run's certificate
    /// starts.
    pub certificate: Option<CertificateState>,
    /// The oldest consent waiting for the Owner's answer on this server, as
    /// its authorization server publishes it; `None` when nothing waits.
    pub pending_consent: Option<PendingConsentHead>,
    /// How the host mints the launches it opens this server's launcher with.
    /// A run always sets it; it is `None` only in a detail built without a
    /// server, as the domain's tests build theirs.
    pub launch_minter: Option<ServerLaunchMinter>,
    /// How the host mints the codes it signs the in-app browser in as the
    /// Owner with, before it opens a launch or the Authorization app there.
    /// A run always sets it; it is `None` only in a detail built without a
    /// server, as the domain's tests build theirs.
    pub sign_in_code_minter: Option<ServerSignInCodeMinter>,
}
