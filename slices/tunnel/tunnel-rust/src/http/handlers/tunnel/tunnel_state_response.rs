//! Shared wire types and the snapshot helper for the `/tunnel` GET/PUT
//! handlers. The per-route handlers (`get`, `put`) live in sibling modules and
//! pull what they need from here.
//!
use serde::Serialize;

use crate::domain::TunnelSettings;
use crate::TunnelDaemon;

/// The readable view of the relay connection — everything except the secret
/// `token`, which stays write-only and is never returned. Mirrors
/// `RelaySettings` minus `token`. The client prefills these and only re-sends
/// the relay block (with a fresh token) when the user changes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    pub(super) remote_addr: String,
    pub(super) public_key: String,
    pub(super) service_name: String,
}

/// Tunnel state on the wire. The relay connection's non-secret fields are
/// returned in [`RelayView`] (the `token` stays write-only and never appears
/// here). `revision` is the optimistic-concurrency token a PUT must echo.
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
/// A real liveness signal (probe or tri-state) to replace the optimistic
/// `running` / `servedOrigin` is tracked in
/// <https://github.com/Assessment-is/Wildflower/issues/184>; the dirty-gated
/// settings UI accepts the optimistic value for now.
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
    /// The relay connection's non-secret fields, or `null` when no relay is
    /// configured. The `token` is never included.
    pub(super) relay: Option<RelayView>,
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
        let relay = settings.relay_settings.as_ref().map(|r| RelayView {
            remote_addr: r.remote_addr.clone(),
            public_key: r.public_key.clone(),
            service_name: r.service_name.clone(),
        });
        TunnelStateResponse {
            revision: settings.revision,
            public_host: settings.public_host.clone(),
            requested_running: settings.requested_running,
            running: observed.running,
            error: observed.error,
            attempt: observed.attempt,
            served_origin,
            relay,
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
