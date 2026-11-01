//! `GET /authorization/session-widenings/{id}`: a session widening's consent
//! prompt, for its card.

use axum::extract::Path;
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{Scoped, SessionWideningConsentView};
use crate::http::errors::SessionWideningNotFoundBody;
use crate::live_bindings::LiveConsentReader;

/// Body returned when the card loads a pending session widening: the browser
/// that asks, the app it asks for, and the scopes the Owner may grant, which
/// the Owner may only untick.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionWideningConsent {
    /// The widening's id, which approve and deny name.
    pub(crate) id: String,
    /// The name of the browser that asks: its session's.
    pub(crate) browser_name: String,
    /// The app whose request the browser's session fell short of.
    pub(crate) client_id: String,
    /// The app's registered name, or its `client_id` when it has no row.
    pub(crate) client_name: String,
    /// What the browser's session lacked of the app's request: the most the
    /// Owner may grant.
    pub(crate) requested_scopes: Vec<String>,
    /// The scopes the card's ticks start from: those of the requested ones
    /// the caller may pass on.
    pub(crate) starting_scopes: Vec<String>,
    /// The approval scopes the caller's own token lacks to approve the
    /// widening (`wildflower/AuthorizationRequest.u`). Empty when it may
    /// approve.
    pub(crate) missing_approval_scopes: Vec<String>,
}

/// `GET /authorization/session-widenings/{id}` — load a pending session
/// widening for its card (scope `wildflower/AuthorizationRequest.r`).
#[utoipa::path(
    get,
    tag = "Owner consent",
    path = "/session-widenings/{id}",
    params(("id" = String, Path, description = "The session widening's id")),
    responses(
        (status = 200, description = "The pending widening, for its card", body = SessionWideningConsent),
        (status = 404, description = "No pending widening has that id: unknown, decided or expired", body = SessionWideningNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_get_session_widening_consent(
    consents: Scoped<LiveConsentReader>,
    Path(id): Path<String>,
) -> Result<Json<SessionWideningConsent>, AuthorizationServerError> {
    let SessionWideningConsentView {
        request,
        client_name,
        starting_scopes,
        missing_approval_scopes,
    } = consents.session_widening_consent(&id, Utc::now())?;
    Ok(Json(SessionWideningConsent {
        id: request.id,
        browser_name: request.browser_name,
        client_id: request.client_id,
        client_name,
        requested_scopes: request.requested_scopes,
        starting_scopes,
        missing_approval_scopes,
    }))
}
