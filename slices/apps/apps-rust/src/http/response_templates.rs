//! Shared HTTP response templates for the apps handlers. Mirrors
//! `tunnel-rust`'s `response_templates`: the logged opaque-500
//! ([`internal_error`]) and the `Result`-returning [`HandlerError`] so
//! a fallible step bails with `?` instead of a `match` + `into_response`.
//!
//! On top of `tunnel-rust`'s shape the apps slice carries domain-level
//! errors (404 `AppNotFound`, 403 `BundledAppImmutable`, 400 `InvalidUrl`)
//! that are part of the wire contract — they round-trip through the
//! webview as structured `{ error: 'NAME', id: '…' }` payloads.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// The "a server-side step failed" payload: an operator-facing `context`
/// and the `source` detail. Logged + returned as an opaque 500.
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

/// Wire shape for `AppNotFound`. Matches the TS `AppNotFoundSchema`.
#[derive(Debug, Serialize)]
struct AppNotFoundBody {
    error: &'static str,
    id: String,
}

/// Wire shape for `BundledAppImmutable`. Matches the TS
/// `BundledAppImmutableSchema`.
#[derive(Debug, Serialize)]
struct BundledAppImmutableBody {
    error: &'static str,
    id: String,
}

/// Wire shape for `InvalidUrl` — the 400 a bad custom-app URL gets back.
/// The `message` carries the human-readable reason from
/// [`crate::domain::CustomUrlError`].
#[derive(Debug, Serialize)]
struct InvalidUrlBody {
    error: &'static str,
    message: String,
}

/// Error half of a `Result`-returning handler. Each variant renders one of
/// the canned shapes through `IntoResponse`, so a fallible step bails with
/// `?` instead of a `match` + `return` at every call site.
#[derive(Debug)]
pub(crate) enum HandlerError {
    /// Logged, opaque 500.
    Internal(InternalError),
    /// 404 — no app has this id.
    NotFound { id: String },
    /// 403 — the id resolves to a bundled/action row that can't be
    /// renamed, re-pointed, or deleted (only `enabled` can be toggled).
    BundledImmutable { id: String },
    /// 400 — the submitted URL failed the write-side validator.
    InvalidUrl { message: String },
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
                Json(AppNotFoundBody {
                    error: "AppNotFound",
                    id,
                }),
            )
                .into_response(),
            HandlerError::BundledImmutable { id } => (
                StatusCode::FORBIDDEN,
                Json(BundledAppImmutableBody {
                    error: "BundledAppImmutable",
                    id,
                }),
            )
                .into_response(),
            HandlerError::InvalidUrl { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidUrlBody {
                    error: "InvalidUrl",
                    message,
                }),
            )
                .into_response(),
        }
    }
}
