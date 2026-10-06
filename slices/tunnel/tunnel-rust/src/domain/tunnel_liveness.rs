//! The tunnel's liveness: where the [`TunnelDaemon`](super::TunnelDaemon)'s
//! supervisor is, and why it isn't verified when it isn't.

use serde::Serialize;
use utoipa::ToSchema;

/// The liveness state of the tunnel. `GET /tunnel` serializes it directly
/// (lowercase variants), so there is no parallel wire enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    /// Dialing the relay; not yet proven reachable.
    Dialing,
    /// A `/health` probe through the public origin came back healthy.
    Verified,
    /// The dial dropped or the probe failed; retrying.
    Unreachable,
}

/// A snapshot of the tunnel's liveness, published on the daemon's watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelLiveness {
    /// The liveness FSM position.
    pub status: TunnelStatus,
    /// A human-readable reason for `Unreachable`, else `None`.
    pub error: Option<String>,
}
