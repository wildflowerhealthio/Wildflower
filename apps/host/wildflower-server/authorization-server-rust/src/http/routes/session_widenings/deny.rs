//! `POST /authorization/session-widenings/{id}/deny`: the Owner declines a
//! session widening on its card.

use axum::extract::Path;
use axum::Json;
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::SessionWideningNotFoundBody;
use crate::http::wire_representations::{ConsentResult, PolledConsentResult};
use crate::live_bindings::LiveConsentDecider;

/// `POST /authorization/session-widenings/{id}/deny` — the Owner declines a
/// session widening, leaving the browser's session as it was (scope
/// `wildflower/AuthorizationRequest.u`).
#[utoipa::path(
    post,
    tag = "Owner consent",
    path = "/session-widenings/{id}/deny",
    params(("id" = String, Path, description = "The session widening's id")),
    responses(
        (status = 200, description = "The widening is declined: always `denied`", body = PolledConsentResult),
        (status = 404, description = "No pending widening has that id: unknown, decided or expired", body = SessionWideningNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_deny_session_widening(
    consents: Scoped<LiveConsentDecider>,
    Path(id): Path<String>,
) -> Result<Json<ConsentResult>, AuthorizationServerError> {
    consents.deny_session_widening(&id, Utc::now())?;
    Ok(Json(ConsentResult::Denied { redirect: None }))
}
