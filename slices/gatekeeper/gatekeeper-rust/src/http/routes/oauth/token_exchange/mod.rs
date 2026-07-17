use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use super::internal::{issue_token_response, IssueTokenInput, TokenError};
use super::openapi::TokenRequestBody;
use super::token_request::TokenRequest;
use crate::cookies;
use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily, REFRESH_TOKEN_FAMILY_TTL};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::{OAuthError, TokenResponse};
use crate::http::ServedOrigin;
use scopes_rust::KnownScope;

use authorization_code::exchange_authorization_code;
use device_code::exchange_device_code;
use refresh_token::exchange_refresh_token;

mod authorization_code;
mod device_code;
mod refresh_token;

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
    tag = "OAuth 2.0",
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
    State(state): State<Arc<GatekeeperState>>,
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
    state: &GatekeeperState,
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
    let is_first_party = presented_credentials.client_id == *state.first_party_client_id;
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

/// When the grant carries [`KnownScope::OfflineAccess`], mint a new refresh-token
/// family with its first token and return the token's plaintext for the
/// response body. Grants without the scope get `Ok(None)` — no standing
/// credential is created.
///
/// `grant_id` links the family to the durable [`Grant`](crate::domain::grant::Grant)
/// that authorized it (both flows) — write-only plumbing for a future
/// per-device revoke; `None` when no matching grant was resolved.
fn start_refresh_token_family_if_granted(
    state: &GatekeeperState,
    client_id: &str,
    granted_scopes: &[String],
    patient: Option<&str>,
    authorization_code: Option<&str>,
    grant_id: Option<&str>,
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
        scopes: granted_scopes.to_vec(),
        patient: patient.map(str::to_string),
        issued_at: now,
        expires_at: now + REFRESH_TOKEN_FAMILY_TTL,
        // Bind the family to the originating authorization code so a later
        // replay of that code can revoke this lineage (RFC 6749 §4.1.2). The
        // device-code grant carries no code and passes `None`.
        authorization_code_hash: authorization_code.map(token_storage_hash),
        grant_id: grant_id.map(str::to_string),
    };
    let first_token = RefreshToken {
        token_hash: token_storage_hash(&plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    crate::domain::refresh_token::insert_refresh_token_family(&state.store, &family, &first_token)?;
    Ok(Some(plaintext))
}

/// Mint a token for `input` and attach `refresh_token` (if the grant earned
/// one). A signing failure surfaces as a cache-suppressed 500 [`TokenError`].
fn issue_token(
    state: &GatekeeperState,
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
