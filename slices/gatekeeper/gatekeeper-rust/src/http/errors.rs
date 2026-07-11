//! Error **wire-representations** for the gatekeeper's routes and middleware —
//! how failures render onto the wire, and nothing else. The failure
//! *vocabulary* is domain ([`crate::domain::error::GatekeeperError`]); this
//! file only renders it — a semantic status + JSON body for the `*NotFound`
//! variants, a logged opaque 500 for a
//! [`Backend`](GatekeeperError::Backend) failure — so a route bails with `?`
//! and its `Result` becomes a response with no HTTP glue at the call site.
//!
//! Also holds the canned response shapes the middleware produces directly
//! (a logged 500 via [`internal_error`], a plain 401 via [`unauthorized`],
//! the [`verify_error_response`] status mapping for token verification), the
//! route-level [`HandlerError`], and the local HTML error pages the
//! `/oauth/authorize` endpoint renders for failures that may NOT be
//! redirected back to the client (RFC 6749 §4.1.2.1 restricts those to
//! `redirect_uri`/`client_id` validation failures — every other spec'd error
//! is delivered by redirecting to the already-validated `redirect_uri`).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::domain::error::GatekeeperError;
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

/// The "a server-side step failed" payload shared by every surface's error enum
/// (`HandlerError` here, plus the OAuth `TokenError` and `AuthorizeError`): an
/// operator-facing `context` and the `source` detail, logged + returned as an
/// opaque 500. This is the shared type from `shared-structures-rust` — the same
/// one the other `-rust` slices hold in their `Internal` variant — re-exported
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

/// JSON 404 of the shape `{ "error": <error>, "<field>": <value> }`. The
/// identifying field name varies by resource (`id` for grants/consents,
/// `userCode` for device prompts), so callers pass it explicitly.
pub(crate) fn not_found(error: &'static str, field: &'static str, value: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": error, field: value })),
    )
        .into_response()
}

/// Error half of a `Result`-returning handler. Each variant renders one of
/// the canned shapes above through `IntoResponse`, so a fallible step bails
/// with `?` instead of a `match` + `return` at every call site.
#[derive(Debug)]
pub(crate) enum HandlerError {
    /// Logged, opaque 500 — see [`InternalError`].
    Internal(InternalError),
    /// JSON 404 — rendered by [`not_found`].
    NotFound {
        error: &'static str,
        field: &'static str,
        value: String,
    },
    /// JSON 400 of the shape `{ "error": <error>, "detail": <detail> }` — a
    /// malformed request the client can fix (e.g. an ambiguous revocation body).
    BadRequest { error: &'static str, detail: String },
}

impl HandlerError {
    /// A server-side failure (e.g. a store read): logs and 500s opaquely.
    pub(crate) fn internal(context: &'static str, source: impl std::fmt::Display) -> Self {
        HandlerError::Internal(InternalError::new(context, source))
    }

    /// A missing resource: JSON 404 keyed by the resource's identifying field.
    pub(crate) fn not_found(error: &'static str, field: &'static str, value: &str) -> Self {
        HandlerError::NotFound {
            error,
            field,
            value: value.to_string(),
        }
    }

    /// A client-fixable malformed request: JSON 400 with an explanatory detail.
    pub(crate) fn bad_request(error: &'static str, detail: impl Into<String>) -> Self {
        HandlerError::BadRequest {
            error,
            detail: detail.into(),
        }
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        match self {
            HandlerError::Internal(error) => error.into_response(),
            HandlerError::NotFound {
                error,
                field,
                value,
            } => not_found(error, field, &value),
            HandlerError::BadRequest { error, detail } => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error, "detail": detail })),
            )
                .into_response(),
        }
    }
}

/// Render the domain's failure vocabulary through the route-level
/// [`HandlerError`]: each semantic `*NotFound` variant becomes its structured
/// JSON 404 (keyed by the resource's identifying field), and an opaque
/// [`Backend`](GatekeeperError::Backend) failure becomes the logged, empty
/// 500. This `From` is what lets a handler `?` a
/// `Result<_, GatekeeperError>` from the store or a domain loader.
impl From<GatekeeperError> for HandlerError {
    fn from(error: GatekeeperError) -> Self {
        match error {
            GatekeeperError::OAuthConsentNotFound { id } => {
                HandlerError::not_found("OAuthConsentNotFound", "id", &id)
            }
            GatekeeperError::DeviceConsentNotFound { user_code } => {
                HandlerError::not_found("DeviceConsentNotFound", "userCode", &user_code)
            }
            GatekeeperError::GrantNotFound { id } => {
                HandlerError::not_found("GrantNotFound", "id", &id)
            }
            GatekeeperError::AuthorizationRequestNotFound { id } => {
                HandlerError::not_found("AuthorizationRequestNotFound", "id", &id)
            }
            GatekeeperError::Backend { context, source } => {
                HandlerError::Internal(InternalError::new(context, source))
            }
        }
    }
}

/// Local HTML error pages for `/oauth/authorize` failures that may NOT be
/// redirected back to the client. RFC 6749 §4.1.2.1 restricts these to
/// `redirect_uri`/`client_id` validation failures — every other spec'd
/// error is delivered by redirecting to the (already validated)
/// `redirect_uri` with `error` + `state` query params instead.
pub enum OAuthErrorKind {
    InvalidRedirectUri,
    InvalidScheme,
    UnknownClient,
    DisabledClient,
    RedirectUriNotAllowed,
}

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
        let err = VerifyError::KeyStoreUnavailable(GatekeeperError::backend(
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
