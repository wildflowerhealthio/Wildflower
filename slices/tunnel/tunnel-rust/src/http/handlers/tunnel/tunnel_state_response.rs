//! Shared wire types and the snapshot helper for the `/tunnel` GET/PUT
//! handlers. The per-route handlers (`get`, `put`) live in sibling modules and
//! pull what they need from here.
//!
use serde::Serialize;
use utoipa::ToSchema;

use shared_structures_rust::tunnel_service::TunnelStatus;

use crate::domain::TunnelSettings;
use crate::TunnelDaemon;

/// The readable view of the relay connection — everything except the secret
/// `token`, which stays write-only and is never returned. Mirrors
/// `RelaySettings` minus `token`. The client prefills these and only re-sends
/// the relay block (with a fresh token) when the user changes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    pub(super) remote_addr: String,
    pub(super) public_key: String,
    pub(super) service_name: String,
}

/// The liveness state on the wire — the daemon's [`TunnelStatus`] FSM position.
/// Drives `running`/`servedOrigin`, which are derived views of it:
///
///  - `off` — not requested on.
///  - `misconfigured` — requested but un-dialable (no relay, or no public
///    host); `error` says which.
///  - `dialing` — attempting; not yet proven reachable. `servedOrigin` is the
///    loopback fallback.
///  - `verified` — a `/health` probe through the public origin came back
///    healthy; the **only** status where `servedOrigin` is
///    `https://{publicHost}`.
///  - `unreachable` — was attempting but the dial dropped or the probe failed;
///    retrying. Back to the loopback fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatusWire {
    Off,
    Misconfigured,
    Dialing,
    Verified,
    Unreachable,
}

impl From<TunnelStatus> for TunnelStatusWire {
    fn from(status: TunnelStatus) -> Self {
        match status {
            TunnelStatus::Off => TunnelStatusWire::Off,
            TunnelStatus::Misconfigured => TunnelStatusWire::Misconfigured,
            TunnelStatus::Dialing => TunnelStatusWire::Dialing,
            TunnelStatus::Verified => TunnelStatusWire::Verified,
            TunnelStatus::Unreachable => TunnelStatusWire::Unreachable,
        }
    }
}

/// Tunnel state on the wire. The relay connection's non-secret fields are
/// returned in [`RelayView`] (the `token` stays write-only and never appears
/// here). `settingsRevision` is the optimistic-concurrency token a PUT must echo.
///
/// # Liveness is now verified, not optimistic
///
/// `status` is the real [`TunnelStatusWire`] FSM position. `servedOrigin`
/// resolves to `https://{publicHost}` **only** while `status == "verified"` —
/// i.e. after a `/health` probe through the public origin came back healthy —
/// and the supervisor re-probes, so it reverts to the loopback fallback if the
/// tunnel silently drops. `running` is the coarse "a supervisor is attempting"
/// view (`dialing`/`verified`/`unreachable`), retained for back-compat; prefer
/// `status`.
/// `dialAttempts` counts relay dials for this revision (resets on the next
/// reconcile) — a counter climbing with a steady `error` flags a permanent
/// misconfiguration. This is the resolution of
/// <https://github.com/Assessment-is/Wildflower/issues/184>.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateResponse {
    /// Which revision of the persisted settings this snapshot reflects — the
    /// optimistic-concurrency token a PUT must echo.
    pub(super) settings_revision: i64,
    // Always serialized (no `skip_serializing_if`), so it's required-on-the-wire
    // even though it's `Option` — `#[schema(required)]` overrides utoipa's
    // Option-implies-optional default to match the always-present TS `NullOr`.
    #[schema(required)]
    pub(super) public_host: Option<String>,
    pub(super) requested_running: bool,
    /// The liveness FSM position — the authoritative state. See the type docs.
    pub(super) status: TunnelStatusWire,
    /// `true` when a supervisor is attempting (`dialing`/`verified`/
    /// `unreachable`). A derived view of `status`, kept for back-compat.
    pub(super) running: bool,
    #[schema(required)]
    pub(super) error: Option<String>,
    /// How many times the tunnel has tried to dial the relay for this revision,
    /// resets on the next reconcile. Surfaced so an operator can spot a permanent
    /// misconfiguration (counter climbs with no recovery) without the daemon
    /// having to classify rathole errors itself.
    pub(super) dial_attempts: i64,
    /// `https://{publicHost}` only while `status == "verified"`, else the
    /// loopback fallback. See the type-level docs.
    pub(super) served_origin: String,
    /// The relay connection's non-secret fields, or `null` when no relay is
    /// configured. The `token` is never included.
    #[schema(required)]
    pub(super) relay: Option<RelayView>,
}

impl TunnelStateResponse {
    /// Build the wire snapshot from persisted `settings` + the live liveness.
    /// Shared by both the GET response and the PUT response (success and
    /// `409 CONFLICT` alike). Every liveness-derived field (`status`, `running`,
    /// `error`, `dialAttempts`, `servedOrigin`) comes from the daemon's single
    /// `watch`, so the HTTP surface and the in-process consumers can't diverge.
    pub(super) fn from_current_state(
        state: &TunnelDaemon,
        settings: &TunnelSettings,
    ) -> TunnelStateResponse {
        let live = state.liveness();
        let relay = settings.relay_settings.as_ref().map(|r| RelayView {
            remote_addr: r.remote_addr.clone(),
            public_key: r.public_key.clone(),
            service_name: r.service_name.clone(),
        });
        TunnelStateResponse {
            settings_revision: settings.revision,
            public_host: settings.public_host.clone(),
            requested_running: settings.requested_running,
            status: live.status.into(),
            running: live.status.is_running(),
            error: live.error,
            dial_attempts: live.dial_attempts,
            served_origin: live.origin,
            relay,
        }
    }
}
