use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::extensions::AppState;
use crate::store::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};

/// Body returned to the Owner UI when it loads a pending device-code consent
/// prompt — describes the requesting client and its requested scopes.
#[derive(Debug, Serialize)]
pub struct DeviceConsent {
    #[serde(rename = "userCode")]
    pub user_code: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "clientName")]
    pub client_name: String,
    #[serde(rename = "requestedScopes")]
    pub requested_scopes: Vec<String>,
}

/// Body posted by the Owner UI to approve a device-code consent prompt.
#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    #[serde(rename = "approvedScopes")]
    pub approved_scopes: Vec<String>,
}

/// Result the Owner UI sees after approving or denying a device-code consent.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConsentResult {
    Approved,
    Denied,
}

#[derive(Debug, Serialize)]
struct NotFound {
    error: &'static str,
    #[serde(rename = "userCode")]
    user_code: String,
}

pub fn router() -> Router {
    Router::new()
        .route("/devices/{userCode}", get(get_consent))
        .route("/devices/{userCode}/approve", post(approve_consent))
        .route("/devices/{userCode}/deny", post(deny_consent))
}

async fn get_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Response {
    let device_request = match load_pending_device_request(&state, &user_code) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    let client_name = match state.store.client_by_id(&device_request.client_id) {
        Ok(Some(c)) => c.name,
        // Fall back to the raw client_id if lookup misses or fails — the UI
        // still works, the operator just sees less context.
        _ => device_request.client_id.clone(),
    };
    Json(DeviceConsent {
        user_code,
        client_id: device_request.client_id,
        client_name,
        requested_scopes: device_request.requested_scopes.0,
    })
    .into_response()
}

async fn approve_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let device_request = match load_pending_device_request(&state, &user_code) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    let requested: HashSet<&str> = device_request
        .requested_scopes
        .iter()
        .map(String::as_str)
        .collect();
    let granted_scopes: Vec<String> = body
        .approved_scopes
        .into_iter()
        .filter(|s| requested.contains(s.as_str()))
        .collect();
    if granted_scopes.is_empty() {
        // No requested scopes were approved — treat as a deny.
        if let Err(e) = state.store.deny_authorization_request(&device_request.id) {
            return internal_error("deny_authorization_request failed", e);
        }
        return Json(ConsentResult::Denied).into_response();
    }
    if let Err(e) =
        state
            .store
            .approve_authorization_request(&device_request.id, &granted_scopes, None)
    {
        return internal_error("approve_authorization_request failed", e);
    }
    Json(ConsentResult::Approved).into_response()
}

async fn deny_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Response {
    let device_request = match load_pending_device_request(&state, &user_code) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    if let Err(e) = state.store.deny_authorization_request(&device_request.id) {
        return internal_error("deny_authorization_request failed", e);
    }
    Json(ConsentResult::Denied).into_response()
}

/// Load the authorization request for `user_code` and verify it's a pending
/// device-code flow. Returns a ready-to-use `Response` for "not found" or
/// "internal error" outcomes so each handler can `match` once and move on.
fn load_pending_device_request(
    state: &AppState,
    user_code: &str,
) -> Result<AuthorizationRequest, Box<Response>> {
    match state.store.authorization_request_by_user_code(user_code) {
        Ok(Some(r))
            if r.grant_type == GrantType::DeviceCode && r.status == RequestStatus::Pending =>
        {
            Ok(r)
        }
        Ok(_) => Err(Box::new(not_found(user_code))),
        Err(e) => Err(Box::new(internal_error(
            "authorization_request_by_user_code lookup failed",
            e,
        ))),
    }
}

fn not_found(user_code: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(NotFound {
            error: "DeviceConsentNotFound",
            user_code: user_code.to_string(),
        }),
    )
        .into_response()
}

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
