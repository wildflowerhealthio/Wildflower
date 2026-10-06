//! The wire type for the `GET /tunnel` handler. The handler lives in the
//! sibling `get` module and pulls the response shape from here.

use serde::Serialize;
use utoipa::ToSchema;

use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelStatus};

// The liveness state on the wire is the daemon's [`TunnelStatus`] FSM position
// itself — it derives `Serialize`/`ToSchema` (lowercase variants) in
// shared-structures, so there's no parallel wire enum to keep in lockstep.
// Variants drive `running`/`servedOrigin`:
//
//  - `off` — no tunnel (a server wired without one).
//  - `dialing` — attempting; not yet proven reachable. `servedOrigin` is the
//    loopback fallback.
//  - `verified` — a `/health` probe through the public origin came back healthy;
//    the **only** status where `servedOrigin` is `https://{publicHost}`.
//  - `unreachable` — was attempting but the dial dropped or the probe failed;
//    retrying. Back to the loopback fallback.

/// Tunnel state on the wire: the observed liveness and the public host.
///
/// # Liveness is verified, not optimistic
///
/// `status` is the real [`TunnelStatus`] FSM position. `servedOrigin`
/// resolves to `https://{publicHost}` **only** while `status == "verified"` —
/// i.e. after a `/health` probe through the public origin came back healthy —
/// and the supervisor re-probes, so it reverts to the loopback fallback if the
/// tunnel silently drops. `running` is the coarse "a supervisor is attempting"
/// view (`dialing`/`verified`/`unreachable`).
/// `dialAttempts` counts relay dials since the server started — a counter
/// climbing with a steady `error` flags a permanent misconfiguration. This is
/// the resolution of <https://github.com/Assessment-is/Wildflower/issues/184>.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateResponse {
    /// The bare public host the relay serves the server at, from the server's
    /// record.
    pub(super) public_host: String,
    /// The liveness FSM position — the authoritative state. See the type docs.
    pub(super) status: TunnelStatus,
    /// `true` when a supervisor is attempting (`dialing`/`verified`/
    /// `unreachable`). A derived view of `status`.
    pub(super) running: bool,
    // Always serialized (no `skip_serializing_if`), so it's required-on-the-wire
    // even though it's `Option` — `#[schema(required)]` overrides utoipa's
    // Option-implies-optional default to match the always-present TS `NullOr`.
    #[schema(required)]
    pub(super) error: Option<String>,
    /// How many times the tunnel has tried to dial the relay since the server
    /// started. Surfaced so an operator can spot a permanent misconfiguration
    /// (counter climbs with no recovery) without the daemon having to classify
    /// rathole errors itself.
    pub(super) dial_attempts: i64,
    /// `https://{publicHost}` only while `status == "verified"`, else the
    /// loopback fallback. See the type-level docs.
    pub(super) served_origin: String,
}

impl TunnelStateResponse {
    /// Build the wire snapshot from the daemon's `public_host` and its live
    /// `liveness`. Every liveness-derived field (`status`, `running`, `error`,
    /// `dialAttempts`, `servedOrigin`) comes from the daemon's single `watch`, so
    /// the HTTP surface and the in-process consumers can't diverge.
    pub(super) fn from_liveness(
        public_host: &str,
        liveness: TunnelLiveness,
    ) -> TunnelStateResponse {
        TunnelStateResponse {
            public_host: public_host.to_owned(),
            status: liveness.status,
            running: liveness.status.is_running(),
            error: liveness.error,
            dial_attempts: liveness.dial_attempts,
            served_origin: liveness.origin,
        }
    }
}
