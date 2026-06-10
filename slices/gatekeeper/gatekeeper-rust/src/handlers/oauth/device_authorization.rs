use anyhow::{anyhow, Context};
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Duration;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

use super::shared::{OAuthError, DEVICE_CODE_POLL_INTERVAL};
use crate::crypto::user_code::generate_user_code;
use crate::extensions::AppState;
use crate::page_paths;
use crate::store::authorization_request::{AuthorizationRequest, NewDeviceFlow, RequestStatus};

/// Lifetime of a device-flow authorization request — the user has this long
/// to enter their `user_code` before the flow expires.
const DEVICE_AUTHORIZATION_TTL: Duration = Duration::minutes(5);

/// How many random `user_code` candidates we try before giving up. Generous
/// because the alphabet/length make collisions astronomically rare.
const MAX_USER_CODE_GENERATION_ATTEMPTS: usize = 10;

/// Body of an RFC 8628 device authorization request.
#[derive(Debug, Deserialize)]
pub struct DeviceAuthorizationPayload {
    pub client_id: String,
    pub scope: Option<String>,
}

/// Body returned by `/oauth/device_authorization` per RFC 8628 §3.2.
#[derive(Debug, Serialize)]
pub struct DeviceAuthorizationResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
}

/// `POST /oauth/device_authorization` — issue a `(device_code, user_code)`
/// pair for the client to poll on while the user pairs the device.
pub async fn handle_device_authorization_request(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let payload: DeviceAuthorizationPayload = match serde_urlencoded::from_str(&body) {
        Ok(p) => p,
        Err(_) => {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Malformed payload",
            )
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
            return oauth_error(
                StatusCode::UNAUTHORIZED,
                "invalid_client",
                "Unknown or disabled client_id",
            )
        }
        Err(e) => return internal_error("client_by_id lookup failed", e),
    };
    let allowed: HashSet<&str> = client.allowed_scopes.iter().map(String::as_str).collect();
    if !requested_scopes
        .iter()
        .all(|s| allowed.contains(s.as_str()))
    {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_scope",
            "Scope not allowed for client",
        );
    }
    let device_code = Uuid::new_v4().to_string();
    let user_code = match generate_unique_user_code(&state) {
        Ok(c) => c,
        Err(e) => return internal_error("user_code generation failed", e),
    };
    let request = AuthorizationRequest::new_device_flow(NewDeviceFlow {
        id: device_code.clone(),
        client_id: payload.client_id.clone(),
        requested_scopes,
        user_code: user_code.clone(),
        ttl: DEVICE_AUTHORIZATION_TTL,
    });
    if let Err(e) = state.store.insert_authorization_request(&request) {
        return internal_error("insert_authorization_request failed", e);
    }
    Json(DeviceAuthorizationResponse {
        device_code,
        user_code: user_code.clone(),
        verification_uri: page_paths::device_entry_url(&origin),
        verification_uri_complete: page_paths::device_entry_url_with_code(&origin, &user_code),
        expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
        interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
    })
    .into_response()
}

/// Try up to `MAX_USER_CODE_GENERATION_ATTEMPTS` random user codes until one
/// doesn't collide with an existing pending request. Returns an error that
/// preserves cause information for logging.
fn generate_unique_user_code(state: &AppState) -> anyhow::Result<String> {
    for _ in 0..MAX_USER_CODE_GENERATION_ATTEMPTS {
        let candidate = {
            let mut rng = rand::thread_rng();
            generate_user_code(&mut rng)
        };
        match state
            .store
            .authorization_request_by_user_code(&candidate)
            .context("authorization_request_by_user_code lookup failed")?
        {
            None => return Ok(candidate),
            Some(existing) if existing.status != RequestStatus::Pending => return Ok(candidate),
            Some(_) => continue,
        }
    }
    Err(anyhow!(
        "exhausted {MAX_USER_CODE_GENERATION_ATTEMPTS} user_code generation attempts"
    ))
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response {
    (status, Json(OAuthError::new(error, Some(description)))).into_response()
}

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
