//! Error **wire-representations** for the apps routes — the JSON body shapes and
//! the [`AppsError`]→response rendering. The failure *vocabulary* is domain
//! ([`crate::domain::AppsError`]); this file only renders it onto the wire — a
//! semantic status + body, or a logged opaque 500 for an
//! [`Infrastructure`](AppsError::Infrastructure) failure — so a route bails with `?`
//! and its `Result<_, AppsError>` becomes a response with no HTTP glue at the call
//! site.
//!
//! Every semantic shape is part of the wire contract and modeled on both sides:
//! each `derive(ToSchema)` body is declared in the routes' `#[utoipa::path]`
//! `responses`, matching the errors the TS `apps` groups add (`apps.ts` /
//! `apps-admin.ts`) so the spec-drift gate stays green. `Infrastructure` is
//! deliberately **not** modeled — an opaque 500 carries no body a client decodes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use shared_structures_rust::http_errors::InternalError;
use utoipa::ToSchema;

use crate::domain::AppsError;

/// Wire shape for `AppNotFound`. Matches the TS `AppNotFoundSchema`.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct AppNotFoundBody {
    pub(crate) error: &'static str,
    pub(crate) id: String,
}

/// Wire shape for `AppNotEditable` (409) — the app exists but isn't editable /
/// removable: a system app, or a seeded self-hosted app. (A per-kind path given an
/// id of another kind is a `404`, not a `409` — the mismatch can't be expressed.)
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

/// Render each [`AppsError`] onto the wire. The semantic variants become their
/// documented status + JSON body; an [`Infrastructure`](AppsError::Infrastructure)
/// failure is logged (via the shared [`InternalError`]) and answered as an opaque,
/// empty 500. This is the whole of the HTTP layer's error knowledge; the routes
/// just `?`.
impl IntoResponse for AppsError {
    fn into_response(self) -> Response {
        match self {
            AppsError::NotFound { id } => (
                StatusCode::NOT_FOUND,
                Json(AppNotFoundBody {
                    error: "AppNotFound",
                    id,
                }),
            )
                .into_response(),
            AppsError::NotEditable { id } => (
                StatusCode::CONFLICT,
                Json(AppNotEditableBody {
                    error: "AppNotEditable",
                    id,
                }),
            )
                .into_response(),
            AppsError::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
            AppsError::InvalidUrl { message } => invalid_field("InvalidUrl", message),
            AppsError::InvalidName { message } => invalid_field("InvalidName", message),
            AppsError::InvalidZip { message } => invalid_field("InvalidZip", message),
            AppsError::Unavailable { reason } => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(LaunchUnavailableBody {
                    error: "LaunchUnavailable",
                    reason,
                }),
            )
                .into_response(),
            AppsError::InvalidHomeScreen { message } => (
                StatusCode::BAD_REQUEST,
                Json(InvalidHomeScreenBody {
                    error: "InvalidHomeScreen",
                    message,
                }),
            )
                .into_response(),
            AppsError::InsufficientScope { missing_scopes } => {
                scope_capabilities_rust::insufficient_scope(missing_scopes)
            }
            AppsError::Infrastructure { context, source } => {
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
