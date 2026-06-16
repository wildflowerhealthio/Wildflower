//! Shared wire types and the snapshot helper for the `/tunnel` GET/PUT
//! handlers. The per-route handlers (`get`, `put`) live in sibling modules and
//! pull what they need from here.
//!
//! NOTE(pr-ui): this Rust surface is the new tunnel contract — a full-replace
//! PUT with an optimistic-concurrency `revision`, a single `publicHost`, and a
//! write-only `relay` block. The `tunnel-core` TS schema and the `tunnel-react`
//! UI still speak the old PATCH/`subdomain`/`rootDomain` shape and are
//! reconciled in the follow-up UI PR; they are intentionally out of sync until
//! then.

use serde::Serialize;

use crate::domain::TunnelSettings;
use crate::TunnelDaemon;

/// Tunnel state on the wire. Relay connection details are write-only and never
/// appear here. `revision` is the optimistic-concurrency token a PUT must echo.
///
/// # `running` and `servedOrigin` are optimistic
///
/// `running` flips to `true` the instant a dial attempt starts and stays true
/// across reconnect attempts that haven't yet errored — it means *dialing*,
/// not *connected*. Rathole exposes no "handshake completed" signal, so the
/// daemon has nothing more precise to report. `servedOrigin` derives from
/// `running`, so it may resolve to `https://{publicHost}` while the tunnel is
/// still mid-dial (or briefly during a reconnect after a real failure).
///
/// A caller that needs *verified reachable* (e.g. an await-tunnel flow that
/// hands `servedOrigin` to another component) must probe the URL itself —
/// don't treat `running: true` as a liveness guarantee.
///
/// TODO(pr-ui): the follow-up UI PR that reconciles the TS contract is the
/// right moment to introduce a real liveness signal (probe or tri-state),
/// when the consumer's actual needs are visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateResponse {
    pub(super) revision: i64,
    pub(super) public_host: Option<String>,
    pub(super) requested_running: bool,
    /// `true` when the daemon is *dialing or reconnecting* — not a
    /// connected-handshake signal. See the type-level docs.
    pub(super) running: bool,
    pub(super) error: Option<String>,
    /// Dial attempts the live supervisor has made for this revision, resets
    /// on the next reconcile. Surfaced so an operator can spot a permanent
    /// misconfiguration (counter climbs with no recovery) without the daemon
    /// having to classify rathole errors itself.
    pub(super) attempt: i64,
    /// `https://{publicHost}` while `running` (optimistically — see the
    /// type-level docs), else the loopback fallback.
    pub(super) served_origin: String,
}

impl TunnelStateResponse {
    /// Build the wire snapshot from persisted `settings` + the live observed
    /// runtime. Shared by both the GET response and the PUT response (success and
    /// `409 CONFLICT` alike).
    pub(super) fn from_current_state(
        state: &TunnelDaemon,
        settings: &TunnelSettings,
    ) -> TunnelStateResponse {
        let observed = state.observed();
        let served_origin = Self::served_origin(
            observed.running,
            settings.public_host.as_deref(),
            state.loopback_origin(),
        );
        TunnelStateResponse {
            revision: settings.revision,
            public_host: settings.public_host.clone(),
            requested_running: settings.requested_running,
            running: observed.running,
            error: observed.error,
            attempt: observed.attempt,
            served_origin,
        }
    }

    /// Compute the origin clients should reach the server at: the public
    /// `https://{publicHost}` when the daemon is dialing this revision's
    /// configured host, else the loopback fallback. Optimistic — see the
    /// type-level docs on [`TunnelStateResponse`].
    fn served_origin(running: bool, public_host: Option<&str>, loopback_origin: &str) -> String {
        match public_host {
            Some(host) if running && !host.is_empty() => format!("https://{host}"),
            _ => loopback_origin.to_string(),
        }
    }
}
