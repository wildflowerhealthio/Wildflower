use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::shared::{
    issue_token_response, require_valid_client_for_token, IssueTokenInput, OAuthError,
    ValidateClientError, DEVICE_CODE_POLL_INTERVAL_SECS,
};
use crate::crypto::pkce::compute_code_challenge;
use crate::crypto::timing_safe::timing_safe_eq;
use crate::require_auth::AppState;
use crate::store::authorization_request::{GrantType, RequestStatus};
use crate::time;

#[derive(Debug, Deserialize)]
#[serde(tag = "grant_type")]
pub enum TokenPayload {
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        client_id: String,
        client_secret: Option<String>,
        code: String,
        code_verifier: String,
        redirect_uri: String,
    },
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        client_id: String,
        client_secret: Option<String>,
        device_code: String,
    },
}

pub async fn handle(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let payload: TokenPayload = match serde_urlencoded::from_str(&body) {
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
    match payload {
        TokenPayload::AuthorizationCode {
            client_id,
            client_secret,
            code,
            code_verifier,
            redirect_uri,
        } => {
            handle_authorization_code(
                &state,
                &origin,
                &client_id,
                client_secret.as_deref(),
                &code,
                &code_verifier,
                &redirect_uri,
            )
        }
        TokenPayload::DeviceCode {
            client_id,
            client_secret,
            device_code,
        } => {
            handle_device_code(
                &state,
                &origin,
                &client_id,
                client_secret.as_deref(),
                &device_code,
            )
        }
    }
}

fn handle_authorization_code(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return validate_client_error(err);
    }
    let issued = match state.store.authorization_code_by_code(code) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(OAuthError::new("invalid_request", Some("Invalid code parameter"))),
            )
                .into_response()
        }
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let response = validate_and_issue_code(state, origin, &issued, client_id, redirect_uri, code_verifier);
    // Whether valid or not, burn the code (replay protection).
    let _ = state.store.consume_authorization_code(&issued.code);
    response
}

fn validate_and_issue_code(
    state: &AppState,
    origin: &str,
    issued: &crate::store::authorization_code::AuthorizationCodeRow,
    client_id: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Response {
    if issued.client_id != client_id {
        return bad_request("invalid_request", "Invalid client_id parameter");
    }
    if issued.redirect_uri != redirect_uri {
        return bad_request("invalid_request", "Invalid redirect_uri parameter");
    }
    if let Some(expires) = time::from_iso(&issued.expires_at) {
        if expires < time::now() {
            return bad_request("invalid_request", "Code has expired");
        }
    } else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let computed = compute_code_challenge(code_verifier);
    if !timing_safe_eq(&issued.code_challenge, &computed) {
        return bad_request("invalid_request", "Invalid code_verifier parameter");
    }
    match issue_token_response(
        &state.store,
        IssueTokenInput {
            client_id,
            granted_scopes: &issued.granted_scopes,
            patient: issued.patient.as_deref(),
            origin,
        },
    )
    {
        Ok(token) => Json(token).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
    }
}

fn handle_device_code(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return validate_client_error(err);
    }
    let pending = match state.store.authorization_request_by_id(device_code) {
        Ok(Some(p))
            if p.grant_type == GrantType::DeviceCode && p.client_id == client_id =>
        {
            p
        }
        Ok(_) => return bad_request("invalid_grant", "Unknown device_code"),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if let Some(expires) = time::from_iso(&pending.expires_at) {
        if expires < time::now() {
            return bad_request_err("expired_token");
        }
    } else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if pending.status == RequestStatus::Pending {
        if let Some(last_polled_at) = pending.last_polled_at.as_deref() {
            if let Some(last) = time::from_iso(last_polled_at) {
                if (time::now() - last).num_seconds() < DEVICE_CODE_POLL_INTERVAL_SECS {
                    return bad_request_err("slow_down");
                }
            }
        }
        if state
            .store
            .record_device_poll(&pending.id, &time::to_iso(time::now()))
            .is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    match pending.status {
        RequestStatus::Approved => {}
        RequestStatus::Pending => return bad_request_err("authorization_pending"),
        RequestStatus::Denied => return bad_request_err("access_denied"),
        RequestStatus::Expired => return bad_request_err("expired_token"),
    }
    // single-use per RFC 8628 §3.4
    if state.store.expire_authorization_request(&pending.id).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let granted = pending.granted_scopes.unwrap_or_default();
    match issue_token_response(
        &state.store,
        IssueTokenInput {
            client_id: &pending.client_id,
            granted_scopes: &granted,
            patient: pending.patient.as_deref(),
            origin,
        },
    )
    {
        Ok(token) => Json(token).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
    }
}

fn validate_client_error(err: ValidateClientError) -> Response {
    match err {
        ValidateClientError::Unauthorized(e) => (StatusCode::UNAUTHORIZED, Json(e)).into_response(),
        ValidateClientError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(e)).into_response(),
    }
}

fn bad_request(error: &str, description: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(OAuthError::new(error, Some(description))),
    )
        .into_response()
}

fn bad_request_err(error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(OAuthError::new(error, None)),
    )
        .into_response()
}
