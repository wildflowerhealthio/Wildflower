//! Client credential resolution for the token and device-authorization
//! endpoints.
//!
//! RFC 6749 §2.3.1 requires the authorization server to support HTTP Basic
//! authentication for clients issued a password (`client_secret_basic`), and
//! permits accepting the credentials in the request body
//! (`client_secret_post`). This module resolves both sources into one
//! [`ClientCredentials`] value: the Basic header takes precedence, the body is
//! the fallback, and presenting a secret both ways is rejected (§2.3 — "MUST
//! NOT use more than one authentication method in each request").

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

use super::error_codes::OAuthErrorCode;
use super::internal::{OAuthError, OAuthErrorResponse};
use crate::crypto_util::base64;

/// `WWW-Authenticate` challenge attached to 401 responses when the client
/// attempted Basic authentication (RFC 6749 §5.2: the response "MUST include
/// the `WWW-Authenticate` response header field matching the authentication
/// scheme used by the client").
pub const BASIC_AUTH_CHALLENGE: &str = r#"Basic realm="gatekeeper""#;

/// The two RFC 6749 §2.3.1 ways a client presents its credentials: the HTTP
/// Basic `Authorization` header (the registered `client_secret_basic` method)
/// or `client_id`/`client_secret` form-body parameters (`client_secret_post`).
/// Authentication failures must answer a header-based attempt with a matching
/// `WWW-Authenticate` challenge (§5.2), so the method travels with the
/// credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAuthenticationMethod {
    /// HTTP Basic `Authorization` header (`client_secret_basic`).
    HttpBasic,
    /// `client_id`/`client_secret` in the form body (`client_secret_post`).
    RequestBody,
}

/// Client credentials resolved from the `Authorization: Basic` header
/// (RFC 6749 §2.3.1) and/or the form-body `client_id`/`client_secret`
/// parameters.
#[derive(Debug, PartialEq, Eq)]
pub struct ClientCredentials {
    pub client_id: String,
    pub client_secret: Option<String>,
    /// How the client presented these credentials — drives the RFC 6749 §5.2
    /// `WWW-Authenticate: Basic` challenge on auth failure.
    pub presented_via: ClientAuthenticationMethod,
}

/// Failure modes of credential resolution, before any store lookup.
#[derive(Debug)]
pub enum ResolveClientCredentialsError {
    /// RFC 6749 §2.3 violation (credentials presented two ways, or a body
    /// `client_id` contradicting the Basic userid) or no `client_id` at all —
    /// surface as 400 `invalid_request`.
    InvalidRequest(OAuthError),
    /// The client attempted Basic auth but the header is unusable — surface
    /// as 401 `invalid_client` with a `WWW-Authenticate: Basic` challenge
    /// (RFC 6749 §5.2).
    MalformedBasic(OAuthError),
}

impl IntoResponse for ResolveClientCredentialsError {
    fn into_response(self) -> Response {
        match self {
            ResolveClientCredentialsError::InvalidRequest(error) => OAuthErrorResponse {
                status: StatusCode::BAD_REQUEST,
                error,
            }
            .into_response(),
            ResolveClientCredentialsError::MalformedBasic(error) => (
                [(header::WWW_AUTHENTICATE, BASIC_AUTH_CHALLENGE)],
                OAuthErrorResponse {
                    status: StatusCode::UNAUTHORIZED,
                    error,
                },
            )
                .into_response(),
        }
    }
}

/// Form-body credential parameters, parsed independently of the grant payload
/// (serde ignores the grant-specific fields).
#[derive(Debug, Default, Deserialize)]
struct BodyClientCredentials {
    client_id: Option<String>,
    client_secret: Option<String>,
}

/// Decoded userid/password halves of a Basic `Authorization` header
/// (RFC 6749 §2.3.1).
struct BasicCredentials {
    client_id: String,
    client_secret: String,
}

/// Marker error: an `Authorization: Basic` header was present but could not
/// be decoded (bad base64, invalid UTF-8, no colon, undecodable halves).
#[derive(Debug)]
struct MalformedBasicHeader;

/// Resolve the client credentials for a token-style request from the request's
/// `Authorization` header value (`None` when absent) and the raw
/// `application/x-www-form-urlencoded` body.
///
/// Precedence per RFC 6749 §2.3.1: a Basic `Authorization` header wins; body
/// `client_id`/`client_secret` are the fallback. A body `client_id` alongside
/// Basic is tolerated when it matches the Basic userid (some client libraries
/// always send it); a body `client_secret` alongside Basic is a second
/// authentication method and is rejected (§2.3).
///
/// # Errors
///
/// - [`ResolveClientCredentialsError::MalformedBasic`] when a Basic header is
///   present but undecodable.
/// - [`ResolveClientCredentialsError::InvalidRequest`] when credentials are
///   presented both ways, the body `client_id` contradicts the Basic userid,
///   or no `client_id` is present at all.
pub fn resolve_client_credentials(
    authorization: Option<&str>,
    form_body: &str,
) -> Result<ClientCredentials, ResolveClientCredentialsError> {
    // A structurally unparseable body simply contributes no credentials; the
    // grant-payload parse is responsible for rejecting malformed bodies.
    let body: BodyClientCredentials = serde_urlencoded::from_str(form_body).unwrap_or_default();
    let basic =
        decode_basic_authorization_header(authorization).map_err(|MalformedBasicHeader| {
            ResolveClientCredentialsError::MalformedBasic(OAuthError::new(
                OAuthErrorCode::InvalidClient,
                Some("Malformed Basic authorization header"),
            ))
        })?;
    match basic {
        Some(basic) => {
            if body.client_secret.is_some() {
                return Err(ResolveClientCredentialsError::InvalidRequest(
                    OAuthError::new(
                        OAuthErrorCode::InvalidRequest,
                        Some("Multiple client authentication methods presented"),
                    ),
                ));
            }
            if body
                .client_id
                .as_deref()
                .is_some_and(|body_client_id| body_client_id != basic.client_id)
            {
                return Err(ResolveClientCredentialsError::InvalidRequest(
                    OAuthError::new(
                        OAuthErrorCode::InvalidRequest,
                        Some("client_id does not match Basic authorization header"),
                    ),
                ));
            }
            Ok(ClientCredentials {
                client_id: basic.client_id,
                client_secret: Some(basic.client_secret),
                presented_via: ClientAuthenticationMethod::HttpBasic,
            })
        }
        None => match body.client_id {
            Some(client_id) => Ok(ClientCredentials {
                client_id,
                client_secret: body.client_secret,
                presented_via: ClientAuthenticationMethod::RequestBody,
            }),
            None => Err(ResolveClientCredentialsError::InvalidRequest(
                OAuthError::new(OAuthErrorCode::InvalidRequest, Some("Missing client_id")),
            )),
        },
    }
}

/// Decode the `Authorization` header value as Basic credentials per RFC 6749
/// §2.3.1: base64 → UTF-8 → split at the first colon → form-urlencoded-decode
/// each half.
///
/// `Ok(None)` means no Basic attempt (`authorization` is `None`, or a different
/// scheme such as `Bearer` — mirroring `try_bearer_token_from_headers`);
/// `Err(MalformedBasicHeader)` means the client attempted Basic but the
/// header is undecodable.
fn decode_basic_authorization_header(
    authorization: Option<&str>,
) -> Result<Option<BasicCredentials>, MalformedBasicHeader> {
    let Some(value) = authorization else {
        return Ok(None);
    };
    let prefix = "basic ";
    // Case-insensitive prefix check against just the scheme bytes, matching
    // `try_bearer_token_from_headers` in `middleware/require_auth.rs`.
    if !value
        .get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    {
        return Ok(None);
    }
    try_decode_basic_payload(value[prefix.len()..].trim()).map(Some)
}

/// The fallible tail of [`decode_basic_authorization_header`], split out so
/// every decode failure collapses to the same [`MalformedBasicHeader`].
fn try_decode_basic_payload(
    encoded_payload: &str,
) -> Result<BasicCredentials, MalformedBasicHeader> {
    let decoded_bytes =
        base64::standard_decode(encoded_payload).map_err(|_| MalformedBasicHeader)?;
    let decoded_pair = String::from_utf8(decoded_bytes).map_err(|_| MalformedBasicHeader)?;
    let (encoded_client_id, encoded_client_secret) =
        decoded_pair.split_once(':').ok_or(MalformedBasicHeader)?;
    Ok(BasicCredentials {
        client_id: form_urlencoded_decode_credential_component(encoded_client_id)
            .ok_or(MalformedBasicHeader)?,
        client_secret: form_urlencoded_decode_credential_component(encoded_client_secret)
            .ok_or(MalformedBasicHeader)?,
    })
}

/// Decode one `application/x-www-form-urlencoded` value (`+` → space, then
/// percent-decode), per the encoding RFC 6749 §2.3.1 applies to each Basic
/// credential half before base64.
fn form_urlencoded_decode_credential_component(encoded_component: &str) -> Option<String> {
    // `+` → space first is safe: `%2B` contains no literal `+`, so an encoded
    // plus still round-trips through the percent-decode step.
    let plus_decoded = encoded_component.replace('+', " ");
    percent_encoding::percent_decode_str(&plus_decoded)
        .decode_utf8()
        .ok()
        .map(std::borrow::Cow::into_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic_authorization(userid: &str, password: &str) -> String {
        format!(
            "Basic {}",
            base64::standard_encode(format!("{userid}:{password}").as_bytes())
        )
    }

    #[test]
    fn resolves_body_credentials_when_no_authorization_header() {
        let resolved = resolve_client_credentials(
            None,
            "grant_type=refresh_token&client_id=app&client_secret=s3cret&refresh_token=x",
        )
        .unwrap();
        assert_eq!(
            resolved,
            ClientCredentials {
                client_id: "app".to_string(),
                client_secret: Some("s3cret".to_string()),
                presented_via: ClientAuthenticationMethod::RequestBody,
            }
        );
    }

    #[test]
    fn resolves_basic_header_credentials() {
        let authorization = basic_authorization("app", "s3cret");
        let resolved = resolve_client_credentials(
            Some(&authorization),
            "grant_type=refresh_token&refresh_token=x",
        )
        .unwrap();
        assert_eq!(
            resolved,
            ClientCredentials {
                client_id: "app".to_string(),
                client_secret: Some("s3cret".to_string()),
                presented_via: ClientAuthenticationMethod::HttpBasic,
            }
        );
    }

    #[test]
    fn basic_scheme_match_is_case_insensitive() {
        let encoded = base64::standard_encode("app:s3cret".as_bytes());
        let authorization = format!("bASIC {encoded}");
        let resolved = resolve_client_credentials(Some(&authorization), "").unwrap();
        assert_eq!(
            resolved.presented_via,
            ClientAuthenticationMethod::HttpBasic
        );
        assert_eq!(resolved.client_id, "app");
    }

    #[test]
    fn non_basic_authorization_scheme_falls_back_to_body() {
        let resolved = resolve_client_credentials(
            Some("Bearer some-jwt"),
            "client_id=app&client_secret=s3cret",
        )
        .unwrap();
        assert_eq!(
            resolved,
            ClientCredentials {
                client_id: "app".to_string(),
                client_secret: Some("s3cret".to_string()),
                presented_via: ClientAuthenticationMethod::RequestBody,
            }
        );
    }

    #[test]
    fn basic_halves_are_form_urlencoded_decoded() {
        // userid "app+one" → "app%2Bone"; password "p@ss word%" → "p%40ss+word%25"
        let encoded = base64::standard_encode("app%2Bone:p%40ss+word%25".as_bytes());
        let authorization = format!("Basic {encoded}");
        let resolved = resolve_client_credentials(Some(&authorization), "").unwrap();
        assert_eq!(
            resolved,
            ClientCredentials {
                client_id: "app+one".to_string(),
                client_secret: Some("p@ss word%".to_string()),
                presented_via: ClientAuthenticationMethod::HttpBasic,
            }
        );
    }

    #[test]
    fn basic_password_keeps_text_after_first_colon() {
        let authorization = basic_authorization("app", "se:cret");
        let resolved = resolve_client_credentials(Some(&authorization), "").unwrap();
        assert_eq!(resolved.client_secret.as_deref(), Some("se:cret"));
    }

    #[test]
    fn basic_alongside_body_client_secret_is_invalid_request() {
        let authorization = basic_authorization("app", "s3cret");
        let err =
            resolve_client_credentials(Some(&authorization), "client_secret=s3cret").unwrap_err();
        let ResolveClientCredentialsError::InvalidRequest(oauth_error) = err else {
            panic!("expected InvalidRequest, got {err:?}");
        };
        assert_eq!(oauth_error.error, "invalid_request");
    }

    #[test]
    fn basic_with_matching_body_client_id_is_allowed() {
        let authorization = basic_authorization("app", "s3cret");
        let resolved = resolve_client_credentials(Some(&authorization), "client_id=app").unwrap();
        assert_eq!(resolved.client_id, "app");
        assert_eq!(
            resolved.presented_via,
            ClientAuthenticationMethod::HttpBasic
        );
    }

    #[test]
    fn basic_with_mismatched_body_client_id_is_invalid_request() {
        let authorization = basic_authorization("app", "s3cret");
        let err =
            resolve_client_credentials(Some(&authorization), "client_id=other-app").unwrap_err();
        let ResolveClientCredentialsError::InvalidRequest(oauth_error) = err else {
            panic!("expected InvalidRequest, got {err:?}");
        };
        assert_eq!(oauth_error.error, "invalid_request");
    }

    #[test]
    fn missing_client_id_everywhere_is_invalid_request() {
        let err = resolve_client_credentials(None, "grant_type=refresh_token&refresh_token=x")
            .unwrap_err();
        let ResolveClientCredentialsError::InvalidRequest(oauth_error) = err else {
            panic!("expected InvalidRequest, got {err:?}");
        };
        assert_eq!(oauth_error.error, "invalid_request");
    }

    #[test]
    fn malformed_basic_header_is_invalid_client_with_challenge() {
        let malformed_payloads = [
            "Basic !!!not-base64!!!".to_string(),
            // valid base64 of a colon-less payload
            format!(
                "Basic {}",
                base64::standard_encode("no-colon-here".as_bytes())
            ),
            // valid base64 of invalid UTF-8 bytes
            format!(
                "Basic {}",
                base64::standard_encode(&[0xff, 0xfe, b':', b'x'])
            ),
            // a percent-escape that decodes to an invalid UTF-8 byte
            format!(
                "Basic {}",
                base64::standard_encode("app%ff:secret".as_bytes())
            ),
        ];
        for authorization in malformed_payloads {
            let err = resolve_client_credentials(Some(&authorization), "").unwrap_err();
            assert!(
                matches!(err, ResolveClientCredentialsError::MalformedBasic(_)),
                "expected MalformedBasic for {authorization:?}, got {err:?}"
            );
            let response = err.into_response();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                response
                    .headers()
                    .get(header::WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok()),
                Some(BASIC_AUTH_CHALLENGE)
            );
        }
    }
}
