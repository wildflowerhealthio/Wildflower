//! HTTP response templates for the databases handlers. The logged opaque-500
//! ([`InternalError`]) is the shared one from `shared-structures-rust` (the same
//! type the other `-rust` slices use); on top of it the slice carries one domain
//! error — a `404 DatabaseNotFound` — that is part of the wire contract: an
//! unknown resource id, or a known database that doesn't exist on disk,
//! round-trips as a structured `{ error: "DatabaseNotFound", id }` payload. The
//! `Result`-returning [`HandlerError`] lets a fallible step bail with `?` instead
//! of a `match` + `into_response`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

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
