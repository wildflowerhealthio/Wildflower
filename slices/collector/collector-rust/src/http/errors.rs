//! Error **wire-representations** for the collector routes — the JSON body
//! shapes and the [`RemoteError`]→response rendering. The failure *vocabulary*
//! is domain ([`crate::domain::RemoteError`]); this file only renders it onto
//! the wire — a semantic status + body, or a logged opaque 500 for a
//! [`Backend`](RemoteError::Backend) failure — so a route bails with `?` and
//! its `Result<_, RemoteError>` becomes a response with no HTTP glue at the
//! call site.
//!
//! All three semantic shapes are part of the wire contract and modeled on both
//! sides: `RemoteNotFoundBody` (404), `InvalidConfigBody` (400), and
//! `RemoteAlreadyExistsBody` (409) each `derive(ToSchema)` and are declared in
//! the routes' `#[utoipa::path]` `responses`, matching the errors the TS
//! `collector-remotes` group adds (`remotes.ts`) so the spec-drift gate stays
//! green. `Backend` is deliberately **not** modeled — an opaque 500 carries no
//! body a client decodes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::RemoteError;

/// Wire shape for the 404. Matches the TS `RemoteNotFoundSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RemoteNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for a 400 `InvalidConfig` — the submitted config carries no
/// string `_tag`, so the denormalized `tag` column (and the wire `tag` field)
/// can't be produced. Matches the TS `InvalidConfigSchema`. Unreachable through
/// the typed TS client (which validates the config union before sending), but
/// modeled so a non-UI client gets a decodable failure.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidConfigBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Wire shape for a 409 `RemoteAlreadyExists` — a create with a client-minted
/// id that's already taken. Matches the TS `RemoteAlreadyExistsSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RemoteAlreadyExistsBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Render each [`RemoteError`] onto the wire. The three semantic variants
/// become their documented status + JSON body; a [`Backend`](RemoteError::Backend)
/// failure is logged (via the shared [`InternalError`]) and answered as an
/// opaque, empty 500 — the operator sees the detail, the client doesn't. This
/// is the whole of the HTTP layer's error knowledge; the routes just `?`.
impl IntoResponse for RemoteError {
    fn into_response(self) -> Response {
        match self {
            RemoteError::NotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(RemoteNotFoundBody {
                    error: "RemoteNotFound",
                    id,
                }),
            )
                .into_response(),
            RemoteError::InvalidConfig { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidConfigBody {
                    error: "InvalidConfig",
                    message,
                }),
            )
                .into_response(),
            RemoteError::AlreadyExists { id } => (
                StatusCode::CONFLICT,
                Json(RemoteAlreadyExistsBody {
                    error: "RemoteAlreadyExists",
                    id,
                }),
            )
                .into_response(),
            RemoteError::Backend { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}
