use anyhow::{anyhow, Context};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Duration;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::error_codes::OAuthErrorCode;
use super::internal::{
    require_valid_client_for_token, CacheSuppressed, OAuthError, TokenError,
    DEVICE_CODE_POLL_INTERVAL,
};
use super::openapi::DeviceAuthorizationRequest;
use super::token_request::TokenRequest;
use crate::crypto_util::oauth_user_code::generate_oauth_user_code;
use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::authorization_request::{AuthorizationRequest, StartDeviceAuthorizationArgs};
use crate::http::page_paths;
use crate::http::state::AppState;
use crate::http::ServedOrigin;

/// Lifetime of a device-flow authorization request — the user has this long
/// to enter their `user_code` before the flow expires.
const DEVICE_AUTHORIZATION_TTL: Duration = Duration::minutes(5);

/// How many random `user_code` candidates we try before giving up. Generous
/// because the alphabet/length make collisions astronomically rare.
const MAX_USER_CODE_GENERATION_ATTEMPTS: usize = 10;

/// Body of an RFC 8628 device authorization request. Client credentials are
/// not parsed here — RFC 8628 §3.1 inherits RFC 6749 §3.2.1 client
/// authentication, so [`resolve_client_credentials`] owns both the Basic
/// header and the body `client_id`/`client_secret` fields.
#[derive(Debug, Deserialize)]
pub struct DeviceAuthorizationPayload {
    pub scope: Option<String>,
}

/// Body returned by `/oauth/device_authorization` per RFC 8628 §3.2.
#[derive(Debug, Serialize, ToSchema)]
pub struct DeviceAuthorizationResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: i64,
    pub interval: i64,
}

impl IntoResponse for DeviceAuthorizationResponse {
    /// RFC 8628 §3.2 inherits RFC 6749 §5.1's no-store requirement —
    /// rendering through [`CacheSuppressed`] makes that unforgettable.
    fn into_response(self) -> Response {
        CacheSuppressed(Json(self)).into_response()
    }
}

/// Issue a `(device_code, user_code)` pair for the client to poll on while the
/// user pairs the device. `Ok` carries the §5.1 cache suppression via
/// [`DeviceAuthorizationResponse`], `Err` via [`TokenError`].
#[utoipa::path(
    post,
    path = "/device_authorization",
    request_body(content = DeviceAuthorizationRequest, content_type = "application/x-www-form-urlencoded"),
    responses(
        (status = 200, description = "Device + user code pair (RFC 8628 §3.2)", body = DeviceAuthorizationResponse),
        (status = 400, description = "OAuth error (RFC 6749 §5.2)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 6749 §5.2)", body = OAuthError)
    )
)]
pub(super) async fn handle_device_authorization_request(
    State(state): State<AppState>,
    origin: ServedOrigin,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Response {
    device_authorization(&state, &origin, request).into_response()
}

/// Validate the request, authenticate the client, and mint a
/// `(device_code, user_code)` pair, surfacing every failure as a [`TokenError`].
fn device_authorization(
    state: &AppState,
    origin: &ServedOrigin,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Result<DeviceAuthorizationResponse, TokenError> {
    let TokenRequest {
        payload,
        credentials: presented_credentials,
    } = request;
    let requested_scopes: Vec<String> = payload
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    // RFC 8628 §3.1 inherits RFC 6749 §3.2.1 client authentication, already
    // resolved by the `TokenRequest` extractor (Basic header first, body
    // fallback); confidential clients are verified here with a timing-safe
    // secret check, public clients pass through without a secret.
    let client = require_valid_client_for_token(&state.store, &presented_credentials)?;
    // Coverage-aware allowlist check, not exact string membership: a client
    // allowed a broad or v1 scope also admits a narrower or v2 request it
    // covers. Mirrors `authorize.rs::validate_requested_scopes` and the consent
    // path's `grantable_scopes`.
    if !requested_scopes.iter().all(|requested| {
        client
            .allowed_scopes
            .iter()
            .any(|allowed| scopes_rust::allowed_scope_covers(allowed, requested))
    }) {
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidScope,
            Some("Scope not allowed for client"),
        ));
    }
    // 256-bit CSPRNG opaque token per RFC 6749 §10.10, consistent with the
    // authorization_code minting in `authorize.rs`.
    let device_code = generate_authorization_code();
    let user_code = generate_unique_user_code(state)
        .map_err(|e| TokenError::internal("user_code generation failed", e))?;
    let request = AuthorizationRequest::new_device_authorization(StartDeviceAuthorizationArgs {
        id: device_code.clone(),
        client_id: presented_credentials.client_id.clone(),
        requested_scopes,
        user_code: user_code.clone(),
        ttl: DEVICE_AUTHORIZATION_TTL,
    });
    state
        .store
        .insert_authorization_request(&request)
        .map_err(|e| TokenError::internal("insert_authorization_request failed", e))?;
    // A fresh pending row may have just become the head of the
    // device-consent queue (it always does, unless an older
    // non-expired pending request still leads). Republish so the
    // host webview popup picks it up.
    state.republish_active_device_user_code();
    Ok(DeviceAuthorizationResponse {
        device_code,
        user_code: user_code.clone(),
        verification_uri: page_paths::device_entry_url(origin),
        verification_uri_complete: page_paths::device_entry_url_with_code(origin, &user_code),
        expires_in: DEVICE_AUTHORIZATION_TTL.num_seconds(),
        interval: DEVICE_CODE_POLL_INTERVAL.num_seconds(),
    })
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
            let mut rng = rand::rng();
            generate_oauth_user_code(&mut rng)
        };
        if state
            .store
            .authorization_request_by_user_code(&candidate)
            .context("authorization_request_by_user_code lookup failed")?
            .is_none()
        {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "exhausted {MAX_USER_CODE_GENERATION_ATTEMPTS} user_code generation attempts"
    ))
}
