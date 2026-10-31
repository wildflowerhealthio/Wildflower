//! `POST /authorization/session-widenings/{id}/approve`: the Owner approves a
//! session widening on its card.

use axum::extract::Path;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use utoipa::ToSchema;
use wildflowerhealthio_scope_capabilities::InsufficientScopeBody;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::SessionWideningNotFoundBody;
use crate::http::wire_representations::{ConsentResult, PolledConsentResult};
use crate::live_bindings::LiveConsentDecider;

/// `POST /authorization/session-widenings/{id}/approve` body.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApproveSessionWideningBody {
    /// The scopes the Owner left ticked. They are clamped to what the browser
    /// asked for and to the approver's own grant; a scope beyond the
    /// approver's grant is a `403`, and nothing left to grant is a deny.
    approved_scopes: Vec<String>,
}

/// `POST /authorization/session-widenings/{id}/approve` — the Owner approves
/// a session widening, and the browser's session grows by what was granted.
/// Gated by [`LiveConsentDecider`] (scope
/// `wildflower/AuthorizationRequest.u`), which also carries the approver's
/// own scopes: granting a scope beyond them is a `403`.
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/session-widenings/{id}/approve",
    params(("id" = String, Path, description = "The session widening's id")),
    request_body = ApproveSessionWideningBody,
    responses(
        (status = 200, description = "The widening is decided: `approved` when the session grew, `denied` when nothing was left to grant or the browser's session has ended", body = PolledConsentResult),
        (status = 403, description = "The caller's token lacks `wildflower/AuthorizationRequest.u`, or a ticked scope is beyond the approver's own grant; nothing is written", body = InsufficientScopeBody),
        (status = 404, description = "No pending widening has that id: unknown, decided or expired", body = SessionWideningNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_approve_session_widening(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
    Json(body): Json<ApproveSessionWideningBody>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    let outcome = consents.approve_session_widening(&id, body.approved_scopes, Utc::now())?;
    Ok(Json(outcome.into()))
}
