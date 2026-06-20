//! Shared HTTP error template: the logged, opaque `500`.
//!
//! Every `-rust` slice's `response_templates` used to re-declare this same
//! struct (`tunnel-rust`, `apps-rust`, `gatekeeper-rust`, …): an operator-facing
//! `context` + a `source` detail, logged at error level and returned as an empty
//! `500` (the detail goes to the logs, never the client). It lives here so a
//! slice imports it instead of copying it. Slice-specific domain errors (404s,
//! 400s with structured bodies) stay in each slice's own `HandlerError`.
//!
//! Gated behind the `http-errors` feature so crates that don't serve HTTP don't
//! pull `axum` / `tracing`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// The "a server-side step failed" payload: an operator-facing `context` and the
/// `source` detail. Logged + returned as an opaque 500.
#[derive(Debug)]
pub struct InternalError {
    context: &'static str,
    source: String,
}

impl InternalError {
    /// Build an opaque-500 from a static `context` and a displayable `source`
    /// (the underlying error). Typically held by a slice's `HandlerError` so a
    /// fallible step bails with `?`.
    pub fn new(context: &'static str, source: impl std::fmt::Display) -> Self {
        Self {
            context,
            source: source.to_string(),
        }
    }
}

impl IntoResponse for InternalError {
    fn into_response(self) -> Response {
        let context = self.context;
        // Log `source` against `context` at error level; the body is
        // intentionally empty — detail goes to the operator's logs, not the
        // client.
        tracing::error!(error = %&self.source, "{context}");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}
