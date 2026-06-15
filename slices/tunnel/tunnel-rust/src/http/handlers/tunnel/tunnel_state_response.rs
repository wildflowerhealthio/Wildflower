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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStateResponse {
    pub(super) revision: i64,
    pub(super) public_host: Option<String>,
    pub(super) requested_running: bool,
    pub(super) running: bool,
    pub(super) error: Option<String>,
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
            served_origin,
        }
    }

    /// Compute the origin clients should reach the server at: the public
    /// `https://{publicHost}` only when the tunnel is up and the host is set, else
    /// the loopback fallback.
    fn served_origin(running: bool, public_host: Option<&str>, loopback_origin: &str) -> String {
        match public_host {
            Some(host) if running && !host.is_empty() => format!("https://{host}"),
            _ => loopback_origin.to_string(),
        }
    }
}
