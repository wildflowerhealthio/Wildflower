//! `POST /oauth/token`: an app's back end trades an authorization code, a
//! device code or a refresh token for tokens.

use axum::response::{IntoResponse, Response};
use chrono::Utc;
use serde::Deserialize;

use super::internal::TokenError;
use super::openapi::TokenRequestBody;
use super::token_request::TokenRequest;
use crate::domain::authority::PresentedAuthorizationCode;
use crate::domain::capabilities::oauth::IssuedTokens;
use crate::http::extractors::Live;
use crate::http::wire_representations::{OAuthError, TokenResponse};
use crate::live_bindings::LiveTokenExchanger;

/// Body of an RFC 6749 / RFC 8628 token endpoint request, dispatched by the
/// wire-level `grant_type` field. Client credentials are not parsed here —
/// they may also arrive via the `Authorization: Basic` header, so the
/// [`TokenRequest`] extractor owns both sources (any body
/// `client_id`/`client_secret` fields are simply ignored by this enum).
#[derive(Debug, Deserialize)]
#[serde(tag = "grant_type")]
pub enum TokenPayload {
    /// Authorization-code grant — the client redeems a previously-issued
    /// `code` (RFC 6749 §4.1.3) along with the PKCE verifier.
    #[serde(rename = "authorization_code")]
    AuthorizationCode {
        /// The code `/oauth/authorize` sent to the client's redirect; it is
        /// redeemable once, by the client it was issued to.
        code: String,
        /// The PKCE verifier whose S256 hash is the request's
        /// `code_challenge` (RFC 7636 §4.5).
        code_verifier: String,
        /// Must be the `redirect_uri` the authorization request named
        /// (RFC 6749 §4.1.3).
        redirect_uri: String,
    },
    /// Device-code grant — the client polls with the `device_code` it was
    /// handed at `/device_authorization` (RFC 8628 §3.4).
    #[serde(rename = "urn:ietf:params:oauth:grant-type:device_code")]
    DeviceCode {
        /// The `device_code` `/oauth/device_authorization` answered with.
        device_code: String,
    },
    /// Refresh-token grant — the client trades its live refresh token for a
    /// fresh access token plus the refresh token's successor (RFC 6749 §6).
    #[serde(rename = "refresh_token")]
    RefreshToken {
        /// The refresh token being rotated; the trade spends it.
        refresh_token: String,
    },
}

/// `POST /oauth/token` (RFC 6749 §3.2, RFC 8628 §3.4): hand the body's grant
/// to the matching exchange for the authenticated client, an authorization
/// code with its PKCE verifier, a device code while the device polls, or a
/// refresh token for an access token and its successor. A `grant_type` the
/// endpoint doesn't take fails to parse, so it is the extractor's
/// `400 invalid_request`, "Malformed payload".
///
/// Either outcome is uncached (§5.1): `Ok` through [`TokenResponse`], `Err`
/// through [`TokenError`].
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
    exchanger: Live<LiveTokenExchanger>,
    request: TokenRequest<TokenPayload>,
) -> Response {
    let TokenRequest {
        payload,
        authenticated_client,
    } = request;
    let now = Utc::now();
    let exchanged = match payload {
        TokenPayload::AuthorizationCode {
            code,
            code_verifier,
            redirect_uri,
        } => exchanger.exchange_authorization_code(
            &authenticated_client,
            &PresentedAuthorizationCode {
                code: &code,
                code_verifier: &code_verifier,
                redirect_uri: &redirect_uri,
            },
            now,
        ),
        TokenPayload::DeviceCode { device_code } => {
            exchanger.exchange_device_code(&authenticated_client, &device_code, now)
        }
        TokenPayload::RefreshToken { refresh_token } => {
            exchanger.exchange_refresh_token(&authenticated_client, &refresh_token, now)
        }
    };
    let token = match exchanged {
        Ok(token) => token,
        Err(error) => return TokenError::from(error).into_response(),
    };
    token_response(token).into_response()
}

/// The RFC 6749 §5.1 body for an exchange, with SMART's `patient` when the
/// grant binds one.
fn token_response(token: IssuedTokens) -> TokenResponse {
    TokenResponse {
        access_token: token.access_token,
        token_type: "Bearer".to_string(),
        expires_in: token.expires_in,
        scope: token.granted_scopes.join(" "),
        refresh_token: token.refresh_token,
        patient: token.patient,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Clients using `client_secret_post` keep their credentials in the form
    /// body; the grant enum doesn't parse them, so it must tolerate the extra
    /// fields rather than reject the request.
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
