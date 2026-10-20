//! `DELETE /authorization/browser-sessions/{sid}`: the Owner signs a browser
//! out, ending everything minted under its session.

use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveBrowserSessionsRevoker;

/// The `DELETE` method on `/browser-sessions/{sid}`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    delete(handle_revoke_browser_session)
}

/// `DELETE /authorization/browser-sessions/{sid}` — revoke a browser session, which ends
/// everything minted under it: the browser's own token, and every access
/// token and refresh family an app it signed in to holds. The caller's own
/// session may be revoked, which signs that browser out. Acquired through
/// [`LiveBrowserSessionsRevoker`] (scope `wildflower/BrowserSession.d`).
async fn handle_revoke_browser_session(
    browser_sessions: Scoped<LiveBrowserSessionsRevoker>,
    Path(sid): Path<String>,
) -> Result<StatusCode, AuthorizationServerError> {
    browser_sessions.revoke(&sid, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
