use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use super::shared::{build_client_redirect_url, OAuthError};
use crate::require_auth::AppState;
use crate::store::authorization_request::RequestStatus;

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

pub async fn handle(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    let request = match state.store.authorization_request_by_id(&id).await {
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
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    match request.status {
        RequestStatus::Pending => Json(AuthorizationStatus::Pending).into_response(),
        RequestStatus::Denied => Json(AuthorizationStatus::Denied).into_response(),
        RequestStatus::Expired => Json(AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        })
        .into_response(),
        RequestStatus::Approved => {
            let (redirect_uri, client_state) = match (request.redirect_uri, request.client_state) {
                (Some(r), Some(s)) => (r, s),
                _ => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(OAuthError::new(
                            "server_error",
                            Some("Authorization request is not a code-flow request"),
                        )),
                    )
                        .into_response()
                }
            };
            let code = match state.store.authorization_code_by_request_id(&id).await {
                Ok(Some(c)) => c,
                Ok(None) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(OAuthError::new("server_error", Some("Authorization code missing"))),
                    )
                        .into_response()
                }
                Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            };
            Json(AuthorizationStatus::Approved {
                redirect: build_client_redirect_url(&redirect_uri, &code.code, &client_state),
            })
            .into_response()
        }
    }
}
