use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Serialize;

use super::internal::{build_client_error_redirect_url, build_client_redirect_url, OAuthError};
use crate::db_utils::UriColumn;
use crate::domain::authorization_request::RequestStatus;
use crate::http::response_templates;
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

/// `GET /oauth/authorize/{id}` route.
pub(super) fn route() -> MethodRouter {
    get(handle_authorization_status_request)
}

/// Return the current status of the pending authorization request, including
/// the final redirect URL once approved.
async fn handle_authorization_status_request(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Response {
    let request = match state.store.authorization_request_by_id(&id) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return response_templates::not_found("AuthorizationRequestNotFound", "id", &id)
        }
        Err(e) => {
            return response_templates::internal_error(
                "authorization_request_by_id lookup failed",
                e,
            )
        }
    };
    // Nothing actively transitions code-flow requests from Pending to Expired,
    // so a Pending request past its TTL must be reported as expired here rather
    // than left polling forever.
    if request.status == RequestStatus::Pending && request.expires_at < Utc::now() {
        return Json(AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        })
        .into_response();
    }
    match request.status {
        RequestStatus::Pending => Json(AuthorizationStatus::Pending).into_response(),
        RequestStatus::Denied => {
            // Build the client callback so the user-agent waiting at the
            // client's redirect_uri receives `error=access_denied&state=...`
            // and stops hanging. Device-flow denials have no redirect_uri /
            // client_state, so they fall back to a bare `denied`.
            let redirect = match (&request.redirect_uri, &request.client_state) {
                (Some(UriColumn(redirect_uri)), Some(client_state)) => Some(
                    build_client_error_redirect_url(redirect_uri, "access_denied", client_state),
                ),
                _ => None,
            };
            Json(AuthorizationStatus::Denied { redirect }).into_response()
        }
        RequestStatus::Expired => Json(AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        })
        .into_response(),
        RequestStatus::Approved => {
            let (Some(UriColumn(redirect_uri)), Some(client_state)) =
                (request.redirect_uri, request.client_state)
            else {
                return oauth_internal_error("Authorization request is not a code-flow request");
            };
            let code = match state.store.authorization_code_by_request_id(&id) {
                Ok(Some(c)) => c,
                Ok(None) => return oauth_internal_error("Authorization code missing"),
                Err(e) => {
                    return response_templates::internal_error(
                        "authorization_code_by_request_id lookup failed",
                        e,
                    )
                }
            };
            Json(AuthorizationStatus::Approved {
                redirect: build_client_redirect_url(&redirect_uri, &code.code, &client_state),
            })
            .into_response()
        }
    }
}

fn oauth_internal_error(description: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(OAuthError::new("server_error", Some(description))),
    )
        .into_response()
}
