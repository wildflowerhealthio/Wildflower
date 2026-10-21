//! `POST /authorization/session-widenings/{id}/deny`: the Owner declines a
//! session widening on its card.

use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// The `POST` method on `/session-widenings/{id}/deny`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_deny_session_widening)
}

/// `POST /authorization/session-widenings/{id}/deny` — the Owner declines a
/// session widening, leaving the browser's session as it was (scope
/// `wildflower/AuthorizationRequest.u`).
async fn handle_deny_session_widening(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    consents.deny_session_widening(&id, Utc::now())?;
    Ok(Json(ConsentResult::Denied { redirect: None }))
}
