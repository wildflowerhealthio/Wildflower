//! Shared HTTP response templates for the databases handlers. Mirrors
//! `apps-rust`'s `response_templates`: the logged opaque-500
//! ([`InternalError`]) and the `Result`-returning [`HandlerError`] so a fallible
//! step bails with `?` instead of a `match` + `into_response`.
//!
//! On top of that floor the slice carries one domain error — a `404`
//! `DatabaseNotFound` — that is part of the wire contract: an unknown resource
//! id, or a known database that doesn't exist on disk, round-trips as a
//! structured `{ error: "DatabaseNotFound", id }` payload.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

/// The "a server-side step failed" payload: an operator-facing `context` and
/// the `source` detail. Logged + returned as an opaque 500.
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
        tracing::error!(error = %&self.source, "{context}");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}

/// Wire shape for a `404 DatabaseNotFound`. Matches the TS
/// `DatabaseNotFoundSchema` in `databases-core`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DatabaseNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Error half of a `Result`-returning handler. Each variant renders one of the
/// canned shapes through `IntoResponse`, so a fallible step bails with `?`
/// instead of a `match` + `return` at every call site.
#[derive(Debug)]
pub(crate) enum HandlerError {
    /// Logged, opaque 500.
    Internal(InternalError),
    /// 404 — no catalogued database has this id, or it isn't on disk.
    NotFound { id: String },
}

impl HandlerError {
    pub(crate) fn internal(context: &'static str, source: impl std::fmt::Display) -> Self {
        HandlerError::Internal(InternalError::new(context, source))
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        match self {
            HandlerError::Internal(error) => error.into_response(),
            HandlerError::NotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(DatabaseNotFoundBody {
                    error: "DatabaseNotFound",
                    id,
                }),
            )
                .into_response(),
        }
    }
}
