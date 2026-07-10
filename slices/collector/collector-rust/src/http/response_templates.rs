//! Shared HTTP response templates for the collector handlers. Mirrors
//! `apps-rust`'s `response_templates`: the shared logged opaque-500
//! ([`InternalError`]) and the `Result`-returning [`HandlerError`] so a
//! fallible step bails with `?` instead of a `match` + `into_response`.
//!
//! Only [`RemoteNotFoundBody`] is part of the wire contract (the TS
//! `RemoteNotFoundSchema`); the 400/409 shapes are server-side guardrails the
//! TS client never models, so they are deliberately **absent from the utoipa
//! annotations** — declaring them would fail the TS spec-drift gate, which
//! compares every declared status.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

/// Wire shape for the 404. Matches the TS `RemoteNotFoundSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct RemoteNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for a 400 `InvalidConfig` — the submitted config carries no
/// string `_tag`, so the denormalized `tag` column (and the wire `tag` field)
/// can't be produced. Unreachable through the typed TS client, which validates
/// the config union before sending; kept undocumented in the spec (see the
/// module doc).
#[derive(Debug, Serialize)]
pub(crate) struct InvalidConfigBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Wire shape for a 409 `RemoteAlreadyExists` — a create with a client-minted
/// id that's already taken. Undocumented in the spec (see the module doc).
#[derive(Debug, Serialize)]
pub(crate) struct RemoteAlreadyExistsBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Error half of a `Result`-returning handler. Each variant renders one of
/// the canned shapes through `IntoResponse`, so a fallible step bails with
/// `?` instead of a `match` + `return` at every call site.
#[derive(Debug)]
pub(crate) enum HandlerError {
    /// Logged, opaque 500.
    Internal(InternalError),
    /// 404 — no remote has this id.
    NotFound { id: String },
    /// 400 — the submitted config carries no string `_tag`.
    InvalidConfig { message: String },
    /// 409 — a create whose id is already taken.
    AlreadyExists { id: String },
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
                Json(RemoteNotFoundBody {
                    error: "RemoteNotFound",
                    id,
                }),
            )
                .into_response(),
            HandlerError::InvalidConfig { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidConfigBody {
                    error: "InvalidConfig",
                    message,
                }),
            )
                .into_response(),
            HandlerError::AlreadyExists { id } => (
                StatusCode::CONFLICT,
                Json(RemoteAlreadyExistsBody {
                    error: "RemoteAlreadyExists",
                    id,
                }),
            )
                .into_response(),
        }
    }
}
