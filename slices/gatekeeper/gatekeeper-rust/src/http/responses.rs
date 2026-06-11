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
