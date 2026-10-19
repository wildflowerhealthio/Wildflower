use axum::extract::Path;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Serialize;
use utoipa::ToSchema;
use wildflowerhealthio_scope_capabilities::GrantedScopes as _;

use super::internal::OAuthErrorResponse;
use super::openapi::AuthorizationRequestNotFound;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::{
    AuthorizationStatusError, AuthorizationStatusView, PollingBrowserSession,
};
use crate::domain::client_redirect::{
    build_client_error_redirect_url, build_client_redirect_url, REQUEST_DECLINED_DESCRIPTION,
};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::http::browser_session_cookie::carried_browser_session;
use crate::http::errors::InternalError;
use crate::http::extractors::Live;
use crate::http::wire_representations::{CacheSuppressed, OAuthError};
use crate::live_bindings::{LiveAuthorizationStatusReader, LiveTokenVerifier};

/// Polling response for the wait page watching an authorization request as it
/// moves from `Pending` toward approval or denial.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AuthorizationStatus {
    Pending,
    Denied {
        /// Client callback URL carrying `error=access_denied`, an
        /// `error_description` and `state` for code-flow requests (RFC 6749
        /// §4.1.2.1) so the wait page can complete the flow. Absent for
        /// device-flow denials, which have no client `redirect_uri`.
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
    /// Rendered through [`CacheSuppressed`]: the `Approved` variant carries the
    /// client redirect with a redeemable authorization `code`, which no cache may
    /// retain. Every variant is suppressed so the poll's caching can't differ by
    /// state.
    fn into_response(self) -> Response {
        CacheSuppressed(Json(self)).into_response()
    }
}

/// Return the current status of the pending authorization request, including
/// the final redirect URL once approved. The caller's browser session (its
/// `__Host-browser_session` cookie) is answered when the request was made in
/// it, or when its grant covers `wildflower/AuthorizationRequest.r` and `.u`,
/// the scopes that decide the request on the consent card. Any other caller,
/// with another session or none, gets the same `404` as an unknown id, so a
/// leaked request id can't collect the code.
///
/// The error side is `axum::response::ErrorResponse` because two error shapes
/// share the handler: the Owner-surface `AuthorizationServerError` (its
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
        (status = 404, description = "No authorization request with that id the caller's browser session may read", body = AuthorizationRequestNotFound),
        (status = 500, description = "Server error (RFC 6749 §5.2)", body = OAuthError)
    )
)]
pub(super) async fn handle_authorization_status_request(
    reader: Live<LiveAuthorizationStatusReader>,
    token_verifier: Live<LiveTokenVerifier>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> axum::response::Result<AuthorizationStatus> {
    let polling_browser_session =
        carried_browser_session(&token_verifier, &headers).map_err(|error| {
            InternalError::new("verify a browser session at /oauth/authorize/{id}", error)
        })?;
    let poller = polling_browser_session.and_then(|claims| {
        let grant = claims.granted();
        claims.sid.map(|sid| PollingBrowserSession { sid, grant })
    });
    let view = reader.status(&id, poller.as_ref(), Utc::now()).map_err(
        |error| -> axum::response::ErrorResponse {
            match error {
                AuthorizationStatusError::NotFound { id } => {
                    AuthorizationServerError::AuthorizationRequestNotFound { id }.into()
                }
                AuthorizationStatusError::ApprovedWithoutCode => {
                    OAuthErrorResponse::server_error("Authorization code missing").into()
                }
                AuthorizationStatusError::Store(error) => error.into(),
            }
        },
    )?;
    Ok(match view {
        AuthorizationStatusView::Pending => AuthorizationStatus::Pending,
        AuthorizationStatusView::Expired => AuthorizationStatus::Error {
            message: "Authorization request expired".to_string(),
        },
        // Build the client callback so the user-agent waiting at the client's
        // redirect_uri receives `error=access_denied`, an `error_description`
        // and `state`, and stops hanging. The poll can't tell an Owner's
        // decline from a revoked browser session, so every denial reads as
        // declined.
        AuthorizationStatusView::Denied {
            redirect_uri,
            client_state,
        } => AuthorizationStatus::Denied {
            redirect: Some(build_client_error_redirect_url(
                &redirect_uri,
                OAuthErrorCode::AccessDenied,
                REQUEST_DECLINED_DESCRIPTION,
                &client_state,
            )),
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
