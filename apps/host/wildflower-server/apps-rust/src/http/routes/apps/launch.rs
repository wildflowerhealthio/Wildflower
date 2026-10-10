//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Every launch resolves its template's `{origin}` to the server's public origin,
//! whoever calls; the *request's* [`RequestProvenance`] (loopback vs. forwarded)
//! fixes only how the launch is *dispatched*. The flow:
//!
//!   1. Read the request's [`RequestProvenance`] *once*, so an empty/spoofed
//!      `Forwarded` host can't make the gate and dispatch decisions disagree.
//!   2. The `wildflower/launch` umbrella is enforced *before this handler runs* by
//!      the [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher) extractor
//!      (the host wraps the apps router with the bearer gate that inserts the
//!      caller's scope claims). An under-umbrella caller `403`s before `find_app`
//!      or target resolution, so it learns nothing about existence (`404`).
//!   3. Look up the app (`404 AppNotFound` if absent).
//!   4. Per-app SMART gate: a **SMART** app additionally requires the caller's
//!      grant to cover its OAuth client's requested *resource* scopes (the OIDC /
//!      launch-context scopes are the app's own OAuth concern, filtered out). A
//!      shortfall `403`s with the shared `InsufficientScope` JSON body naming the
//!      missing scopes, before any side-effect. A non-SMART app needs only the
//!      umbrella.
//!   5. Resolve the launch target from the stored template: `{origin}` is the
//!      public origin, and `{launch}` is, for a SMART app, a launch context the
//!      gatekeeper mints for the app's OAuth client (through the
//!      [`LaunchContextMinter`](crate::ports::LaunchContextMinter) port) and
//!      consumes at its `/oauth/authorize`. A non-SMART app has no client to
//!      bind a launch to, so its `{launch}` is empty.
//!   6. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the URL to the host webview; a forwarded launch answers `200` with
//!      the URL ([`LaunchTargetBody`]) for the caller's page to navigate to — the
//!      caller is the hosted launcher's `fetch`, which would follow a redirect
//!      invisibly rather than move the tab. No launch sets a cookie: an app
//!      authenticates to the API with its own bearer (SMART) or, on the device,
//!      by loopback provenance — see `docs/Apps/Explanation.md`.
//!
//! The auth posture (scope-gated on `wildflower/launch` + a per-app SMART check;
//! a forwarded launch rides the front trust boundary) is canonical in
//! `docs/Apps/Explanation.md` §"Auth posture".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use serde::Serialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{AppRegistration, AppsError, AppsStore, LaunchParams};
use crate::http::errors::AppNotFoundBody;
use crate::live_bindings::state::AppsState;
use crate::live_bindings::LiveAppLauncher;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). Every launcher
/// drives this through the typed client so the owner bearer rides along.
/// Scope-gated on the `wildflower/launch` umbrella through
/// [`Scoped<LiveAppLauncher>`]; a SMART app additionally requires the caller's grant
/// to cover its OAuth client's scopes (checked here). See the module docs for the
/// resolve-then-dispatch flow and the auth posture.
#[utoipa::path(
    post,
    tag = "Launch",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The resolved launch URL, for a forwarded caller's page to navigate to", body = LaunchTargetBody),
        (status = 204, description = "Host sink opened the launch URL for a loopback caller"),
        (status = 403, description = "The caller's token doesn't cover `wildflower/launch`, or a SMART app's required client scopes", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    launcher: Scoped<LiveAppLauncher>,
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    // Read once (see module docs, step 1): a header that fails validation reads as
    // Loopback; a forwarded host that cleared validation but failed to parse as a
    // URL is an internal inconsistency, so 500 rather than guess.
    let Some(provenance) = request_provenance(&headers) else {
        return Err(AppsError::infrastructure(
            "request_provenance",
            "forwarded header did not indicate a valid base URL",
        ));
    };

    // The `wildflower/launch` umbrella has already been enforced by the
    // `Scoped<AppLauncher>` extractor (module docs, step 2). An under-umbrella
    // caller was `403`d before this handler ran, so it triggered no lookup or
    // side-effect.

    // 404 before resolving — an unknown id is never an availability failure.
    // Inlined `find_app` + `NotFound`, the same shape the admin read capability
    // inlines.
    let registration = state
        .store
        .find_app(&id)?
        .ok_or_else(|| AppsError::NotFound { id: id.clone() })?;

    // Per-app SMART gate (module docs, step 4): a SMART app additionally requires
    // the caller's grant to cover its OAuth client's resource scopes (OIDC /
    // launch-context scopes are filtered out). A shortfall bails before any
    // side-effect with the shared `403 InsufficientScope` JSON body naming the gap,
    // which the typed client decodes. Keeping it structured (not a flattened
    // message) lets the home banner name the scopes and a future "request
    // permissions" action read them. A non-SMART app needs only the
    // umbrella (short-circuited inside).
    let missing = launcher.missing_launch_scopes(&registration)?;
    if !missing.is_empty() {
        return Err(AppsError::InsufficientScope {
            missing_scopes: scopes_rust::render_scopes(&missing),
        });
    }

    let target_url = resolve_launch(&registration, &state)?;

    match &provenance {
        // The loopback caller cleared the umbrella + SMART gates above; hand the URL
        // to the host webview and `204` (the seam is contractually fire-and-forget).
        RequestProvenance::Loopback => {
            state.on_device_webview_handle.open(
                registration.id.clone(),
                registration.name.clone(),
                target_url,
            );
            Ok(no_content())
        }
        RequestProvenance::Forwarded { .. } => Ok(navigate_to(target_url)),
    }
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

/// Wire shape of a forwarded launch's `200`: the resolved launch URL, for the
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

/// 204 No Content — the response when the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) has taken the launch.
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
