//! Shared HTTP response templates for the apps handlers. Mirrors
//! `tunnel-rust`'s `response_templates`: the logged opaque-500
//! ([`InternalError`]) and the `Result`-returning [`HandlerError`] so
//! a fallible step bails with `?` instead of a `match` + `into_response`.
//!
//! On top of `tunnel-rust`'s shape the apps slice carries domain-level
//! errors (404 `AppNotFound`, 400 `InvalidUrl`) that are part of the wire
//! contract — they round-trip through the webview as structured
//! `{ error: 'NAME', ... }` payloads. Every app is editable, so the only
//! failure modes are "no such id" and "your URL is bad".

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

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
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AppNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for a 400 carrying a discriminant + human-readable reason.
/// Reused for `InvalidUrl` (a bad app URL) and `InvalidName` (an empty name)
/// — both are write-side field validations the client renders inline. The
/// `error` discriminant lets a client tell the two apart rather than seeing a
/// URL-error tag for a name problem.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidFieldBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Wire shape for a 503 `LaunchUnavailable`. A launch that can't resolve a
/// *reachable* target — a forwarded (remote) launch when no public host is
/// configured, or a `requires_tunnel` app launched while the tunnel is down —
/// returns this instead of a dead loopback redirect / a host popup pointed at
/// an origin the caller can't reach, so the SPA can surface the failure rather
/// than silently no-op.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LaunchUnavailableBody {
    pub(crate) error: &'static str,
    pub(crate) reason: String,
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
    /// 400 — the submitted URL failed the write-side validator.
    InvalidUrl { message: String },
    /// 400 — the submitted name was empty.
    InvalidName { message: String },
    /// 503 — the launch can't resolve a reachable target (forwarded launch with
    /// no public host, or a `requires_tunnel` app while the tunnel is down).
    Unavailable { reason: String },
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
            HandlerError::InvalidUrl { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidFieldBody {
                    error: "InvalidUrl",
                    message,
                }),
            )
                .into_response(),
            HandlerError::InvalidName { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidFieldBody {
                    error: "InvalidName",
                    message,
                }),
            )
                .into_response(),
            HandlerError::Unavailable { reason } => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(LaunchUnavailableBody {
                    error: "LaunchUnavailable",
                    reason,
                }),
            )
                .into_response(),
        }
    }
}
