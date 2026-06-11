//! Shared HTTP response helpers for the gatekeeper's handlers and middleware.
//!
//! These factor out the error-response shapes that were previously
//! copy-pasted across nearly every handler and middleware file: a logged
//! 500 ([`internal_error`]), a plain 401 ([`unauthorized`]), and a JSON
//! 404 ([`not_found`]).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

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

/// Plain 401 used by the auth middleware when a request lacks a valid bearer
/// token.
pub(crate) fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

/// JSON 404 of the shape `{ "error": <error>, "<field>": <value> }`. The
/// identifying field name varies by resource (`id` for grants/consents,
/// `userCode` for device prompts), so callers pass it explicitly.
pub(crate) fn not_found(error: &'static str, field: &'static str, value: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": error, field: value }))).into_response()
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
