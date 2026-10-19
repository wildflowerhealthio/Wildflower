//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Every launch resolves its template's `{origin}` to the server's public origin
//! and answers `200` with the URL, whoever calls. The flow:
//!
//!   1. The `wildflower/launch` umbrella is enforced *before this handler runs* by
//!      the [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher) extractor
//!      (the host wraps the apps router with the bearer gate that inserts the
//!      caller's scope claims). An under-umbrella caller `403`s before `find_app`
//!      or target resolution, so it learns nothing about existence (`404`).
//!   2. Look up the app (`404 AppNotFound` if absent).
//!   3. Resolve the launch target from the stored template: `{origin}` is the
//!      public origin, and `{launch}` is, for a SMART app, a launch context the
//!      authorization server mints for the app's OAuth client (through the
//!      [`LaunchContextMinter`](crate::ports::LaunchContextMinter) port) and
//!      consumes at its `/oauth/authorize`. A non-SMART app has no client to
//!      bind a launch to, so its `{launch}` is empty.
//!   4. Answer `200` with the URL ([`LaunchTargetBody`]) for the caller's page
//!      to navigate to — the caller is the launcher's `fetch`, which would follow
//!      a redirect invisibly rather than move the tab. No launch sets a cookie:
//!      an app authenticates to the API with its own bearer (SMART) — see
//!      `docs/Apps/Explanation.md`.
//!
//! The umbrella is the whole launch gate: what a SMART app may then do is
//! bounded at its own `/oauth/authorize`, whose code carries only what the
//! launching browser's session also holds. The auth posture is canonical in
//! `docs/Apps/Explanation.md` §"Auth posture".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use serde::Serialize;
use utoipa::ToSchema;

use wildflowerhealthio_scope_capabilities::{InsufficientScopeBody, Scoped};

use crate::domain::{AppRegistration, AppsError, AppsStore, LaunchParams};
use crate::http::errors::AppNotFoundBody;
use crate::live_bindings::state::AppsState;
use crate::live_bindings::LiveAppLauncher;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). Every launcher
/// drives this through the typed client so the owner bearer rides along.
/// Scope-gated on the `wildflower/launch` umbrella through
/// [`Scoped<LiveAppLauncher>`]. See the module docs for the flow and the auth
/// posture.
#[utoipa::path(
    post,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The resolved launch URL, for the caller's page to navigate to", body = LaunchTargetBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/launch`", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    _launcher: Scoped<LiveAppLauncher>,
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    // The `wildflower/launch` umbrella has already been enforced by the
    // `Scoped<AppLauncher>` extractor (module docs, step 1). An under-umbrella
    // caller was `403`d before this handler ran, so it triggered no lookup or
    // side-effect.

    // 404 before resolving — an unknown id is never an availability failure.
    // Inlined `find_app` + `NotFound`, the same shape the admin read capability
    // inlines.
    let registration = state
        .store
        .find_app(&id)?
        .ok_or_else(|| AppsError::NotFound { id: id.clone() })?;

    Ok(navigate_to(resolve_launch(&registration, &state)?))
}

/// Resolve an app to its launch URL: substitute the server's public origin for
/// `{origin}` and, for `{launch}`, a launch context minted for a SMART app's
/// OAuth client (empty for a non-SMART app, which has no client to bind it to)
/// in the stored [`AppUrl`](crate::domain::AppUrl) template. The `url` was
/// validated at the store read (the column decode), so no parse can fail here.
///
/// Lives beside the launch handler rather than in `domain` on purpose: the
/// resolution reads `AppsState`'s public origin and launch-context port, so
/// keeping it in the HTTP layer leaves the domain free of that runtime coupling.
fn resolve_launch(registration: &AppRegistration, state: &AppsState) -> Result<String, AppsError> {
    let origin = state.public_origin();
    let launch = match registration.client_id.as_deref() {
        Some(client_id) => state.launch_context_minter.mint_launch_context(client_id)?,
        None => String::new(),
    };
    Ok(registration.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// Wire shape of a launch's `200`: the resolved launch URL, for the
/// caller's page to navigate to.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LaunchTargetBody {
    /// The absolute launch URL (the app's rendered template).
    pub url: String,
}

/// `200` with the launch URL as [`LaunchTargetBody`].
fn navigate_to(url: String) -> Response {
    (StatusCode::OK, Json(LaunchTargetBody { url })).into_response()
}
