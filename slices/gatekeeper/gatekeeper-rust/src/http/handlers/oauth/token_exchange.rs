use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use url::Url;

use super::shared::{
    cache_suppressed, issue_token_response, require_valid_client_for_token, IssueTokenInput,
    OAuthError, DEVICE_CODE_POLL_INTERVAL,
};
use crate::crypto_util::pkce::compute_code_challenge;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::http::served_origin_for;
use crate::http::responses::internal_error;
use crate::http::state::AppState;

/// RFC 7636 §4.1 bounds on the `code_verifier`: 43–128 characters drawn from
/// the unreserved set. We enforce the length here before hashing.
const CODE_VERIFIER_MIN_LEN: usize = 43;
const CODE_VERIFIER_MAX_LEN: usize = 128;

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
    let origin = served_origin_for(&headers, &state.loopback_origin);
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
            AuthorizationCodeGrant {
                client_id: &client_id,
                client_secret: client_secret.as_deref(),
                code: &code,
                code_verifier: &code_verifier,
                redirect_uri: &redirect_uri,
            },
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

/// Destructured fields of the `authorization_code` grant request, bundled into
/// a named struct so the redemption helpers take one self-describing argument
/// instead of a run of same-typed `&str` positionals (a transposition hazard).
struct AuthorizationCodeGrant<'a> {
    client_id: &'a str,
    client_secret: Option<&'a str>,
    code: &'a str,
    code_verifier: &'a str,
    redirect_uri: &'a str,
}

fn exchange_authorization_code(
    state: &AppState,
    origin: &str,
    grant: AuthorizationCodeGrant<'_>,
) -> Response {
    if let Err(err) =
        require_valid_client_for_token(&state.store, grant.client_id, grant.client_secret)
    {
        return cache_suppressed(err.into_response());
    }
    // RFC 7636 §4.1: the verifier is 43–128 chars. Reject out-of-range values
    // before hashing — an unusable verifier is a grant failure, not a
    // malformed request (RFC 6749 §5.2).
    let verifier_len = grant.code_verifier.chars().count();
    if !(CODE_VERIFIER_MIN_LEN..=CODE_VERIFIER_MAX_LEN).contains(&verifier_len) {
        return bad_request("invalid_grant", Some("Invalid code_verifier parameter"));
    }
    let parsed_redirect = match Url::parse(grant.redirect_uri) {
        Ok(u) => u,
        Err(_) => return bad_request("invalid_request", Some("Invalid redirect_uri parameter")),
    };
    // Atomically read-and-consume the code: a concurrent redemption of the
    // same code can only succeed once, so any racer past this point sees
    // `Ok(None)` and is rejected before a token is minted (RFC 6749 §10.5).
    let code_record = match state.store.redeem_authorization_code(grant.code) {
        Ok(Some(r)) => r,
        Ok(None) => {
            return bad_request("invalid_grant", Some("Invalid code parameter"));
        }
        Err(e) => return cache_suppressed(internal_error("authorization_code redemption failed", e)),
    };
    validate_code_and_issue_token(
        state,
        origin,
        &code_record,
        grant.client_id,
        &parsed_redirect,
        grant.code_verifier,
    )
}

fn validate_code_and_issue_token(
    state: &AppState,
    origin: &str,
    code_record: &AuthorizationCode,
    client_id: &str,
    redirect_uri: &Url,
    code_verifier: &str,
) -> Response {
    // RFC 6749 §5.2: code/redirect/client-binding and PKCE failures are all
    // `invalid_grant` — the request is well-formed, the grant is not.
    if code_record.client_id != client_id {
        return bad_request("invalid_grant", Some("Invalid client_id parameter"));
    }
    if code_record.redirect_uri.0 != *redirect_uri {
        return bad_request("invalid_grant", Some("Invalid redirect_uri parameter"));
    }
    if code_record.expires_at < Utc::now() {
        return bad_request("invalid_grant", Some("Code has expired"));
    }
    let computed = compute_code_challenge(code_verifier);
    if !bool::from(code_record.code_challenge.as_bytes().ct_eq(computed.as_bytes())) {
        return bad_request("invalid_grant", Some("Invalid code_verifier parameter"));
    }
    issue_token(
        state,
        IssueTokenInput {
            client_id,
            granted_scopes: &code_record.granted_scopes,
            patient: code_record.patient.as_deref(),
            origin,
        },
    )
}

fn exchange_device_code(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    device_code: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return cache_suppressed(err.into_response());
    }
    let request_record = match state.store.authorization_request_by_id(device_code) {
        Ok(Some(p)) if p.grant_type == GrantType::DeviceCode && p.client_id == client_id => p,
        Ok(_) => return bad_request("invalid_grant", Some("Unknown device_code")),
        Err(e) => {
            return cache_suppressed(internal_error("authorization_request lookup failed", e))
        }
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
            return cache_suppressed(internal_error("record_device_poll failed", e));
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
        return cache_suppressed(internal_error("expire_authorization_request failed", e));
    }
    let granted_scopes: &[String] = request_record
        .granted_scopes
        .as_deref()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    issue_token(
        state,
        IssueTokenInput {
            client_id: &request_record.client_id,
            granted_scopes,
            patient: request_record.patient.as_deref(),
            origin,
        },
    )
}

/// Mint a token for `input` and render it as a cache-suppressed JSON response,
/// or a cache-suppressed 500 if signing fails.
fn issue_token(state: &AppState, input: IssueTokenInput<'_>) -> Response {
    match issue_token_response(&state.store, input) {
        Ok(token) => cache_suppressed(Json(token).into_response()),
        Err(err) => {
            cache_suppressed((StatusCode::INTERNAL_SERVER_ERROR, Json(err)).into_response())
        }
    }
}

fn bad_request(error: &str, description: Option<&str>) -> Response {
    cache_suppressed(
        (
            StatusCode::BAD_REQUEST,
            Json(OAuthError::new(error, description)),
        )
            .into_response(),
    )
}
