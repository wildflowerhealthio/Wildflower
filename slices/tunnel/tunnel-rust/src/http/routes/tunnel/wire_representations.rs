//! The wire type for the `GET /tunnel` handler. The handler lives in the
//! sibling `get` module and pulls the response shape from here.

use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::{TunnelLiveness, TunnelStatus};

/// Tunnel state on the wire: the observed liveness.
///
/// `status` is the daemon's [`TunnelStatus`] itself: `verified` only once a
/// `/health` probe through the public origin came back healthy, and the
/// supervisor re-probes, so it leaves `verified` if the tunnel silently drops.
/// `error` says why the tunnel is `unreachable`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateResponse {
    /// The liveness FSM position.
    pub(super) status: TunnelStatus,
    // Always serialized (no `skip_serializing_if`), so it's required-on-the-wire
    // even though it's `Option` — `#[schema(required)]` overrides utoipa's
    // Option-implies-optional default to match the always-present TS `NullOr`.
    #[schema(required)]
    pub(super) error: Option<String>,
}

impl From<TunnelLiveness> for TunnelStateResponse {
    fn from(liveness: TunnelLiveness) -> Self {
        TunnelStateResponse {
            status: liveness.status,
            error: liveness.error,
        }
    }
}
