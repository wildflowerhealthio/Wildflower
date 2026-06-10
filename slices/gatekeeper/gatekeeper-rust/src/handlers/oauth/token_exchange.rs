use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;

use super::shared::{
    issue_token_response, require_valid_client_for_token, IssueTokenInput, OAuthError,
    DEVICE_CODE_POLL_INTERVAL,
};
use crate::crypto::pkce::compute_code_challenge;
use crate::crypto::timing_safe::timing_safe_eq;
use crate::extensions::AppState;
use crate::store::authorization_code::AuthorizationCode;
use crate::store::authorization_request::{GrantType, RequestStatus};

/// Body of an RFC 6749 / RFC 8628 token endpoint request, dispatched by the
/// wire-level `grant_type` field.
#[derive(Debug, Deserialize)]
#[serde(tag = "grant_type")]
pub enum TokenPayload {
    /// Authorization-code grant — the client redeems a previously-issued
    /// `code` (RFC 6749 §4.1.3) along with the PKCE verifier.
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        client_id: String,
        client_secret: Option<String>,
        code: String,
        code_verifier: String,
        redirect_uri: String,
    },
    /// Device-code grant — the client polls with the `device_code` it was
    /// handed at `/device_authorization` (RFC 8628 §3.4).
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        client_id: String,
        client_secret: Option<String>,
        device_code: String,
    },
}

/// `POST /oauth/token` — accept either grant type and either return a signed
/// token response or an OAuth error.
pub async fn handle_token_request(
    Extension(state): Extension<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let payload: TokenPayload = match serde_urlencoded::from_str(&body) {
        Ok(p) => p,
        Err(_) => {
            return bad_request("invalid_request", Some("Malformed payload"));
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
        } => exchange_authorization_code(
            &state,
            &origin,
            &client_id,
            client_secret.as_deref(),
            &code,
            &code_verifier,
            &redirect_uri,
        ),
        TokenPayload::DeviceCode {
            client_id,
            client_secret,
            device_code,
        } => exchange_device_code(
            &state,
            &origin,
            &client_id,
            client_secret.as_deref(),
            &device_code,
        ),
    }
}

fn exchange_authorization_code(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return err.into_response();
    }
    let code_record = match state.store.authorization_code_by_code(code) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return bad_request("invalid_request", Some("Invalid code parameter"));
        }
        Err(e) => return internal_error("authorization_code lookup failed", e),
    };
    let response = validate_code_and_issue_token(
        state,
        origin,
        &code_record,
        client_id,
        redirect_uri,
        code_verifier,
    );
    // Whether valid or not, burn the code (replay protection).
    if let Err(e) = state.store.consume_authorization_code(&code_record.code) {
        // The token has already been minted (or rejected) at this point; we
        // can't undo it. Log and keep going.
        tracing::error!(error = %e, "failed to consume authorization_code after token exchange");
    }
    response
}

fn validate_code_and_issue_token(
    state: &AppState,
    origin: &str,
    code_record: &AuthorizationCode,
    client_id: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Response {
    if code_record.client_id != client_id {
        return bad_request("invalid_request", Some("Invalid client_id parameter"));
    }
    if code_record.redirect_uri != redirect_uri {
        return bad_request("invalid_request", Some("Invalid redirect_uri parameter"));
    }
    if code_record.expires_at < Utc::now() {
        return bad_request("invalid_request", Some("Code has expired"));
    }
    let computed = compute_code_challenge(code_verifier);
    if !timing_safe_eq(&code_record.code_challenge, &computed) {
        return bad_request("invalid_request", Some("Invalid code_verifier parameter"));
    }
    match issue_token_response(
        &state.store,
        IssueTokenInput {
            client_id,
            granted_scopes: &code_record.granted_scopes,
            patient: code_record.patient.as_deref(),
            origin,
        },
    ) {
        Ok(token) => Json(token).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
    }
}

fn exchange_device_code(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return err.into_response();
    }
    let request_record = match state.store.authorization_request_by_id(device_code) {
        Ok(Some(p)) if p.grant_type == GrantType::DeviceCode && p.client_id == client_id => p,
        Ok(_) => return bad_request("invalid_grant", Some("Unknown device_code")),
        Err(e) => return internal_error("authorization_request lookup failed", e),
    };
    if request_record.expires_at < Utc::now() {
        return bad_request("expired_token", None);
    }
    if request_record.status == RequestStatus::Pending {
        if let Some(last_polled) = request_record.last_polled_at {
            if Utc::now() - last_polled < DEVICE_CODE_POLL_INTERVAL {
                return bad_request("slow_down", None);
            }
        }
        if let Err(e) = state
            .store
            .record_device_poll(&request_record.id, Utc::now())
        {
            return internal_error("record_device_poll failed", e);
        }
    }
    match request_record.status {
        RequestStatus::Approved => {}
        RequestStatus::Pending => return bad_request("authorization_pending", None),
        RequestStatus::Denied => return bad_request("access_denied", None),
        RequestStatus::Expired => return bad_request("expired_token", None),
    }
    // single-use per RFC 8628 §3.4
    if let Err(e) = state.store.expire_authorization_request(&request_record.id) {
        return internal_error("expire_authorization_request failed", e);
    }
    let granted_scopes: &[String] = request_record
        .granted_scopes
        .as_deref()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    match issue_token_response(
        &state.store,
        IssueTokenInput {
            client_id: &request_record.client_id,
            granted_scopes,
            patient: request_record.patient.as_deref(),
            origin,
        },
    ) {
        Ok(token) => Json(token).into_response(),
        Err(err) => (StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response(),
    }
}

fn bad_request(error: &str, description: Option<&str>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(OAuthError::new(error, description)),
    )
        .into_response()
}

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
