use anyhow::{anyhow, Context};
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Duration;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::internal::{
    cache_suppressed, require_valid_client_for_token, OAuthError, DEVICE_CODE_POLL_INTERVAL,
};
use crate::crypto_util::oauth_user_code::generate_oauth_user_code;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_request::{AuthorizationRequest, StartDeviceAuthorizationArgs};
use crate::http::page_paths;
use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

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
    /// Confidential-client secret. RFC 8628 §3.1 requires that RFC 6749 §3.2.1
    /// client authentication apply here; public clients omit it.
    pub client_secret: Option<String>,
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

/// `POST /oauth/device_authorization` route.
pub(super) fn route() -> MethodRouter {
    post(handle_device_authorization_request)
}

/// Issue a `(device_code, user_code)` pair for the client to poll on while the
/// user pairs the device.
async fn handle_device_authorization_request(
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
    let origin = served_origin_for(&headers, &state.loopback_origin);
    let origin = origin.as_str();
    let requested_scopes: Vec<String> = payload
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    // RFC 8628 §3.1: authenticate confidential clients exactly as the token
    // endpoint does (timing-safe secret check); public clients pass through
    // without a secret.
    let client = match require_valid_client_for_token(
        &state.store,
        &payload.client_id,
        payload.client_secret.as_deref(),
    ) {
        Ok(c) => c,
        Err(err) => return cache_suppressed(err.into_response()),
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
    // 256-bit CSPRNG opaque token per RFC 6749 §10.10, consistent with the
    // authorization_code minting in `authorize.rs`.
    let device_code = generate_authorization_code();
    let user_code = match generate_unique_user_code(&state) {
        Ok(c) => c,
        Err(e) => {
            return cache_suppressed(response_templates::internal_error(
                "user_code generation failed",
                e,
            ))
        }
    };
    let request = AuthorizationRequest::new_device_authorization(StartDeviceAuthorizationArgs {
        id: device_code.clone(),
        client_id: payload.client_id.clone(),
        requested_scopes,
        user_code: user_code.clone(),
        ttl: DEVICE_AUTHORIZATION_TTL,
    });
    if let Err(e) = state.store.insert_authorization_request(&request) {
        return cache_suppressed(response_templates::internal_error(
            "insert_authorization_request failed",
            e,
        ));
    }
    cache_suppressed(
        Json(DeviceAuthorizationResponse {
            device_code,
            user_code: user_code.clone(),
            verification_uri: page_paths::device_entry_url(origin),
            verification_uri_complete: page_paths::device_entry_url_with_code(origin, &user_code),
            expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
            interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
        })
        .into_response(),
    )
}

/// Try up to `MAX_USER_CODE_GENERATION_ATTEMPTS` random user codes until one
/// collides with *no* existing request. Returns an error that preserves cause
/// information for logging.
///
/// Any existing row — pending or terminal — counts as a collision: reusing a
/// `user_code` already attached to a denied/expired row lets that stale row
/// shadow the new pending request at the consent-side lookup (`user_code` is
/// not unique once reused), so we regenerate instead.
fn generate_unique_user_code(state: &AppState) -> anyhow::Result<String> {
    for _ in 0..MAX_USER_CODE_GENERATION_ATTEMPTS {
        let candidate = {
            let mut rng = rand::thread_rng();
            generate_oauth_user_code(&mut rng)
        };
        match state
            .store
            .authorization_request_by_user_code(&candidate)
            .context("authorization_request_by_user_code lookup failed")?
        {
            None => return Ok(candidate),
            Some(_) => continue,
        }
    }
    Err(anyhow!(
        "exhausted {MAX_USER_CODE_GENERATION_ATTEMPTS} user_code generation attempts"
    ))
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response {
    cache_suppressed((status, Json(OAuthError::new(error, Some(description)))).into_response())
}
