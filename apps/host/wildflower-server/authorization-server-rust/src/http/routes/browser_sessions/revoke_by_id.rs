//! `DELETE /authorization/browser-sessions/{sid}`: the Owner signs a browser
//! out, ending everything minted under its session.

use axum::extract::Path;
use axum::http::StatusCode;
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::BrowserSessionNotFoundBody;
use crate::live_bindings::LiveBrowserSessionsRevoker;

/// `DELETE /authorization/browser-sessions/{sid}` — revoke a browser session, which ends
/// everything minted under it: the browser's own token, and every access
/// token and refresh family an app it signed in to holds. The caller's own
/// session may be revoked, which signs that browser out. Acquired through
/// [`LiveBrowserSessionsRevoker`] (scope `wildflower/BrowserSession.d`).
#[utoipa::path(
    delete,
    tag = "Access management",
    path = "/browser-sessions/{sid}",
    params(("sid" = String, Path, description = "The browser session's id")),
    responses(
        (status = 204, description = "The session is revoked, with everything minted under it"),
        (status = 404, description = "No unrevoked browser session has that `sid`", body = BrowserSessionNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_revoke_browser_session(
    browser_sessions: Scoped<LiveBrowserSessionsRevoker>,
    Path(sid): Path<String>,
) -> Result<StatusCode, AuthorizationServerError> {
    browser_sessions.revoke(&sid, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
