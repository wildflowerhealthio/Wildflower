use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use url::Url;

use uuid::Uuid;

use super::internal::{
    cache_suppressed, issue_token_response, require_valid_client_for_token, IssueTokenInput,
    OAuthError, DEVICE_CODE_POLL_INTERVAL, OFFLINE_ACCESS_SCOPE, REFRESH_TOKEN_FAMILY_TTL,
};
use crate::crypto_util::pkce::{compute_code_challenge, is_valid_code_verifier_length};
use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::db::RefreshTokenConsumeOutcome;
use crate::db_utils::JsonColumn;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::http::response_templates;
use crate::http::served_origin_for;
use crate::http::state::AppState;

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
    /// Refresh-token grant — the client trades its live refresh token for a
    /// fresh access token plus the refresh token's successor (RFC 6749 §6).
    #[serde(rename = "refresh_token")]
    RefreshToken {
        client_id: String,
        client_secret: Option<String>,
        refresh_token: String,
    },
}

/// `POST /oauth/token` route.
pub(super) fn route() -> MethodRouter {
    post(handle_token_request)
}

/// Accept either grant type and either return a signed token response or an
/// OAuth error.
async fn handle_token_request(
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
        TokenPayload::RefreshToken {
            client_id,
            client_secret,
            refresh_token,
        } => exchange_refresh_token(
            &state,
            &origin,
            &client_id,
            client_secret.as_deref(),
            &refresh_token,
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
    if !is_valid_code_verifier_length(grant.code_verifier) {
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
        Err(e) => {
            return cache_suppressed(response_templates::internal_error(
                "authorization_code redemption failed",
                e,
            ))
        }
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
    if !bool::from(
        code_record
            .code_challenge
            .as_bytes()
            .ct_eq(computed.as_bytes()),
    ) {
        return bad_request("invalid_grant", Some("Invalid code_verifier parameter"));
    }
    let refresh_token = match start_refresh_token_family_if_granted(
        state,
        client_id,
        &code_record.granted_scopes,
        code_record.patient.as_deref(),
    ) {
        Ok(t) => t,
        Err(response) => return *response,
    };
    issue_token(
        state,
        IssueTokenInput {
            client_id,
            granted_scopes: &code_record.granted_scopes,
            patient: code_record.patient.as_deref(),
            origin,
        },
        refresh_token,
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
            return cache_suppressed(response_templates::internal_error(
                "authorization_request lookup failed",
                e,
            ))
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
            return cache_suppressed(response_templates::internal_error(
                "record_device_poll failed",
                e,
            ));
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
        return cache_suppressed(response_templates::internal_error(
            "expire_authorization_request failed",
            e,
        ));
    }
    let granted_scopes: &[String] = request_record
        .granted_scopes
        .as_deref()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let refresh_token = match start_refresh_token_family_if_granted(
        state,
        &request_record.client_id,
        granted_scopes,
        request_record.patient.as_deref(),
    ) {
        Ok(t) => t,
        Err(response) => return *response,
    };
    issue_token(
        state,
        IssueTokenInput {
            client_id: &request_record.client_id,
            granted_scopes,
            patient: request_record.patient.as_deref(),
            origin,
        },
        refresh_token,
    )
}

/// When the grant carries [`OFFLINE_ACCESS_SCOPE`], mint a new refresh-token
/// family with its first token and return the token's plaintext for the
/// response body. Grants without the scope get `Ok(None)` — no standing
/// credential is created. The error response is boxed to keep the `Result`
/// small (clippy::result_large_err), mirroring
/// `load_pending_authorization_code_request`.
fn start_refresh_token_family_if_granted(
    state: &AppState,
    client_id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
) -> Result<Option<String>, Box<Response>> {
    if !granted_scopes.iter().any(|s| s == OFFLINE_ACCESS_SCOPE) {
        return Ok(None);
    }
    let plaintext = generate_refresh_token();
    let now = Utc::now();
    let family = RefreshTokenFamily {
        family_id: Uuid::new_v4().to_string(),
        client_id: client_id.to_string(),
        scopes: JsonColumn(granted_scopes.to_vec()),
        patient: patient.map(str::to_string),
        issued_at: now,
        expires_at: now + REFRESH_TOKEN_FAMILY_TTL,
    };
    let first_token = RefreshToken {
        token_hash: token_storage_hash(&plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    if let Err(e) = state
        .store
        .insert_refresh_token_family(&family, &first_token)
    {
        return Err(Box::new(cache_suppressed(
            response_templates::internal_error("insert_refresh_token_family failed", e),
        )));
    }
    Ok(Some(plaintext))
}

/// Redeem a refresh token (RFC 6749 §6) with rotation semantics: the
/// presented token is consumed and its successor returned. Presenting an
/// already-consumed token is treated as theft — the whole family is revoked
/// (OAuth 2.1 refresh-token rotation).
fn exchange_refresh_token(
    state: &AppState,
    origin: &str,
    client_id: &str,
    client_secret: Option<&str>,
    presented: &str,
) -> Response {
    if let Err(err) = require_valid_client_for_token(&state.store, client_id, client_secret) {
        return cache_suppressed(err.into_response());
    }
    let hash = token_storage_hash(presented);
    let (_, family) = match state.store.refresh_token_with_family_by_hash(&hash) {
        Ok(Some(pair)) => pair,
        Ok(None) => return bad_request("invalid_grant", Some("Invalid refresh_token parameter")),
        Err(e) => {
            return cache_suppressed(response_templates::internal_error(
                "refresh_token lookup failed",
                e,
            ))
        }
    };
    // Token–client binding (RFC 6749 §6): a valid token presented by the
    // wrong client is a grant failure; answer exactly as if it didn't exist.
    // Checked before consuming so a stranger can't burn the rightful
    // client's live token.
    if family.client_id != client_id {
        return bad_request("invalid_grant", Some("Invalid refresh_token parameter"));
    }
    let now = Utc::now();
    // Covers both natural deadline passage and prior revocation — revoking
    // pulls `expires_at` back to the revocation instant rather than deleting
    // rows, so the lineage stays auditable.
    if family.expires_at <= now {
        return bad_request("invalid_grant", Some("Refresh token has expired"));
    }
    match state.store.consume_refresh_token(&hash, now) {
        Ok(RefreshTokenConsumeOutcome::Consumed) => {}
        // A consumed token can only reappear if it leaked (or the client is
        // badly broken) — also where a concurrent redeemer of the same
        // plaintext lands. Either way the lineage is unsafe: end the family
        // by expiring it at this instant.
        Ok(RefreshTokenConsumeOutcome::Replayed) => {
            if let Err(e) = state
                .store
                .expire_refresh_token_family(&family.family_id, now)
            {
                return cache_suppressed(response_templates::internal_error(
                    "expire_refresh_token_family failed",
                    e,
                ));
            }
            return bad_request("invalid_grant", Some("Refresh token has been revoked"));
        }
        // Vanished between lookup and consume — a failed decode, nothing
        // left to revoke.
        Ok(RefreshTokenConsumeOutcome::NotFound) => {
            return bad_request("invalid_grant", Some("Invalid refresh_token parameter"))
        }
        Err(e) => {
            return cache_suppressed(response_templates::internal_error(
                "consume_refresh_token failed",
                e,
            ))
        }
    }
    // Mint the successor in the same family — the family keeps the scopes
    // and the absolute deadline (rotation never extends its life).
    let next_plaintext = generate_refresh_token();
    let next = RefreshToken {
        token_hash: token_storage_hash(&next_plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    if let Err(e) = state.store.insert_refresh_token(&next) {
        return cache_suppressed(response_templates::internal_error(
            "insert_refresh_token failed",
            e,
        ));
    }
    issue_token(
        state,
        IssueTokenInput {
            client_id: &family.client_id,
            granted_scopes: &family.scopes,
            patient: family.patient.as_deref(),
            origin,
        },
        Some(next_plaintext),
    )
}

/// Mint a token for `input`, attach `refresh_token` (if the grant earned
/// one), and render it as a cache-suppressed JSON response, or a
/// cache-suppressed 500 if signing fails.
fn issue_token(
    state: &AppState,
    input: IssueTokenInput<'_>,
    refresh_token: Option<String>,
) -> Response {
    match issue_token_response(&state.store, input) {
        Ok(mut token) => {
            token.refresh_token = refresh_token;
            cache_suppressed(Json(token).into_response())
        }
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
