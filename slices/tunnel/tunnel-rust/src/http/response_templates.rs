//! Shared HTTP response templates for the tunnel's handlers. Callers invoke
//! these through the module namespace (`response_templates::internal_error(..)`)
//! so a reader sees at the call site that a canned response shape is being
//! produced.
//!
//! Mirrors `gatekeeper-rust`'s `response_templates`: factor out the logged
//! opaque-500 ([`internal_error`]) and the `Result`-returning [`HandlerError`]
//! so a fallible step bails with `?` instead of a `match` + `into_response` at
//! every call site.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// The "a server-side step failed" payload: an operator-facing `context` and
/// the `source` detail, rendered through [`internal_error`] (logs `source`
/// against `context`, returns an opaque 500). Held by [`HandlerError::Internal`]
/// so a fallible step bails with `?`.
#[derive(Debug)]
pub(crate) struct InternalError {
    context: &'static str,
    source: String,
}

impl InternalError {
    pub(crate) fn new(context: &'static str, source: impl std::fmt::Display) -> Self {
        Self {
            context,
            source: source.to_string(),
        }
    }
}

impl IntoResponse for InternalError {
    fn into_response(self) -> Response {
        let context = self.context;
        // Log `err` against `context` at error level and return an opaque 500. The
        // body is intentionally empty — the detail goes to the operator's logs, not
        // the client.
        tracing::error!(error = %&self.source, "{context}");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

/// Error half of a `Result`-returning handler. Each variant renders one of the
/// canned shapes above through `IntoResponse`, so a fallible step bails with
/// `?` instead of a `match` + `return` at every call site.
#[derive(Debug)]
pub(crate) enum HandlerError {
    /// Logged, opaque 500 — see [`InternalError`].
    Internal(InternalError),
}

impl HandlerError {
    /// A server-side failure (e.g. a store read): logs and 500s opaquely.
    pub(crate) fn internal(context: &'static str, source: impl std::fmt::Display) -> Self {
        HandlerError::Internal(InternalError::new(context, source))
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        match self {
            HandlerError::Internal(error) => error.into_response(),
        }
    }
}
