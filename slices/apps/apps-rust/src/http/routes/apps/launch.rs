//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Two orthogonal axes meet here: the app's kind (its [`AppConfiguration`] variant)
//! fixes how the launch URL is *resolved*, while the *request's*
//! [`RequestProvenance`] (loopback vs. forwarded) fixes how it's *dispatched*. The
//! flow:
//!
//!   1. Read the request's [`RequestProvenance`] *once*, so an empty/spoofed
//!      `Forwarded` host can't make the gate-vs-resolve and which-origin
//!      decisions disagree.
//!   2. The `wildflower/launch` umbrella is enforced *before this handler runs* by
//!      the [`Scoped<LiveAppLauncher>`](crate::live_bindings::LiveAppLauncher) extractor
//!      (the host wraps the launch router with the bearer gate that inserts the
//!      caller's scope claims). An under-umbrella caller `403`s before `find_app`
//!      or target resolution, so it triggers no `tunnel.try_start()` and learns
//!      nothing about existence (`404`) or reachability (`503`).
//!   3. Look up the app (`404 AppNotFound` if absent).
//!   4. Per-app SMART gate: a **SMART** app additionally requires the caller's
//!      grant to cover its OAuth client's requested *resource* scopes (the OIDC /
//!      launch-context scopes are the app's own OAuth concern, filtered out). A
//!      shortfall `403`s with the shared `InsufficientScope` JSON body naming the
//!      missing scopes, before any side-effect. A non-SMART app needs only the
//!      umbrella.
//!   5. Resolve the launch target by the app's kind (System → compiled-in source,
//!      Self-Hosted → loopback/subdomain, Cloud → the stored template). Fails
//!      `503 LaunchUnavailable` when no *reachable* target exists.
//!   6. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the URL to the host webview; a forwarded launch answers `200` with
//!      the URL ([`LaunchTargetBody`]) for the caller's page to navigate to — the
//!      caller is the hosted owner UI's `fetch`, which would follow a redirect
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

use crate::domain::{
    AppConfiguration, AppRegistration, AppsError, AppsStore, CloudAppConfiguration, LaunchParams,
    SelfHostedAppConfiguration, SystemAppConfiguration,
};
use crate::http::errors::{AppNotFoundBody, LaunchUnavailableBody};
use crate::id_utils::mint_launch_nonce;
use crate::live_bindings::state::AppsState;
use crate::live_bindings::LiveAppLauncher;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). Every owner UI
/// drives this through the typed client so the owner bearer rides along.
/// Scope-gated on the `wildflower/launch` umbrella through
/// [`Scoped<LiveAppLauncher>`]; a SMART app additionally requires the caller's grant
/// to cover its OAuth client's scopes (checked in [`launch`]). See the module docs
/// for the resolve-then-dispatch flow and the auth posture.
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
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    launcher: Scoped<LiveAppLauncher>,
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, AppsError> {
    launch(&launcher, state, headers, id).await
}

/// The launch body behind [`handle_launch_app`]: gate, resolve, then dispatch on
/// the request's provenance (see the module docs).
async fn launch(
    launcher: &LiveAppLauncher,
    state: Arc<AppsState>,
    headers: HeaderMap,
    id: String,
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
    // `Scoped<AppLauncher>` extractor (module docs, step 2) — retiring the former
    // in-handler loopback owner gate. An under-umbrella caller was `403`d before
    // this handler ran, so it triggered no lookup or side-effect.

    // 404 before resolving — an unknown id is never an availability failure. The
    // store hands back the `(registration, configuration)` pair; both halves feed
    // the kind-dispatched resolve below (no "combined app" — the tuple is the app).
    // Inlined `find_app` + `NotFound` (the same shape each admin read capability
    // inlines — there is no shared `get_app` helper) — the read's one launch caller.
    let (registration, configuration) = state
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

    // Resolve before dispatching: an unreachable target bails here with
    // `503 LaunchUnavailable` rather than opening a doomed popup / dead redirect.
    let target_url = resolve_launch(&registration, &configuration, &state, &provenance).await?;

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

/// Resolve an app (its `(registration, configuration)` pair) to its
/// provenance-aware launch URL (loopback origin, public subdomain, or a rendered
/// cloud template), dispatching on the `configuration` kind — the whole app came
/// out of one store read, so the kind-specific launch data is already in hand (a
/// system app always carries a valid compiled-in source; a corrupt registry row
/// fails inside the store read as a typed error, never here). `503` if the matched
/// app has no reachable target.
///
/// Lives beside the launch handler rather than in `domain` on purpose: the
/// resolution reaches into `AppsState` (the tunnel, the loopback config) and yields
/// an http [`AppsError`], so keeping it in the HTTP layer leaves the domain free of
/// that http/runtime coupling.
async fn resolve_launch(
    registration: &AppRegistration,
    configuration: &AppConfiguration,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<String, AppsError> {
    match configuration {
        AppConfiguration::System(config) => Ok(render_system_target(state, config, provenance)),
        AppConfiguration::SelfHosted(config) => {
            render_self_hosted_target(config, state, provenance)
        }
        AppConfiguration::Cloud(config) => {
            render_cloud_target(state, provenance, registration, config).await
        }
    }
}

/// Render a system app's launch target from its stored [`SystemAppConfiguration`]:
/// substitute `{origin}` (the served origin) + `{launch}` (a fresh nonce). The
/// `url` was validated at the store read (the [`AppUrl`](crate::domain::AppUrl)
/// column decode), so no parse can fail here.
fn render_system_target(
    state: &AppsState,
    config: &SystemAppConfiguration,
    provenance: &RequestProvenance,
) -> String {
    let origin = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    config.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    })
}

/// Render a self-hosted app's launch target off its own origin — the loopback
/// `http://{host}:{port}/` for a loopback caller, else the public subdomain
/// ([`SelfHostedAppConfiguration::subdomain_url`]). A forwarded launch with **no** `public_host` configured has no reachable target,
/// so it `503 LaunchUnavailable`s rather than handing back loopback. Any
/// `launch_path` is applied by [`SelfHostedAppConfiguration::render_launch`].
fn render_self_hosted_target(
    config: &SelfHostedAppConfiguration,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<String, AppsError> {
    let app_base = match provenance {
        RequestProvenance::Forwarded { .. } => {
            let Some(public_host) = state.tunnel.current_public_host() else {
                return Err(AppsError::Unavailable {
                    reason: "no public host is configured for this remote launch".to_owned(),
                });
            };
            config.subdomain_url(&public_host)
        }
        RequestProvenance::Loopback => config.local_launch_url(&state.loopback_hostname()),
    };
    let served = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    Ok(config.render_launch(&app_base, &served, &launch))
}

/// Render a cloud app's launch target: resolve the served origin (or the tunnel's
/// verified origin for a `requires_tunnel` launch), then substitute `{origin}` /
/// `{launch}` in the stored [`AppUrl`](crate::domain::AppUrl) template. Fails
/// `503 LaunchUnavailable` when a `requires_tunnel` launch can't bring the tunnel
/// up (see [`resolve_origin`]).
async fn render_cloud_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    registration: &AppRegistration,
    config: &CloudAppConfiguration,
) -> Result<String, AppsError> {
    let origin = resolve_origin(state, provenance, registration.requires_tunnel).await?;
    let launch = mint_launch_nonce();
    Ok(config.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// The served origin for a non-tunnel launch: the forwarded public origin when
/// the trusted front relayed the request, else loopback.
fn served_origin(state: &AppsState, provenance: &RequestProvenance) -> String {
    match provenance {
        RequestProvenance::Forwarded { base_url } => {
            shared_structures_rust::origin_string(base_url)
        }
        RequestProvenance::Loopback => state.loopback_origin(),
    }
}

/// Resolve the launch origin for a cloud app.
///
/// A non-tunnel launch resolves to the *served* origin (see [`served_origin`]) so
/// the launch URL is something the caller can actually reach. A
/// `requires_tunnel` launch asks the `TunnelService` to start: `Ok(origin)` is the
/// live verified origin; `Err(reason)` means the tunnel couldn't be brought up —
/// and since the third-party app needs the tunnel to reach the user's FHIR server,
/// there is no reachable origin to fall back to, so the launch fails with
/// `503 LaunchUnavailable`.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> Result<String, AppsError> {
    if !requires_tunnel {
        return Ok(served_origin(state, provenance));
    }
    state.tunnel.try_start().await.map_err(|reason| {
        tracing::warn!(%reason, "requires_tunnel launch failed: tunnel unavailable");
        AppsError::Unavailable { reason }
    })
}

/// Wire shape of a forwarded launch's `200`: the resolved launch URL, for the
/// caller's page to navigate to.
#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct LaunchTargetBody {
    /// The absolute launch URL (public subdomain or rendered cloud template).
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
