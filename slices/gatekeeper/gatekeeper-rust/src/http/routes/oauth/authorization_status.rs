use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use utoipa::ToSchema;

use super::internal::OAuthErrorResponse;
use super::openapi::AuthorizationRequestNotFound;
use crate::domain::capabilities::oauth::{AuthorizationStatusError, AuthorizationStatusView};
use crate::domain::client_redirect::{build_client_error_redirect_url, build_client_redirect_url};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::OAuthError;
use crate::live_bindings::LiveAuthorizationStatusReader;

/// Polling response for the Owner UI watching an authorization request as it
/// moves from `Pending` toward approval or denial.
#[derive(Debug, Serialize, ToSchema)]
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

/// Return the current status of the pending authorization request, including
/// the final redirect URL once approved.
///
/// The error side is `axum::response::ErrorResponse` because two error shapes
/// share the handler: the Owner-surface `GatekeeperError` (its
/// `AuthorizationRequestNotFound` 404 / logged 500) and the OAuth-shaped
/// `OAuthErrorResponse` `server_error` — `?` converts either through its
/// `IntoResponse`.
#[utoipa::path(
    get,
    tag = "OAuth 2.0",
    path = "/authorize/{id}",
    params(("id" = String, Path, description = "Authorization request id")),
    responses(
        (status = 200, description = "Current authorization-request status", body = AuthorizationStatus),
        (status = 404, description = "No authorization request with that id", body = AuthorizationRequestNotFound),
        (status = 500, description = "Server error (RFC 6749 §5.2)", body = OAuthError)
    )
)]
pub(super) async fn handle_authorization_status_request(
    State(state): State<Arc<GatekeeperState>>,
    Path(id): Path<String>,
) -> axum::response::Result<AuthorizationStatus> {
    let view = LiveAuthorizationStatusReader::from_state(&state)
        .status(&id, Utc::now())
        .map_err(|error| -> axum::response::ErrorResponse {
            match error {
                AuthorizationStatusError::NotFound { id } => {
                    GatekeeperError::AuthorizationRequestNotFound { id }.into()
                }
                AuthorizationStatusError::ApprovedWithoutRedirect => {
                    OAuthErrorResponse::server_error(
                        "Authorization request is not a code-flow request",
                    )
                    .into()
                }
                AuthorizationStatusError::ApprovedWithoutCode => {
                    OAuthErrorResponse::server_error("Authorization code missing").into()
                }
                AuthorizationStatusError::Store(error) => error.into(),
            }
        })?;
    Ok(match view {
        AuthorizationStatusView::Pending => AuthorizationStatus::Pending,
        AuthorizationStatusView::Expired => AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        },
        // Build the client callback so the user-agent waiting at the client's
        // redirect_uri receives `error=access_denied&state=...` and stops
        // hanging. Device-flow denials have no redirect_uri / client_state, so
        // they fall back to a bare `denied`.
        AuthorizationStatusView::Denied {
            redirect_uri,
            client_state,
        } => AuthorizationStatus::Denied {
            redirect: match (redirect_uri, client_state) {
                (Some(redirect_uri), Some(client_state)) => Some(build_client_error_redirect_url(
                    &redirect_uri,
                    OAuthErrorCode::AccessDenied,
                    &client_state,
                )),
                _ => None,
            },
        },
        AuthorizationStatusView::Approved {
            redirect_uri,
            code,
            client_state,
        } => AuthorizationStatus::Approved {
            redirect: build_client_redirect_url(&redirect_uri, &code, &client_state),
        },
    })
}
