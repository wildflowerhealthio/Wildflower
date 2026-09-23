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
use crate::http::ServedOrigin;
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
    exchanger: Live<LiveTokenExchanger>,
    origin: ServedOrigin,
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
            &origin,
            now,
        ),
        TokenPayload::DeviceCode { device_code } => {
            exchanger.exchange_device_code(&authenticated_client, &device_code, &origin, now)
        }
        TokenPayload::RefreshToken { refresh_token } => {
            exchanger.exchange_refresh_token(&authenticated_client, &refresh_token, &origin, now)
        }
    };
    let token = match exchanged {
        Ok(token) => token,
        Err(error) => return TokenError::from(error).into_response(),
    };
    token_response(token).into_response()
}

/// The RFC 6749 §5.1 body for an exchange.
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
