use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::shared::{OAuthError, DEVICE_CODE_POLL_INTERVAL_SECS};
use crate::crypto::user_code::generate_user_code;
use crate::page_paths;
use crate::require_auth::AppState;
use crate::store::authorization_request::{RequestStatus, StartDeviceRequest};
use crate::time;

const DEVICE_AUTHORIZATION_TTL_SECS: i64 = 60 * 5;

#[derive(Debug, Deserialize)]
pub struct DeviceAuthorizationPayload {
    pub client_id: String,
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeviceAuthorizationResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
}

pub async fn handle(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let payload: DeviceAuthorizationPayload = match serde_urlencoded::from_str(&body) {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(OAuthError::new("invalid_request", Some("Malformed payload"))),
            )
                .into_response()
        }
    };
    let origin = state.origin.origin_for(&headers);
    let requested_scopes: Vec<String> = payload
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let client = match state.store.client_by_id(&payload.client_id) {
        Ok(Some(c)) if c.disabled_at.is_none() => c,
        Ok(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(OAuthError::new(
                    "invalid_client",
                    Some("Unknown or disabled client_id"),
                )),
            )
                .into_response()
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let allowed: std::collections::HashSet<&str> =
        client.allowed_scopes.iter().map(String::as_str).collect();
    if !requested_scopes.iter().all(|s| allowed.contains(s.as_str())) {
        return (
            StatusCode::BAD_REQUEST,
            Json(OAuthError::new(
                "invalid_scope",
                Some("Scope not allowed for client"),
            )),
        )
            .into_response();
    }
    let id = Uuid::new_v4().to_string();
    let user_code = match generate_unique_user_code(&state) {
        Ok(c) => c,
        Err(()) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let requested_at = time::now();
    let expires_at = time::add_seconds(requested_at, DEVICE_AUTHORIZATION_TTL_SECS);
    if state
        .store
        .start_device_authorization_request(StartDeviceRequest {
            request_id: id.clone(),
            client_id: payload.client_id.clone(),
            requested_scopes,
            user_code: user_code.clone(),
            requested_at: time::to_iso(requested_at),
            expires_at: time::to_iso(expires_at),
        })
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(DeviceAuthorizationResponse {
        device_code: id,
        user_code: user_code.clone(),
        verification_uri: page_paths::device_entry_url(&origin),
        verification_uri_complete: page_paths::device_entry_url_with_code(&origin, &user_code),
        expires_in: DEVICE_AUTHORIZATION_TTL_SECS,
        interval: DEVICE_CODE_POLL_INTERVAL_SECS,
    })
    .into_response()
}

fn generate_unique_user_code(state: &AppState) -> Result<String, ()> {
    for _ in 0..10 {
        let candidate = {
            let mut rng = rand::thread_rng();
            generate_user_code(&mut rng)
        };
        match state
            .store
            .authorization_request_by_user_code(&candidate)
        {
            Ok(None) => return Ok(candidate),
            Ok(Some(row)) if row.status != RequestStatus::Pending => return Ok(candidate),
            Ok(Some(_)) => continue,
            Err(_) => return Err(()),
        }
    }
    Err(())
}
