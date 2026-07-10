//! Shared HTTP response templates for the tunnel's handlers. Callers invoke
//! these through the module namespace so a reader sees at the call site that a
//! canned response shape is being produced.
//!
//! The logged opaque-500 ([`InternalError`]) is the shared one from
//! `shared-structures-rust` (the same type the other `-rust` slices use); on top
//! of it the `Result`-returning [`HandlerError`] lets a fallible step bail with
//! `?` instead of a `match` + `into_response` at every call site.

use axum::response::{IntoResponse, Response};
use shared_structures_rust::http_errors::InternalError;

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
