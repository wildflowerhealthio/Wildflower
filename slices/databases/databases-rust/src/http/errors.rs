//! Error **wire-representations** for the databases routes — the JSON body shape
//! and the [`DatabaseError`]→response rendering. The failure *vocabulary* is
//! domain ([`crate::domain::DatabaseError`]); this file only renders it onto the
//! wire — a semantic status + body, or a logged opaque 500 for a
//! [`Infrastructure`](DatabaseError::Infrastructure) failure — so a route bails
//! with `?` and its `Result<_, DatabaseError>` becomes a response with no HTTP
//! glue at the call site.
//!
//! The one semantic shape is part of the wire contract and modeled on both
//! sides: `DatabaseNotFoundBody` (404) `derive(ToSchema)` and is declared in the
//! routes' `#[utoipa::path]` `responses`, matching the error the TS `databases`
//! group adds (`databases.ts`) so the spec-drift gate stays green.
//! `Infrastructure` is deliberately **not** modeled — an opaque 500 carries no
//! body a client decodes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::DatabaseError;

/// Wire shape for a `404 DatabaseNotFound`. Matches the TS
/// `DatabaseNotFoundSchema` in `databases-core`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DatabaseNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Render each [`DatabaseError`] onto the wire. The semantic
/// [`NotFound`](DatabaseError::NotFound) becomes its documented `404` + JSON
/// body; an [`Infrastructure`](DatabaseError::Infrastructure) failure is logged
/// (via the shared
/// [`InternalError`]) and answered as an opaque, empty 500 — the operator sees
/// the detail, the client doesn't. This is the whole of the HTTP layer's error
/// knowledge; the routes just `?`.
impl IntoResponse for DatabaseError {
    fn into_response(self) -> Response {
        match self {
            DatabaseError::NotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(DatabaseNotFoundBody {
                    error: "DatabaseNotFound",
                    id,
                }),
            )
                .into_response(),
            DatabaseError::InsufficientScope { missing_scopes } => {
                scope_capabilities_rust::insufficient_scope(missing_scopes)
            }
            DatabaseError::Infrastructure { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}
