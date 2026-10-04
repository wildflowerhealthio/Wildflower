//! Shared wire types for the `/tunnel` handlers: the snapshot helper and the
//! response shape the GET/PUT operations serve on `/tunnel`, and the request
//! log's shapes `GET /tunnel/requests/callers` and `GET /tunnel/requests` serve. The
//! per-operation handlers (`get`, `replace`, `requests`, `callers`) live in
//! sibling modules and pull what they need from here.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use shared_structures_rust::request_caller::RequestRefusal;
use shared_structures_rust::tunnel_service::TunnelStatus;

use crate::domain::request_log::{CallerSummary, LoggedRequest, RequestAuth, RequestLogPage};
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

// The liveness state on the wire is the daemon's [`TunnelStatus`] FSM position
// itself — it derives `Serialize`/`ToSchema` (lowercase variants) in
// shared-structures, so there's no parallel wire enum to keep in lockstep.
// Variants drive `running`/`servedOrigin`:
//
//  - `off` — not requested on.
//  - `misconfigured` — requested but un-dialable (no relay, or no public host);
//    `error` says which.
//  - `dialing` — attempting; not yet proven reachable. `servedOrigin` is the
//    loopback fallback.
//  - `verified` — a `/health` probe through the public origin came back healthy;
//    the **only** status where `servedOrigin` is `https://{publicHost}`.
//  - `unreachable` — was attempting but the dial dropped or the probe failed;
//    retrying. Back to the loopback fallback.

/// Tunnel state on the wire. The relay connection's non-secret fields are
/// returned in [`RelayView`] (the `token` stays write-only and never appears
/// here). `settingsRevision` is the optimistic-concurrency token a PUT must echo.
///
/// # Liveness is now verified, not optimistic
///
/// `status` is the real [`TunnelStatus`] FSM position. `servedOrigin`
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
    pub(super) status: TunnelStatus,
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
            status: live.status,
            running: live.status.is_running(),
            error: live.error,
            dial_attempts: live.dial_attempts,
            served_origin: live.origin,
            relay,
        }
    }
}

/// Why a bearer gate refused a logged request with a `401`. Mirrors
/// [`RequestRefusal`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestRefusalBody {
    /// The request carried no bearer token.
    MissingToken,
    /// The token failed signature or claim validation.
    TokenRejected,
    /// The token verified but has been revoked.
    Revoked,
}

impl From<RequestRefusal> for RequestRefusalBody {
    fn from(refusal: RequestRefusal) -> Self {
        match refusal {
            RequestRefusal::MissingToken => Self::MissingToken,
            RequestRefusal::TokenRejected => Self::TokenRejected,
            RequestRefusal::Revoked => Self::Revoked,
        }
    }
}

/// The `auth` filter `GET /tunnel/requests` accepts: how a logged request fared
/// against auth. Mirrors [`RequestAuth`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RequestAuthParam {
    /// It needed auth and its token was valid: a verified caller, not refused.
    Authorized,
    /// It didn't need auth: no verified caller, not refused.
    Public,
    /// It failed auth: a bearer gate's `401` or a scope `403`.
    Refused,
}

impl From<RequestAuthParam> for RequestAuth {
    fn from(auth: RequestAuthParam) -> Self {
        match auth {
            RequestAuthParam::Authorized => Self::Authorized,
            RequestAuthParam::Public => Self::Public,
            RequestAuthParam::Refused => Self::Refused,
        }
    }
}

/// What the request log holds for one (caller, client address) pair — a row of
/// `GET /tunnel/requests/callers`. The client's display name is not included; resolve
/// `clientId` through gatekeeper's client list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CallerSummaryBody {
    /// The verified caller's OAuth client, or `null` for the requests no
    /// bearer gate verified.
    #[schema(required)]
    pub(super) client_id: Option<String>,
    /// The visitor's address the trusted front recorded, or `null` when it
    /// recorded none.
    #[schema(required)]
    pub(super) address: Option<String>,
    #[schema(value_type = String, format = DateTime)]
    pub(super) first_seen: DateTime<Utc>,
    #[schema(value_type = String, format = DateTime)]
    pub(super) last_seen: DateTime<Utc>,
    pub(super) request_count: i64,
    /// How many were refused: a bearer gate's `401` or a scope `403`.
    pub(super) refused_count: i64,
    /// The newest request's response status.
    pub(super) last_status: u16,
    /// The newest request's refusal, or `null` when no bearer gate refused it.
    #[schema(required)]
    pub(super) last_refusal: Option<RequestRefusalBody>,
}

impl From<CallerSummary> for CallerSummaryBody {
    fn from(summary: CallerSummary) -> Self {
        CallerSummaryBody {
            client_id: summary.caller.map(|caller| caller.client_id),
            address: summary.client_address,
            first_seen: summary.first_seen,
            last_seen: summary.last_seen,
            request_count: summary.request_count,
            refused_count: summary.refused_count,
            last_status: summary.last_status,
            last_refusal: summary.last_refusal.map(RequestRefusalBody::from),
        }
    }
}

/// One request in the log — an element of `GET /tunnel/requests`. `path` is
/// the route the request was reduced to: no ids and no query string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoggedRequestBody {
    /// The request's place in the log; a higher id is newer.
    pub(super) id: i64,
    #[schema(value_type = String, format = DateTime)]
    pub(super) received_at: DateTime<Utc>,
    #[schema(required)]
    pub(super) client_id: Option<String>,
    #[schema(required)]
    pub(super) address: Option<String>,
    /// The public `host[:port]` the visitor addressed.
    #[schema(required)]
    pub(super) served_host: Option<String>,
    pub(super) method: String,
    pub(super) path: String,
    pub(super) status: u16,
    /// The response body's length, or `null` when it wasn't known up front.
    #[schema(required)]
    pub(super) response_bytes: Option<u64>,
    pub(super) duration_ms: u64,
    #[schema(required)]
    pub(super) refusal: Option<RequestRefusalBody>,
}

impl From<LoggedRequest> for LoggedRequestBody {
    fn from(LoggedRequest { id, request }: LoggedRequest) -> Self {
        LoggedRequestBody {
            id,
            received_at: request.received_at.into(),
            client_id: request.caller.map(|caller| caller.client_id),
            address: request.client_address,
            served_host: request.served_host,
            method: request.method,
            path: request.reduced_path,
            status: request.status,
            response_bytes: request.response_bytes,
            // The log stores whole milliseconds as a non-negative `INTEGER`,
            // so a logged duration's milliseconds always fit.
            duration_ms: u64::try_from(request.duration.as_millis())
                .expect("a logged duration is whole u64 milliseconds"),
            refusal: request.refusal.map(RequestRefusalBody::from),
        }
    }
}

/// One page of `GET /tunnel/requests`, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogPageBody {
    pub(super) requests: Vec<LoggedRequestBody>,
    /// The `cursor` that reads the next page, or `null` on the last one.
    #[schema(required)]
    pub(super) next_cursor: Option<i64>,
}

impl From<RequestLogPage> for RequestLogPageBody {
    fn from(page: RequestLogPage) -> Self {
        RequestLogPageBody {
            requests: page
                .requests
                .into_iter()
                .map(LoggedRequestBody::from)
                .collect(),
            next_cursor: page.next_cursor,
        }
    }
}
