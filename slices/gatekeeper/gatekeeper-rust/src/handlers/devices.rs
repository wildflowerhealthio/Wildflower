use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::require_auth::AppState;
use crate::store::authorization_request::{GrantType, RequestStatus};

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

#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    #[serde(rename = "approvedScopes")]
    pub approved_scopes: Vec<String>,
}

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
    let pending = match state.store.authorization_request_by_user_code(&user_code) {
        Ok(Some(r))
            if r.grant_type == GrantType::DeviceCode && r.status == RequestStatus::Pending =>
        {
            r
        }
        Ok(_) => return not_found(&user_code),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let client_name = match state.store.client_by_id(&pending.client_id) {
        Ok(Some(c)) => c.name,
        _ => pending.client_id.clone(),
    };
    Json(DeviceConsent {
        user_code,
        client_id: pending.client_id,
        client_name,
        requested_scopes: pending.requested_scopes,
    })
    .into_response()
}

async fn approve_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let pending = match state.store.authorization_request_by_user_code(&user_code) {
        Ok(Some(r))
            if r.grant_type == GrantType::DeviceCode && r.status == RequestStatus::Pending =>
        {
            r
        }
        Ok(_) => return not_found(&user_code),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let requested: std::collections::HashSet<&str> =
        pending.requested_scopes.iter().map(String::as_str).collect();
    let granted: Vec<String> = body
        .approved_scopes
        .into_iter()
        .filter(|s| requested.contains(s.as_str()))
        .collect();
    if granted.is_empty() {
        if state.store.deny_authorization_request(&pending.id).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        return Json(ConsentResult::Denied).into_response();
    }
    if state
        .store
        .approve_authorization_request(&pending.id, &granted, None)
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(ConsentResult::Approved).into_response()
}

async fn deny_consent(
    Extension(state): Extension<AppState>,
    Path(user_code): Path<String>,
) -> Response {
    let pending = match state.store.authorization_request_by_user_code(&user_code) {
        Ok(Some(r))
            if r.grant_type == GrantType::DeviceCode && r.status == RequestStatus::Pending =>
        {
            r
        }
        Ok(_) => return not_found(&user_code),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if state.store.deny_authorization_request(&pending.id).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(ConsentResult::Denied).into_response()
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
