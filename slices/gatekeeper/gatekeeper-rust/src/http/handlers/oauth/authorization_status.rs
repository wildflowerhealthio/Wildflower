use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::shared::{build_client_redirect_url, OAuthError};
use crate::domain::authorization_request::RequestStatus;
use crate::http::state::AppState;
use crate::db_utils::UriColumn;

/// Polling response for the Owner UI watching an authorization request as it
/// moves from `Pending` toward approval or denial.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthorizationStatus {
    Pending,
    Denied,
    Approved { redirect: String },
    Error { message: String },
}

#[derive(Debug, Serialize)]
pub struct NotFound {
    pub error: &'static str,
    pub id: String,
}

/// `GET /oauth/authorize/{id}` — return the current status of the pending
/// authorization request, including the final redirect URL once approved.
pub async fn handle_authorization_status_request(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
) -> Response {
    let request = match state.store.authorization_request_by_id(&id) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(NotFound {
                    error: "AuthorizationRequestNotFound",
                    id,
                }),
            )
                .into_response()
        }
        Err(e) => return internal_error("authorization_request_by_id lookup failed", e),
    };
    match request.status {
        RequestStatus::Pending => Json(AuthorizationStatus::Pending).into_response(),
        RequestStatus::Denied => Json(AuthorizationStatus::Denied).into_response(),
        RequestStatus::Expired => Json(AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        })
        .into_response(),
        RequestStatus::Approved => {
            let (UriColumn(redirect_uri), client_state) =
                match (request.redirect_uri, request.client_state) {
                    (Some(r), Some(s)) => (r, s),
                    _ => {
                        return oauth_internal_error(
                            "Authorization request is not a code-flow request",
                        )
                    }
                };
            let code = match state.store.authorization_code_by_request_id(&id) {
                Ok(Some(c)) => c,
                Ok(None) => return oauth_internal_error("Authorization code missing"),
                Err(e) => {
                    return internal_error("authorization_code_by_request_id lookup failed", e)
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

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
