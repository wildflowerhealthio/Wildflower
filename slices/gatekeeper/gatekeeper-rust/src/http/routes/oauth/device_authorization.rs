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
use crate::domain::client_base_url::ClientBaseUrl;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::http::extractors::{Live, OwnerUiPages};
use crate::http::wire_representations::{CacheSuppressed, OAuthError};
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
    /// Wildflower extension: the served root of the owner UI copy starting the
    /// pairing, which a first-party client's `verification_uri`s resolve on —
    /// see [`crate::domain::client_base_url`].
    pub wildflower_client_base_url: Option<String>,
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
    pages: OwnerUiPages,
    headers: HeaderMap,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Response {
    // `HeaderMap` is a `FromRequestParts` extractor, so it must precede the
    // body-consuming `TokenRequest`.
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok());
    device_authorization(&authorizer, pages, user_agent, request).into_response()
}

/// Parse the request, hand it to the [`LiveDeviceAuthorizer`], and frame the
/// RFC 8628 §3.2 response with the hosted owner UI's verification pages, surfacing every
/// failure as a [`TokenError`].
fn device_authorization(
    authorizer: &LiveDeviceAuthorizer,
    pages: OwnerUiPages,
    user_agent: Option<&str>,
    request: TokenRequest<DeviceAuthorizationPayload>,
) -> Result<DeviceAuthorizationResponse, TokenError> {
    let TokenRequest {
        payload,
        authenticated_client,
    } = request;
    // Checked before a device code is issued, so a malformed value can't leave
    // a pending pairing behind.
    let client_base_url = ClientBaseUrl::parse_optional(
        payload.wildflower_client_base_url.as_deref(),
    )
    .map_err(|error| {
        TokenError::bad_request(OAuthErrorCode::InvalidRequest, Some(&error.to_string()))
    })?;
    let pages = pages.for_client(authenticated_client.client_id(), client_base_url);
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
        .start(&authenticated_client, requested_scopes, device_name)
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
        verification_uri: pages.device_entry_url(),
        verification_uri_complete: pages.device_entry_url_with_code(&device_codes.user_code),
        user_code: device_codes.user_code,
        expires_in: device_codes.expires_in,
        interval: device_codes.interval,
    })
}
