//! Shared HTTP response templates for the gatekeeper's handlers and
//! middleware. Callers invoke these through the module namespace
//! (`response_templates::internal_error(..)`) so a reader sees at the call
//! site that a canned response shape is being produced.
//!
//! These factor out the error-response shapes that were previously
//! copy-pasted across nearly every handler and middleware file: a logged
//! 500 ([`internal_error`]), a plain 401 ([`unauthorized`]), and a JSON
//! 404 ([`not_found`]).

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::domain::token::VerifyError;

/// Wrapper that stamps the RFC 6749 §5.1/§5.2 cache-suppression headers
/// (`Cache-Control: no-store`, `Pragma: no-cache`) onto the wrapped response.
/// Sensitive responses — OAuth token / device-authorization bodies (success or
/// error), and the Owner `/access/*` surface — must never be cached; wrapping
/// makes that part of the value instead of a step a call site can forget.
///
/// The single source of truth for cache-suppression, applied two ways: the
/// `/oauth` handlers wrap individual responses (`CacheSuppressed(Json(..))`) so
/// the guarantee is visible at the type, and the `/access` surface applies it
/// as a blanket layer ([`cache_suppress`](crate::http) wraps every response in
/// it) so a new route can't forget. Prepends the headers, so only wrap
/// responses that don't already set `Cache-Control` (none on these surfaces do)
/// to avoid a duplicated header.
pub(crate) struct CacheSuppressed<T>(pub T);

impl<T: IntoResponse> IntoResponse for CacheSuppressed<T> {
    fn into_response(self) -> Response {
        (
            [
                (header::CACHE_CONTROL, "no-store"),
                (header::PRAGMA, "no-cache"),
            ],
            self.0,
        )
            .into_response()
    }
}

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
        | VerifyError::SigningKeyUnreadable(_) => internal_error(context, err),
        VerifyError::TokenRejected => unauthorized(),
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
/// operator-facing `context` and the `source` detail, rendered through
/// [`internal_error`] (logs `source` against `context`, returns an opaque 500).
/// Each enum holds this in its `Internal` variant instead of re-declaring the
/// same fields, constructor, and render call three times. (`TokenError`
/// additionally cache-suppresses the rendered 500 per RFC 6749 §5.1 by wrapping
/// it.)
#[derive(Debug)]
pub(crate) struct InternalError {
    context: &'static str,
    source: String,
}

impl InternalError {
    /// Capture an operator `context` and the `source` detail to log at render.
    pub(crate) fn new(context: &'static str, source: impl std::fmt::Display) -> Self {
        Self {
            context,
            source: source.to_string(),
        }
    }
}

impl IntoResponse for InternalError {
    fn into_response(self) -> Response {
        internal_error(self.context, self.source)
    }
}

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
        }
    }
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
        let err = VerifyError::KeyStoreUnavailable(rusqlite::Error::QueryReturnedNoRows);
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
}
