use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::device_name_hint::device_name_from_user_agent;
use super::internal::TokenError;
use super::openapi::DeviceAuthorizationRequest;
use super::token_request::TokenRequest;
use crate::domain::capabilities::oauth::DeviceAuthorizationError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::page_paths;
use crate::http::extractors::Live;
use crate::http::wire_representations::{CacheSuppressed, OAuthError};
use crate::http::ServedOrigin;
use crate::live_bindings::LiveDeviceAuthorizer;

/// Body of an RFC 8628 device authorization request. Client credentials are
/// not parsed here — RFC 8628 §3.1 inherits RFC 6749 §3.2.1 client
/// authentication, so [`resolve_client_credentials`] owns both the Basic
/// header and the body `client_id`/`client_secret` fields.
#[derive(Debug, Deserialize)]
pub struct DeviceAuthorizationPayload {
    pub scope: Option<String>,
    /// Non-standard RFC 8628 extension: a human-chosen name for the device being paired,
    /// surfaced to the approver. Absent for strict RFC clients.
    pub device_name: Option<String>,
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
    tag = "OAuth 2.0",
    path = "/device_authorization",
    request_body(content = DeviceAuthorizationRequest, content_type = "application/x-www-form-urlencoded"),
    responses(
        (status = 200, description = "Device + user code pair (RFC 8628 §3.2)", body = DeviceAuthorizationResponse),
        (status = 400, description = "OAuth error (RFC 6749 §5.2)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 6749 §5.2)", body = OAuthError)
    )
)]
pub(super) async fn handle_device_authorization_request(
    authorizer: Live<LiveDeviceAuthorizer>,
    origin: ServedOrigin,
    headers: HeaderMap,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Response {
    // `HeaderMap` is a `FromRequestParts` extractor, so it must precede the
    // body-consuming `TokenRequest`.
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok());
    device_authorization(&authorizer, &origin, user_agent, request).into_response()
}

/// Parse the request, hand it to the [`LiveDeviceAuthorizer`], and frame the
/// RFC 8628 §3.2 response on this request's served origin, surfacing every
/// failure as a [`TokenError`].
fn device_authorization(
    authorizer: &LiveDeviceAuthorizer,
    origin: &ServedOrigin,
    user_agent: Option<&str>,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Result<DeviceAuthorizationResponse, TokenError> {
    let TokenRequest { payload, client } = request;
    let requested_scopes: Vec<String> = payload
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    // The name the approver sees and the grant is keyed on. Prefer the name the
    // client chose (normalizing an all-whitespace/empty name to `None`); when it
    // didn't name itself, infer a friendly one from its User-Agent. If neither
    // yields a name, approval falls back to the client name so the upsert key
    // stays total.
    let device_name = payload
        .device_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| user_agent.and_then(device_name_from_user_agent));
    let device_codes = authorizer
        .start(&client, requested_scopes, device_name)
        .map_err(|error| match error {
            DeviceAuthorizationError::ScopeNotAllowed => TokenError::bad_request(
                OAuthErrorCode::InvalidScope,
                Some("Scope not allowed for client"),
            ),
            DeviceAuthorizationError::UserCodeExhausted => TokenError::internal(
                "user_code generation failed",
                "exhausted every user_code generation attempt",
            ),
            DeviceAuthorizationError::Store(error) => TokenError::from(error),
        })?;
    Ok(DeviceAuthorizationResponse {
        device_code: device_codes.device_code,
        verification_uri: page_paths::device_entry_url(origin),
        verification_uri_complete: page_paths::device_entry_url_with_code(
            origin,
            &device_codes.user_code,
        ),
        user_code: device_codes.user_code,
        expires_in: device_codes.expires_in,
        interval: device_codes.interval,
    })
}
