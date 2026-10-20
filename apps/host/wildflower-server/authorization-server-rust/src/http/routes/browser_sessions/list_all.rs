use std::sync::Arc;

use axum::routing::{get, MethodRouter};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use wildflowerhealthio_scope_capabilities::Authenticated;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::browser_session::BrowserSessionKind;
use crate::domain::capabilities::{BrowserSessionView, Scoped};
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::{LiveBrowserSessionsReader, LiveSessionReader};

/// A live browser session as the Owner's "Browsers" list reads it. Every
/// column of the `browser_sessions` row but its `scopes` and `revoked_at`
/// (always `null` on a live one), plus `heldByCaller`: whether the caller's
/// own token was minted under it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSessionBody {
    /// The session's id, which a revoke names.
    sid: String,
    /// How the browser got its session: `same_device` or `paired`.
    kind: BrowserSessionKind,
    /// The name the browser was given; `null` for a same-device session.
    name: Option<String>,
    /// When the browser signed in or was paired.
    created_at: DateTime<Utc>,
    /// When the session stops letting the browser start things.
    expires_at: DateTime<Utc>,
    /// When the session was last in use, to the nearest
    /// `LAST_SEEN_RESOLUTION`.
    last_seen_at: DateTime<Utc>,
    /// Whether the caller's own token was minted under this session: revoking
    /// it signs the caller's browser out.
    held_by_caller: bool,
}

impl From<BrowserSessionView> for BrowserSessionBody {
    fn from(
        BrowserSessionView {
            session,
            held_by_caller,
        }: BrowserSessionView,
    ) -> Self {
        BrowserSessionBody {
            sid: session.sid,
            kind: session.kind,
            name: session.name,
            created_at: session.created_at,
            expires_at: session.expires_at,
            last_seen_at: session.last_seen_at,
            held_by_caller,
        }
    }
}

/// The `GET` method on `/browser-sessions`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    get(handle_list_browser_sessions)
}

/// `GET /authorization/browser-sessions` — every live browser session (neither revoked nor
/// expired), newest first, with the caller's own marked by the `sid` its token
/// carries. Acquired through [`LiveBrowserSessionsReader`] (scope
/// `wildflower/BrowserSession.r`); the caller's `sid` comes from its own
/// session through [`LiveSessionReader`].
async fn handle_list_browser_sessions(
    browser_sessions: Scoped<LiveBrowserSessionsReader>,
    caller: Authenticated<LiveSessionReader>,
) -> Result<Json<Vec<BrowserSessionBody>>, AuthorizationServerError> {
    Ok(Json(
        browser_sessions
            .list_live(caller.sid(), Utc::now())?
            .into_iter()
            .map(BrowserSessionBody::from)
            .collect(),
    ))
}
