//! Error **wire-representations** for the apps routes — the JSON body shapes and
//! the [`AppError`]→response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::AppError`]); this file only renders it onto the wire — a
//! semantic status + body, or a logged opaque 500 for a
//! [`Backend`](AppError::Backend) failure — so a route bails with `?` and its
//! `Result<_, AppError>` becomes a response with no HTTP glue at the call site.
//!
//! Every semantic shape is part of the wire contract and modeled on both sides:
//! each `derive(ToSchema)` body is declared in the routes' `#[utoipa::path]`
//! `responses`, matching the errors the TS `apps` groups add (`apps.ts` /
//! `apps-admin.ts`) so the spec-drift gate stays green. `Backend` is deliberately
//! **not** modeled — an opaque 500 carries no body a client decodes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::AppError;

/// Wire shape for `AppNotFound`. Matches the TS `AppNotFoundSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AppNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for `AppNotEditable` (409) — the app exists but isn't editable
/// through the surface a mutation used (a system app, a seeded self-hosted app,
/// or a body whose provenance doesn't match the stored app).
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AppNotEditableBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for a 400 carrying a discriminant + human-readable reason. Reused
/// for `InvalidUrl` (a bad app URL / launch path), `InvalidName` (an empty name),
/// and `InvalidZip` (an unusable uploaded bundle) — all write-side field
/// validations the client renders inline. The `error` discriminant lets a client
/// tell them apart.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidFieldBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Wire shape for a 503 `LaunchUnavailable` — a launch with no *reachable*
/// target. The SPA surfaces the failure rather than following a dead redirect.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LaunchUnavailableBody {
    pub(crate) error: &'static str,
    pub(crate) reason: String,
}

/// Wire shape for a 400 `InvalidHomeScreen` — the `PUT /home-screen` body wasn't
/// an exact permutation of the registry. Matches the TS `InvalidHomeScreenSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct InvalidHomeScreenBody {
    pub(crate) error: &'static str,
    pub(crate) message: String,
}

/// Render each [`AppError`] onto the wire. The semantic variants become their
/// documented status + JSON body; a [`Backend`](AppError::Backend) failure is
/// logged (via the shared [`InternalError`]) and answered as an opaque, empty
/// 500. This is the whole of the HTTP layer's error knowledge; the routes just
/// `?`.
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(AppNotFoundBody {
                    error: "AppNotFound",
                    id,
                }),
            )
                .into_response(),
            AppError::NotEditable { id } => (
                StatusCode::CONFLICT,
                Json(AppNotEditableBody {
                    error: "AppNotEditable",
                    id,
                }),
            )
                .into_response(),
            AppError::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
            AppError::InvalidUrl { message } => invalid_field("InvalidUrl", message),
            AppError::InvalidName { message } => invalid_field("InvalidName", message),
            AppError::InvalidZip { message } => invalid_field("InvalidZip", message),
            AppError::Unavailable { reason } => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(LaunchUnavailableBody {
                    error: "LaunchUnavailable",
                    reason,
                }),
            )
                .into_response(),
            AppError::InvalidHomeScreen { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidHomeScreenBody {
                    error: "InvalidHomeScreen",
                    message,
                }),
            )
                .into_response(),
            AppError::Backend { context, source } => {
                InternalError::new(context, source).into_response()
            }
        }
    }
}

/// The shared 400 body render for the three field-validation discriminants.
fn invalid_field(error: &'static str, message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(InvalidFieldBody { error, message }),
    )
        .into_response()
}
