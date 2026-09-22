//! Error **wire-representations** for the gatekeeper's routes and middleware —
//! how failures render onto the wire, and nothing else. The failure
//! *vocabulary* is domain ([`crate::domain::gatekeeper_error::GatekeeperError`]); this
//! file only renders it — a semantic status + JSON body for the `*NotFound`
//! variants, a logged opaque 500 for an
//! [`Infrastructure`](GatekeeperError::Infrastructure) failure — so a route
//! bails with `?` and its `Result` becomes a response with no HTTP glue at the
//! call site.
//!
//! Also holds the canned response shapes the middleware produces directly
//! (a logged 500 via [`internal_error`], a plain 401 via [`unauthorized`],
//! the [`verify_error_response`] status mapping for token verification), and the
//! local HTML error pages the `/oauth/authorize` endpoint renders for failures
//! that may NOT be redirected back to the client (RFC 6749 §4.1.2.1 restricts
//! those to `redirect_uri`/`client_id` validation failures — every other spec'd
//! error is delivered by redirecting to the already-validated `redirect_uri`).
//!
//! Each semantic `*NotFound` outcome is rendered by [`IntoResponse for
//! GatekeeperError`](GatekeeperError) onto a typed JSON 404 body (keyed by the
//! resource's identifying field), so a handler returning
//! `Result<_, GatekeeperError>` bails with `?` and its error becomes a response
//! with no HTTP glue at the call site.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::token::VerifyError;

/// Map a token-[`VerifyError`] to its HTTP response, shared by the auth
/// middlewares. Server-side failures (no keys configured, the key store can't
/// be read, a configured key's material is corrupt) are operator problems, so
/// they log and return 500; only a genuinely rejected token is a 401. Written
/// as an exhaustive match so a new `VerifyError` variant forces a deliberate
/// status choice rather than silently defaulting to 401.
pub(crate) fn verify_error_response(context: &str, err: VerifyError) -> Response {
    match err {
        VerifyError::NoSigningKeysConfigured
        | VerifyError::KeyStoreUnavailable(_)
        | VerifyError::RevocationStoreUnavailable(_)
        | VerifyError::SigningKeyUnreadable(_) => internal_error(context, err),
        VerifyError::TokenRejected | VerifyError::Revoked => unauthorized(),
    }
}

/// Log `err` against `context` at error level and return an opaque 500. The
/// body is intentionally empty — the detail goes to the operator's logs, not
/// the client.
pub(crate) fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

/// The "a server-side step failed" payload shared by the OAuth surfaces'
/// error enums (`TokenError` and `AuthorizeError`): an operator-facing `context`
/// and the `source` detail, logged + returned as an opaque 500. (The `/access`
/// surface renders the same opaque 500 through
/// [`GatekeeperError::Infrastructure`](crate::domain::gatekeeper_error::GatekeeperError::Infrastructure),
/// which builds an `InternalError` at render time rather than holding one.) This
/// is the shared type from `shared-structures-rust` — the same one the other
/// `-rust` slices hold in their `Internal` variant — re-exported
/// here so the OAuth surfaces keep importing it from `errors`. Each
/// enum holds it in its `Internal` variant instead of re-declaring the same
/// fields, constructor, and render call. (`TokenError` additionally
/// cache-suppresses the rendered 500 per RFC 6749 §5.1 by wrapping it.)
pub(crate) use shared_structures_rust::http_errors::InternalError;

/// Plain 401 used by the auth middleware when a request lacks a valid bearer
/// token.
pub(crate) fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

/// A `403 Forbidden` carrying the rendered scopes the caller lacks. Two callers
/// share it: the scope-gated capability extractors
/// (`domain::capabilities`) reject with it when a token doesn't cover a
/// capability's required scope, and the consent approver check uses it when an
/// approver tries to delegate scopes beyond their own grant. This is the
/// authorization (not authentication) failure path the resource-scope epic
/// introduces — the first 403 the gatekeeper's `/access` surface can return.
/// The wire shape and this constructor live in `scope-capabilities-rust` (the
/// reusable capability layer), re-exported here so call sites keep importing it
/// from `errors`.
pub(crate) use scope_capabilities_rust::insufficient_scope;

/// Wire shape for `GrantNotFound` (404) — no standing grant has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct GrantNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for `OAuthConsentNotFound` (404) — no pending authorization-code
/// consent has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct OAuthConsentNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for `RegistrationNotAcknowledged` (409) — the approval named a
/// client, redirect, or scope outside the current registration and did not carry
/// the Owner's acknowledgement.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RegistrationNotAcknowledgedBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for `DeviceConsentNotFound` (404) — no pending device-code consent
/// has this user code. Keyed by `userCode`, unlike the id-keyed siblings.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeviceConsentNotFoundBody {
    pub(crate) error: &'static str,
    #[serde(rename = "userCode")]
    pub(crate) user_code: String,
}

/// Wire shape for `AuthorizationRequestNotFound` (404) — no authorization request
/// has this id.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AuthorizationRequestNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Render the domain's failure vocabulary onto the wire: each semantic
/// `*NotFound` variant becomes its typed structured JSON 404 (keyed by the
/// resource's identifying field), and an opaque
/// [`Infrastructure`](GatekeeperError::Infrastructure) failure is logged (via the
/// shared [`InternalError`]) and answered as an opaque, empty 500. This is the
/// whole of the HTTP layer's error knowledge for the `/access` surface; the
/// handlers just `?` a `Result<_, GatekeeperError>` from a domain action.
impl IntoResponse for GatekeeperError {
    fn into_response(self) -> Response {
        match self {
            GatekeeperError::OAuthConsentNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(OAuthConsentNotFoundBody {
                    error: "OAuthConsentNotFound",
                    id,
                }),
            )
                .into_response(),
            GatekeeperError::DeviceConsentNotFound { user_code } => (
                StatusCode::NOT_FOUND,
                Json(DeviceConsentNotFoundBody {
                    error: "DeviceConsentNotFound",
                    user_code,
                }),
            )
                .into_response(),
            GatekeeperError::GrantNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(GrantNotFoundBody {
                    error: "GrantNotFound",
                    id,
                }),
            )
                .into_response(),
            GatekeeperError::AuthorizationRequestNotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(AuthorizationRequestNotFoundBody {
                    error: "AuthorizationRequestNotFound",
                    id,
                }),
            )
                .into_response(),
            GatekeeperError::RegistrationNotAcknowledged { id } => (
                StatusCode::CONFLICT,
                Json(RegistrationNotAcknowledgedBody {
                    error: "RegistrationNotAcknowledged",
                    id,
                }),
            )
                .into_response(),
            GatekeeperError::InsufficientApproverScope { missing_scopes } => {
                insufficient_scope(missing_scopes)
            }
            GatekeeperError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

pub(crate) use crate::domain::oauth_error_kind::OAuthErrorKind;

fn title_and_body(kind: &OAuthErrorKind) -> (&'static str, &'static str) {
    match kind {
        OAuthErrorKind::InvalidRedirectUri => (
            "Invalid redirect URI",
            "The supplied redirect_uri is not a well-formed URL.",
        ),
        OAuthErrorKind::InvalidScheme => (
            "Invalid redirect URI scheme",
            "The supplied redirect_uri must use http or https.",
        ),
        OAuthErrorKind::UnknownClient => (
            "Unknown client",
            "The supplied client_id is not registered.",
        ),
        OAuthErrorKind::DisabledClient => (
            "Disabled client",
            "The supplied client_id has been disabled.",
        ),
        OAuthErrorKind::RedirectUriNotAllowed => (
            "Redirect URI not allowed",
            "The supplied redirect_uri is not registered for this client.",
        ),
        OAuthErrorKind::UnsupportedResponseType => (
            "Unsupported response type",
            "Only the authorization-code flow (response_type=code) is supported.",
        ),
        OAuthErrorKind::UnsupportedCodeChallengeMethod => (
            "Unsupported PKCE method",
            "Only the S256 code_challenge_method is supported.",
        ),
        OAuthErrorKind::InvalidCodeChallenge => (
            "Invalid PKCE code challenge",
            "The supplied code_challenge is not a well-formed S256 challenge.",
        ),
    }
}

pub fn oauth_error_html(kind: &OAuthErrorKind) -> String {
    let (title, body) = title_and_body(kind);
    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
  <meta charset=\"utf-8\">\n\
  <title>{title}</title>\n\
</head>\n\
<body>\n\
  <h1>{title}</h1>\n\
  <p>{body}</p>\n\
</body>\n\
</html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::signing_key::KeyMaterialError;

    // Server-side `VerifyError` variants are operator problems → 500; only a
    // rejected token is a 401. One test per variant so a failure names the
    // exact mapping that broke. The match in `verify_error_response` is
    // exhaustive, so a new variant is a compile error, not a silent 401.

    #[test]
    fn no_signing_keys_configured_maps_to_500() {
        let response = verify_error_response("test", VerifyError::NoSigningKeysConfigured);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn key_store_unavailable_maps_to_500() {
        let err = VerifyError::KeyStoreUnavailable(GatekeeperError::infrastructure(
            "all_signing_keys failed",
            "query returned no rows",
        ));
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn signing_key_unreadable_maps_to_500() {
        let err = VerifyError::SigningKeyUnreadable(KeyMaterialError::Decode(
            base64::DecodeError::InvalidByte(0, b'!'),
        ));
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn token_rejected_maps_to_401() {
        let response = verify_error_response("test", VerifyError::TokenRejected);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn revoked_maps_to_401() {
        // A revoked-but-otherwise-valid token is a client problem, not an
        // operator one → 401, same as a plain rejection.
        let response = verify_error_response("test", VerifyError::Revoked);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn revocation_store_unavailable_maps_to_500() {
        // A store read failure fails closed: we can't prove the token is live,
        // so it's an operator-facing 500, never a silent pass.
        let err = VerifyError::RevocationStoreUnavailable(rusqlite::Error::QueryReturnedNoRows);
        let response = verify_error_response("test", err);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
