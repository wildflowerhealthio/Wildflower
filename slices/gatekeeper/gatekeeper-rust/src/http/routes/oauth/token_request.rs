//! The shared request extractor for the token-style endpoints (`/oauth/token`
//! and `/oauth/device_authorization`).

use std::sync::Arc;

use axum::extract::{FromRequest, Request};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::HeaderMap;
use serde::de::DeserializeOwned;

use super::client_auth::{resolve_client_credentials, ClientCredentials};
use super::internal::TokenError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::http::state::GatekeeperState;

/// The media type RFC 6749 §3.2 (and §4 device-flow extensions) require on a
/// token-endpoint request body.
const FORM_URLENCODED: &str = "application/x-www-form-urlencoded";

/// An RFC 6749 token-style request, extracted once into its grant `payload`
/// (the `grant_type`-tagged body, generic per endpoint) and the resolved client
/// `credentials`.
///
/// Centralizes the three things both token endpoints otherwise repeat inline:
/// the RFC 6749 §3.2 `Content-Type` check (previously unenforced), reading the
/// body, and the §2.3.1 credential dance ([`resolve_client_credentials`], which
/// reconciles the `Authorization: Basic` header with body `client_id` /
/// `client_secret`). On any failure the rejection is a [`TokenError`], so it
/// renders the same cache-suppressed §5.2 error shape as the rest of the
/// surface.
///
/// The body is read once; the grant payload and the credential fields are then
/// each deserialized from it (two cheap `serde_urlencoded` passes over the same
/// small string — they pull disjoint, differently-shaped fields, so a single
/// pass would buy nothing but coupling).
pub(crate) struct TokenRequest<P> {
    pub payload: P,
    pub credentials: ClientCredentials,
}

impl<P> FromRequest<Arc<GatekeeperState>> for TokenRequest<P>
where
    P: DeserializeOwned,
{
    type Rejection = TokenError;

    async fn from_request(
        req: Request,
        state: &Arc<GatekeeperState>,
    ) -> Result<Self, Self::Rejection> {
        require_form_urlencoded_content_type(req.headers())?;
        // `resolve_client_credentials` needs only the `Authorization` header
        // value; capture it (owned) before the body read consumes the request.
        let authorization = req
            .headers()
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = String::from_request(req, state).await.map_err(|_| {
            TokenError::bad_request(OAuthErrorCode::InvalidRequest, Some("Invalid request body"))
        })?;
        // Parse the grant payload before resolving credentials so a structurally
        // malformed body still reads as such, not as "Missing client_id".
        let payload: P = serde_urlencoded::from_str(&body).map_err(|_| {
            TokenError::bad_request(OAuthErrorCode::InvalidRequest, Some("Malformed payload"))
        })?;
        let credentials = resolve_client_credentials(authorization.as_deref(), &body)?;
        Ok(TokenRequest {
            payload,
            credentials,
        })
    }
}

/// Reject unless the request carries `Content-Type: application/x-www-form-
/// urlencoded` (RFC 6749 §3.2). Matches the media type only, tolerating a
/// `; charset=…` parameter and case differences per RFC 7231 §3.1.1.1.
fn require_form_urlencoded_content_type(headers: &HeaderMap) -> Result<(), TokenError> {
    let is_form = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case(FORM_URLENCODED));
    if is_form {
        Ok(())
    } else {
        Err(TokenError::bad_request(
            OAuthErrorCode::InvalidRequest,
            Some("Content-Type must be application/x-www-form-urlencoded"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with_content_type(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn accepts_exact_form_urlencoded() {
        assert!(
            require_form_urlencoded_content_type(&headers_with_content_type(FORM_URLENCODED))
                .is_ok()
        );
    }

    #[test]
    fn accepts_form_urlencoded_with_charset_and_mixed_case() {
        assert!(
            require_form_urlencoded_content_type(&headers_with_content_type(
                "Application/X-WWW-Form-Urlencoded; charset=utf-8"
            ))
            .is_ok()
        );
    }

    #[test]
    fn rejects_other_content_types() {
        assert!(
            require_form_urlencoded_content_type(&headers_with_content_type("application/json"))
                .is_err()
        );
    }

    #[test]
    fn rejects_a_missing_content_type() {
        assert!(require_form_urlencoded_content_type(&HeaderMap::new()).is_err());
    }
}
