//! `POST /authorization/session-widenings/{id}/approve`: the Owner approves a
//! session widening on its card.

use std::sync::Arc;

use axum::extract::Path;
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::ConsentResult;
use crate::live_bindings::LiveConsentDecider;

/// `POST /authorization/session-widenings/{id}/approve` body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApproveSessionWideningBody {
    /// The scopes the Owner left ticked. They are clamped to what the browser
    /// asked for and to the approver's own grant; a scope beyond the
    /// approver's grant is a `403`, and nothing left to grant is a deny.
    approved_scopes: Vec<String>,
}

/// The `POST` method on `/session-widenings/{id}/approve`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    post(handle_approve_session_widening)
}

/// `POST /authorization/session-widenings/{id}/approve` — the Owner approves
/// a session widening, and the browser's session grows by what was granted.
/// Gated by [`LiveConsentDecider`] (scope
/// `wildflower/AuthorizationRequest.u`), which also carries the approver's
/// own scopes: granting a scope beyond them is a `403`.
async fn handle_approve_session_widening(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
    Json(body): Json<ApproveSessionWideningBody>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    let outcome = consents.approve_session_widening(&id, body.approved_scopes, Utc::now())?;
    Ok(Json(outcome.into()))
}
