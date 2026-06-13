use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Serialize;

use super::error_codes;
use super::internal::{
    build_client_error_redirect_url, build_client_redirect_url, OAuthErrorResponse,
};
use crate::db_utils::UriColumn;
use crate::domain::authorization_request::RequestStatus;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// Polling response for the Owner UI watching an authorization request as it
/// moves from `Pending` toward approval or denial.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthorizationStatus {
    Pending,
    Denied {
        /// Client callback URL carrying `error=access_denied&state=...` for
        /// code-flow requests (RFC 6749 §4.1.2.1) so the polling page can
        /// complete the flow. Absent for device-flow denials, which have no
        /// client `redirect_uri`.
        #[serde(skip_serializing_if = "Option::is_none")]
        redirect: Option<String>,
    },
    Approved {
        redirect: String,
    },
    Error {
        message: String,
    },
}

impl IntoResponse for AuthorizationStatus {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}

/// `GET /oauth/authorize/{id}` route.
pub(super) fn route() -> MethodRouter<AppState> {
    get(handle_authorization_status_request)
}

/// Return the current status of the pending authorization request, including
/// the final redirect URL once approved.
///
/// The error side is `axum::response::ErrorResponse` because two error shapes
/// share the handler: the Owner-surface [`HandlerError`] (404/logged 500) and
/// the OAuth-shaped [`OAuthErrorResponse`] `server_error` — `?` converts
/// either through its `IntoResponse`.
async fn handle_authorization_status_request(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Result<AuthorizationStatus> {
    let request = state
        .store
        .authorization_request_by_id(&id)
        .map_err(|e| HandlerError::internal("authorization_request_by_id lookup failed", e))?
        .ok_or_else(|| HandlerError::not_found("AuthorizationRequestNotFound", "id", &id))?;
    // Nothing actively transitions code-flow requests from Pending to Expired,
    // so a Pending request past its TTL must be reported as expired here rather
    // than left polling forever.
    if request.status == RequestStatus::Pending && request.expires_at < Utc::now() {
        return Ok(AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        });
    }
    Ok(match request.status {
        RequestStatus::Pending => AuthorizationStatus::Pending,
        RequestStatus::Denied => {
            // Build the client callback so the user-agent waiting at the
            // client's redirect_uri receives `error=access_denied&state=...`
            // and stops hanging. Device-flow denials have no redirect_uri /
            // client_state, so they fall back to a bare `denied`.
            let redirect = match (&request.redirect_uri, &request.client_state) {
                (Some(UriColumn(redirect_uri)), Some(client_state)) => {
                    Some(build_client_error_redirect_url(
                        redirect_uri,
                        error_codes::ACCESS_DENIED,
                        client_state,
                    ))
                }
                _ => None,
            };
            AuthorizationStatus::Denied { redirect }
        }
        RequestStatus::Expired => AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        },
        RequestStatus::Approved => {
            let (Some(UriColumn(redirect_uri)), Some(client_state)) =
                (request.redirect_uri, request.client_state)
            else {
                return Err(OAuthErrorResponse::server_error(
                    "Authorization request is not a code-flow request",
                )
                .into());
            };
            let code = state
                .store
                .authorization_code_by_request_id(&id)
                .map_err(|e| {
                    HandlerError::internal("authorization_code_by_request_id lookup failed", e)
                })?
                .ok_or_else(|| OAuthErrorResponse::server_error("Authorization code missing"))?;
            AuthorizationStatus::Approved {
                redirect: build_client_redirect_url(&redirect_uri, &code.code, &client_state),
            }
        }
    })
}
