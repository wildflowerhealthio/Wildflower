use axum::extract::State;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use subtle::ConstantTimeEq;
use url::Url;

use uuid::Uuid;

use super::client_auth::ClientCredentials;
use super::error_codes::OAuthErrorCode;
use super::internal::{
    issue_token_response, require_valid_client_for_token, IssueTokenInput, OAuthError, TokenError,
    TokenResponse, DEVICE_CODE_POLL_INTERVAL, REFRESH_TOKEN_FAMILY_TTL,
};
use super::openapi::TokenRequestBody;
use super::token_request::TokenRequest;
use crate::crypto_util::pkce::{compute_code_challenge, is_valid_code_verifier_length};
use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::db::RefreshTokenConsumeOutcome;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::client::AllowedGrantType;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
use crate::http::cookies;
use crate::http::state::AppState;
use crate::http::ServedOrigin;
use crate::FIRST_PARTY_CLIENT_ID;
use persistence_rust::JsonColumn;
use scopes_rust::KnownScope;

/// Body of an RFC 6749 / RFC 8628 token endpoint request, dispatched by the
/// wire-level `grant_type` field. Client credentials are not parsed here —
/// they may also arrive via the `Authorization: Basic` header, so
/// [`resolve_client_credentials`] owns both sources (any body
/// `client_id`/`client_secret` fields are simply ignored by this enum).
#[derive(Debug, Deserialize)]
#[serde(tag = "grant_type")]
pub enum TokenPayload {
    /// Authorization-code grant — the client redeems a previously-issued
    /// `code` (RFC 6749 §4.1.3) along with the PKCE verifier.
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        code: String,
        code_verifier: String,
        redirect_uri: String,
    },
    /// Device-code grant — the client polls with the `device_code` it was
    /// handed at `/device_authorization` (RFC 8628 §3.4).
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode { device_code: String },
    /// Refresh-token grant — the client trades its live refresh token for a
    /// fresh access token plus the refresh token's successor (RFC 6749 §6).
    #[serde(rename = "refresh_token")]
    RefreshToken { refresh_token: String },
}

/// Render the dispatch outcome — `Ok` carries the §5.1 cache suppression via
/// [`TokenResponse`], `Err` via [`TokenError`].
#[utoipa::path(
    post,
    path = "/token",
    request_body(content = TokenRequestBody, content_type = "application/x-www-form-urlencoded"),
    responses(
        (status = 200, description = "Successful token response (RFC 6749 §5.1)", body = TokenResponse),
        (status = 400, description = "OAuth error (RFC 6749 §5.2 / RFC 8628 §3.5)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 6749 §5.2)", body = OAuthError),
        (status = 500, description = "Server error (RFC 6749 §5.2)", body = OAuthError)
    )
)]
pub(super) async fn handle_token_request(
    State(state): State<AppState>,
    origin: ServedOrigin,
    request: TokenRequest<TokenPayload>,
) -> Response {
    // Whether to plant the owner-origin session cookie is a property of the
    // *resolved* grant (its authenticated client), never of the wire
    // `grant_type` — see [`DispatchedToken::plants_session_cookie`]. A
    // third-party app's grant (auth-code redemption, or a refresh of its own
    // lower-scoped token) must not overwrite the owner's `wf_auth`.
    match dispatch_token_request(&state, &origin, request) {
        Ok(DispatchedToken {
            response: token,
            plants_session_cookie: true,
        }) => {
            let max_age = token.expires_in;
            // The companion cookie carries the absolute `exp`; deriving it from
            // `expires_in` here (rather than re-reading the JWT) keeps the hint
            // and its `Max-Age` consistent. The companion is advisory, so the
            // sub-second skew vs the JWT's own `exp` (minted a moment earlier) is
            // immaterial.
            let exp_unix = Utc::now().timestamp() + max_age;
            let access_token = token.access_token.clone();
            let mut response = token.into_response();
            cookies::append_session_cookies(
                response.headers_mut(),
                &access_token,
                max_age,
                exp_unix,
                // `Secure` only over HTTPS: the direct-loopback web path is plain
                // http, where Safari would drop a `Secure` cookie. See #218.
                origin.starts_with("https://"),
            );
            response
        }
        Ok(DispatchedToken {
            response: token, ..
        }) => token.into_response(),
        Err(error) => error.into_response(),
    }
}

/// A minted token plus whether this grant should plant the owner-origin session
/// cookie (`wf_auth` + `wf_auth_exp`).
///
/// `plants_session_cookie` is `true` only for the **first-party owner client's**
/// (`FIRST_PARTY_CLIENT_ID`) session grants — the device-code login and its
/// refresh, the two ways the owner SPA establishes/renews its own web session.
/// It is deliberately keyed on the resolved grant's authenticated client, not on
/// the wire `grant_type`: a third-party SMART app also uses `refresh_token`, and
/// planting its (lower-scoped) token as `wf_auth` would silently downgrade or
/// force-logout the owner's session (a session-fixation vector). See #218.
struct DispatchedToken {
    response: TokenResponse,
    plants_session_cookie: bool,
}

/// Parse the grant, resolve client credentials, and dispatch on `grant_type`,
/// surfacing every failure as a [`TokenError`]. On success, tags the response
/// with whether the resolved grant plants the owner session cookie
/// ([`DispatchedToken::plants_session_cookie`]).
fn dispatch_token_request(
    state: &AppState,
    origin: &ServedOrigin,
    request: TokenRequest<TokenPayload>,
) -> Result<DispatchedToken, TokenError> {
    let TokenRequest {
        payload,
        credentials: presented_credentials,
    } = request;
    // Each exchange below validates that the presented client owns the grant it
    // redeems (the device request / refresh-token family), so after a successful
    // exchange `presented_credentials.client_id` IS the resolved, authenticated
    // client — the identity the cookie decision keys on.
    let is_first_party = presented_credentials.client_id == FIRST_PARTY_CLIENT_ID;
    match payload {
        TokenPayload::AuthorizationCode {
            code,
            code_verifier,
            redirect_uri,
        } => {
            let response = exchange_authorization_code(
                state,
                origin,
                &presented_credentials,
                &AuthorizationCodeGrant {
                    code: &code,
                    code_verifier: &code_verifier,
                    redirect_uri: &redirect_uri,
                },
            )?;
            // Auth-code redemption is the third-party SMART app path — never an
            // owner web session, so it never plants the cookie (the owner SPA
            // logs in via the device-code grant).
            Ok(DispatchedToken {
                response,
                plants_session_cookie: false,
            })
        }
        TokenPayload::DeviceCode { device_code } => {
            let response =
                exchange_device_code(state, origin, &presented_credentials, &device_code)?;
            Ok(DispatchedToken {
                response,
                plants_session_cookie: is_first_party,
            })
        }
        TokenPayload::RefreshToken { refresh_token } => {
            let response =
                exchange_refresh_token(state, origin, &presented_credentials, &refresh_token)?;
            Ok(DispatchedToken {
                response,
                plants_session_cookie: is_first_party,
            })
        }
    }
}

/// Destructured fields of the `authorization_code` grant request, bundled into
/// a named struct so the redemption helpers take one self-describing argument
/// instead of a run of same-typed `&str` positionals (a transposition hazard).
struct AuthorizationCodeGrant<'a> {
    code: &'a str,
    code_verifier: &'a str,
    redirect_uri: &'a str,
}

fn exchange_authorization_code(
    state: &AppState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    grant: &AuthorizationCodeGrant<'_>,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::AuthorizationCode)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    // RFC 7636 §4.1: the verifier is 43–128 chars. Reject out-of-range values
    // before hashing — an unusable verifier is a grant failure, not a
    // malformed request (RFC 6749 §5.2).
    if !is_valid_code_verifier_length(grant.code_verifier) {
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid code_verifier parameter"),
        ));
    }
    let parsed_redirect = Url::parse(grant.redirect_uri).map_err(|_| {
        TokenError::bad_request(
            OAuthErrorCode::InvalidRequest,
            Some("Invalid redirect_uri parameter"),
        )
    })?;
    // Atomically read-and-consume the code: a concurrent redemption of the
    // same code can only succeed once, so any racer past this point sees
    // `Ok(None)` and is rejected before a token is minted (RFC 6749 §10.5).
    let code_record = match state.store.redeem_authorization_code(grant.code) {
        Ok(Some(record)) => record,
        Ok(None) => {
            // The code is gone — either already redeemed or never issued. If a
            // prior redemption minted a refresh-token family from this code,
            // the reuse is a theft signal (RFC 6749 §4.1.2 / OAuth 2.1
            // §4.1.2.1): revoke that lineage. A code that never existed, or one
            // whose grant carried no `offline_access`, matches no family and
            // this is a no-op.
            state
                .store
                .expire_refresh_token_families_for_authorization_code(
                    &token_storage_hash(grant.code),
                    Utc::now(),
                )
                .map_err(|e| {
                    TokenError::internal(
                        "expire_refresh_token_families_for_authorization_code failed",
                        e,
                    )
                })?;
            // Consolidated under the generic `invalid_grant` response (C13);
            // log the specific reason for operator debuggability.
            tracing::warn!(
                "authorization_code grant rejected: code not found or already redeemed (possible replay)"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid authorization grant"),
            ));
        }
        Err(e) => {
            return Err(TokenError::internal(
                "authorization_code redemption failed",
                e,
            ))
        }
    };
    validate_code_and_issue_token(
        state,
        origin,
        &code_record,
        &presented_credentials.client_id,
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
) -> Result<TokenResponse, TokenError> {
    // RFC 6749 §5.2: code/redirect/client-binding and PKCE failures are all
    // `invalid_grant`. They share ONE generic description (C13) so the response
    // doesn't reveal which check failed — distinguishing "wrong client" from
    // "wrong redirect_uri" from "expired" from "bad PKCE verifier" would leak
    // facts about a code that may belong to another client. Each logs its
    // specific reason (no secrets — never the code, verifier, or challenge) so
    // the operator can still tell them apart.
    let invalid_grant = || {
        TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid authorization grant"),
        )
    };
    if code_record.client_id != client_id {
        tracing::warn!(
            code_client_id = %code_record.client_id,
            presented_client_id = %client_id,
            "authorization_code grant rejected: client_id does not match the code"
        );
        return Err(invalid_grant());
    }
    if code_record.redirect_uri.0 != *redirect_uri {
        tracing::warn!(
            code_redirect_uri = %code_record.redirect_uri.0,
            presented_redirect_uri = %redirect_uri,
            "authorization_code grant rejected: redirect_uri does not match the code"
        );
        return Err(invalid_grant());
    }
    if code_record.expires_at < Utc::now() {
        tracing::warn!(
            expires_at = %code_record.expires_at,
            "authorization_code grant rejected: code expired"
        );
        return Err(invalid_grant());
    }
    let computed = compute_code_challenge(code_verifier);
    if !bool::from(
        code_record
            .code_challenge
            .as_bytes()
            .ct_eq(computed.as_bytes()),
    ) {
        tracing::warn!(
            client_id = %client_id,
            "authorization_code grant rejected: PKCE code_verifier does not match code_challenge"
        );
        return Err(invalid_grant());
    }
    let refresh_token = start_refresh_token_family_if_granted(
        state,
        client_id,
        &code_record.granted_scopes,
        code_record.patient.as_deref(),
        Some(code_record.code.as_str()),
    )?;
    issue_token(
        state,
        &IssueTokenInput {
            client_id,
            granted_scopes: &code_record.granted_scopes,
            patient: code_record.patient.as_deref(),
            origin,
        },
        refresh_token,
    )
}

/// Map a device request's current status to its RFC 8628 §3.4/§3.5 poll
/// outcome: `Approved` lets the caller proceed, every other state is the
/// matching `bad_request` the polling client should see. This status read is
/// advisory only — the real single-use gate is the atomic
/// `consume_approved_authorization_request` claim the caller makes next.
fn ensure_device_request_approved(status: RequestStatus) -> Result<(), TokenError> {
    match status {
        RequestStatus::Approved => Ok(()),
        RequestStatus::Pending => Err(TokenError::bad_request(
            OAuthErrorCode::AuthorizationPending,
            None,
        )),
        RequestStatus::Denied => Err(TokenError::bad_request(OAuthErrorCode::AccessDenied, None)),
        RequestStatus::Expired => Err(TokenError::bad_request(OAuthErrorCode::ExpiredToken, None)),
    }
}

fn exchange_device_code(
    state: &AppState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    device_code: &str,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::DeviceCode)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    let request_record = match state.store.authorization_request_by_id(device_code) {
        Ok(Some(record))
            if record.grant_type == GrantType::DeviceCode
                && record.client_id == presented_credentials.client_id =>
        {
            record
        }
        Ok(_) => {
            // One response collapses "no such device_code", "wrong client", and
            // "not a device request"; log which (no device_code — it's a secret).
            tracing::warn!(
                presented_client_id = %presented_credentials.client_id,
                "device_code grant rejected: no matching pending/approved device request for this client"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Unknown device_code"),
            ));
        }
        Err(e) => {
            return Err(TokenError::internal(
                "authorization_request lookup failed",
                e,
            ))
        }
    };
    if request_record.expires_at < Utc::now() {
        return Err(TokenError::bad_request(OAuthErrorCode::ExpiredToken, None));
    }
    if request_record.status == RequestStatus::Pending {
        if let Some(last_polled) = request_record.last_polled_at {
            if Utc::now() - last_polled < DEVICE_CODE_POLL_INTERVAL {
                return Err(TokenError::bad_request(OAuthErrorCode::SlowDown, None));
            }
        }
        state
            .store
            .record_device_poll(&request_record.id, Utc::now())
            .map_err(|e| TokenError::internal("record_device_poll failed", e))?;
    }
    ensure_device_request_approved(request_record.status)?;
    // Single-use per RFC 8628 §3.4. The status read above is advisory; this
    // atomic `approved` → `expired` claim is the real gate, so two concurrent
    // polls of the same approved request can't both mint — the loser sees
    // `Ok(false)` and is rejected before any token (or refresh family) is
    // issued.
    match state
        .store
        .consume_approved_authorization_request(&request_record.id)
    {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!(
                client_id = %request_record.client_id,
                "device_code grant rejected: request already redeemed (lost the single-use race)"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Device code already redeemed"),
            ));
        }
        Err(e) => {
            return Err(TokenError::internal(
                "consume_approved_authorization_request failed",
                e,
            ))
        }
    }
    let granted_scopes: &[String] = request_record
        .granted_scopes
        .as_deref()
        .map_or(&[], Vec::as_slice);
    let refresh_token = start_refresh_token_family_if_granted(
        state,
        &request_record.client_id,
        granted_scopes,
        request_record.patient.as_deref(),
        // The device-code grant has no authorization code; its single-use is
        // enforced by `consume_approved_authorization_request` above.
        None,
    )?;
    issue_token(
        state,
        &IssueTokenInput {
            client_id: &request_record.client_id,
            granted_scopes,
            patient: request_record.patient.as_deref(),
            origin,
        },
        refresh_token,
    )
}

/// When the grant carries [`KnownScope::OfflineAccess`], mint a new refresh-token
/// family with its first token and return the token's plaintext for the
/// response body. Grants without the scope get `Ok(None)` — no standing
/// credential is created.
fn start_refresh_token_family_if_granted(
    state: &AppState,
    client_id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
    authorization_code: Option<&str>,
) -> Result<Option<String>, TokenError> {
    if !granted_scopes
        .iter()
        .any(|s| s == KnownScope::OfflineAccess.as_str())
    {
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
        // Bind the family to the originating authorization code so a later
        // replay of that code can revoke this lineage (RFC 6749 §4.1.2). The
        // device-code grant carries no code and passes `None`.
        authorization_code_hash: authorization_code.map(token_storage_hash),
    };
    let first_token = RefreshToken {
        token_hash: token_storage_hash(&plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    state
        .store
        .insert_refresh_token_family(&family, &first_token)
        .map_err(|e| TokenError::internal("insert_refresh_token_family failed", e))?;
    Ok(Some(plaintext))
}

/// Redeem a refresh token (RFC 6749 §6) with rotation semantics: the
/// presented token is consumed and its successor returned. Presenting an
/// already-consumed token is treated as theft — the whole family is revoked
/// (OAuth 2.1 refresh-token rotation).
fn exchange_refresh_token(
    state: &AppState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    presented_refresh_token: &str,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::RefreshToken)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    let hash = token_storage_hash(presented_refresh_token);
    let (_, family) = match state.store.refresh_token_with_family_by_hash(&hash) {
        Ok(Some(pair)) => pair,
        Ok(None) => {
            tracing::warn!("refresh_token grant rejected: token not found");
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid refresh_token parameter"),
            ));
        }
        Err(e) => return Err(TokenError::internal("refresh_token lookup failed", e)),
    };
    // Token–client binding (RFC 6749 §6): a valid token presented by the
    // wrong client is a grant failure; answer exactly as if it didn't exist.
    // Checked before consuming so a stranger can't burn the rightful
    // client's live token.
    if family.client_id != presented_credentials.client_id {
        // Deliberately answered exactly like "not found" (RFC 6749 §6) so a
        // stranger can't probe token validity; log the real reason.
        tracing::warn!(
            family_client_id = %family.client_id,
            presented_client_id = %presented_credentials.client_id,
            "refresh_token grant rejected: token belongs to a different client"
        );
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid refresh_token parameter"),
        ));
    }
    let now = Utc::now();
    // Covers both natural deadline passage and prior revocation — revoking
    // pulls `expires_at` back to the revocation instant rather than deleting
    // rows, so the lineage stays auditable.
    if family.expires_at <= now {
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Refresh token has expired"),
        ));
    }
    // Mint the access token BEFORE mutating any state: a signing failure then
    // returns 500 without burning the presented token, so the client can
    // safely retry. The family keeps its scopes and absolute deadline
    // (rotation never extends its life).
    let mut token = issue_token_response(
        &state.store,
        &IssueTokenInput {
            client_id: &family.client_id,
            granted_scopes: &family.scopes,
            patient: family.patient.as_deref(),
            origin,
        },
    )
    .map_err(TokenError::server_error)?;
    let next_plaintext = generate_refresh_token();
    let next = RefreshToken {
        token_hash: token_storage_hash(&next_plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    // Consume the presented token and persist its successor in one
    // transaction, so a crash or error can't burn the presented token while
    // leaving the family with no live successor (a permanent lockout).
    match state.store.rotate_refresh_token(&hash, &next, now) {
        Ok(RefreshTokenConsumeOutcome::Consumed) => {}
        // A consumed token can only reappear if it leaked (or the client is
        // badly broken) — also where a concurrent redeemer of the same
        // plaintext lands. Either way the lineage is unsafe: end the family
        // by expiring it at this instant.
        Ok(RefreshTokenConsumeOutcome::Replayed) => {
            tracing::warn!(
                family_id = %family.family_id,
                client_id = %family.client_id,
                "refresh_token grant rejected: replay of a consumed token — revoking the whole family (possible theft)"
            );
            state
                .store
                .expire_refresh_token_family(&family.family_id, now)
                .map_err(|e| TokenError::internal("expire_refresh_token_family failed", e))?;
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Refresh token has been revoked"),
            ));
        }
        // Vanished between lookup and rotate — a failed decode, nothing left
        // to revoke.
        Ok(RefreshTokenConsumeOutcome::NotFound) => {
            tracing::warn!(
                family_id = %family.family_id,
                "refresh_token grant rejected: token vanished between lookup and rotate"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid refresh_token parameter"),
            ));
        }
        Err(e) => return Err(TokenError::internal("rotate_refresh_token failed", e)),
    }
    token.refresh_token = Some(next_plaintext);
    Ok(token)
}

/// Mint a token for `input` and attach `refresh_token` (if the grant earned
/// one). A signing failure surfaces as a cache-suppressed 500 [`TokenError`].
fn issue_token(
    state: &AppState,
    input: &IssueTokenInput<'_>,
    refresh_token: Option<String>,
) -> Result<TokenResponse, TokenError> {
    let mut token = issue_token_response(&state.store, input).map_err(TokenError::server_error)?;
    token.refresh_token = refresh_token;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clients using `client_secret_post` keep their credentials in the form
    /// body; the grant enum no longer parses them, so it must tolerate the
    /// extra fields rather than reject the request.
    #[test]
    fn token_payload_tolerates_unparsed_client_credential_fields() {
        let payload: TokenPayload = serde_urlencoded::from_str(
            "grant_type=refresh_token&client_id=app&client_secret=s3cret&refresh_token=tok",
        )
        .expect("unknown fields are ignored");
        let TokenPayload::RefreshToken { refresh_token } = payload else {
            panic!("expected RefreshToken variant, got {payload:?}");
        };
        assert_eq!(refresh_token, "tok");
    }
}
