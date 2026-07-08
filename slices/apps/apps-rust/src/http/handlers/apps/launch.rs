//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Two orthogonal axes meet here: the parent registry row's
//! [`Provenance`](crate::domain::Provenance) fixes how the launch URL is
//! *resolved*, while the *request's* [`RequestProvenance`] (loopback vs.
//! forwarded) fixes how it's *dispatched*. The flow:
//!
//!   1. Read the request's [`RequestProvenance`] *once*, so an empty/spoofed
//!      `Forwarded` host can't make the gate-vs-resolve and which-origin
//!      decisions disagree.
//!   2. Owner-gate a **loopback** request *before any lookup or side-effect*: an
//!      unauthorized loopback caller `401`s before `find_app` or target
//!      resolution, so it triggers no `tunnel.try_start()` and learns nothing
//!      about whether the id exists (`404`) or is reachable (`503`). A forwarded
//!      request skips the gate — the trusted front is its boundary.
//!   3. Look up the parent registry row (`404 AppNotFound` if absent).
//!   4. Resolve the launch target by the app's provenance (System → compiled-in
//!      source, Self-Hosted → loopback/subdomain, Cloud → the stored template).
//!      Fails `503 LaunchUnavailable` when no *reachable* target exists.
//!   5. Dispatch on the request's provenance: a loopback launch `204`s after
//!      handing the (already owner-checked) URL to the host webview; a forwarded
//!      launch `302`s.
//!
//! The auth posture (loopback owner-gated, forwarded on the front trust
//! boundary) is canonical in `docs/Apps/Explanation.md` §"Auth posture"; the
//! forwarded `<id>.<public_host>` subdomain dispatch in
//! `docs/Origins/Explanation.md`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{App, AppKind, CloudApp, LaunchParams, SelfHostedApp};
use crate::http::response_templates::{AppNotFoundBody, HandlerError, LaunchUnavailableBody};
use crate::http::state::AppsState;
use crate::id::mint_launch_nonce;

/// `POST /apps/{id}` — launch an app (`404` if no app has this id). See the
/// module docs for the resolve-then-dispatch flow and the auth posture.
#[utoipa::path(
    post,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 401, description = "A loopback launch whose caller is not the device owner"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    // Read once (see module docs, step 1): a header that fails validation reads
    // as Loopback.
    let provenance = request_provenance(&headers);

    // Owner-gate a loopback request before any lookup or side-effect (module docs,
    // step 2): an unauthorized loopback caller must trigger no `tunnel.try_start()`
    // and must not learn whether the id exists (`404`) or is reachable (`503`). The
    // header-derived `Loopback` is gated in tandem with the host's network-layer
    // loopback-peer gate. A forwarded request rides the front trust boundary.
    if matches!(provenance, RequestProvenance::Loopback)
        && !state
            .owner_auth
            .is_owner(&headers, &state.loopback_origin())
    {
        return Err(HandlerError::Unauthorized);
    }

    // 404 before resolving — an unknown id is never an availability failure.
    let app = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    // Resolve before dispatching: an unreachable target bails here with
    // `503 LaunchUnavailable` rather than opening a doomed popup / dead redirect.
    let (name, target_url) = resolve_launch_target(&state, &app, &provenance).await?;

    match &provenance {
        // The loopback caller was owner-checked above; hand the URL to the host
        // webview and `204` (the seam is contractually fire-and-forget).
        RequestProvenance::Loopback => {
            state.on_device_webview_handle.open(name, target_url);
            Ok(no_content())
        }
        RequestProvenance::Forwarded { .. } => redirect(target_url),
    }
}

/// Resolve `app` to its `(name, launch target)`, dispatching on its
/// [`AppKind`] payload — the whole app came out of one store read, so the
/// kind-specific launch data is already in hand (a `cloud` / `self-hosted` row
/// whose child data is missing fails inside that read as a typed error, never
/// here). The name is only for the loopback popup's chrome; the launch URL is
/// the kind-aware target. `503` if the matched app has no reachable target;
/// `500` for a `system` row with no compiled-in source.
async fn resolve_launch_target(
    state: &AppsState,
    app: &App,
    provenance: &RequestProvenance,
) -> Result<(String, String), HandlerError> {
    let target_url = match &app.kind {
        AppKind::System => render_system_target(state, app, provenance)?,
        AppKind::SelfHosted(child) => render_self_hosted_target(child, state, provenance)?,
        AppKind::Cloud(child) => render_cloud_target(state, provenance, child).await?,
    };
    Ok((app.name.clone(), target_url))
}

/// Render a system app's launch target from its compiled-in
/// [`SystemApp`](crate::domain::system_app) source: substitute `{origin}` (the
/// served origin) + `{launch}` (a fresh nonce). A seeded `system` id with no
/// matching source surfaces as a logged 500 rather than a panic.
fn render_system_target(
    state: &AppsState,
    app: &App,
    provenance: &RequestProvenance,
) -> Result<String, HandlerError> {
    let source = crate::domain::system_app::find(&app.id).ok_or_else(|| {
        // A seeded system row with no compiled-in source is a code/seed drift —
        // log it; never panic in the launch path.
        HandlerError::internal(
            "system app has no compiled-in source",
            format!("id={}", app.id),
        )
    })?;
    let url = source
        .app_url()
        .map_err(|e| HandlerError::internal("system app url failed to parse", e))?;
    let origin = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    Ok(url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// Render a self-hosted app's launch target off its own origin — the loopback
/// `http://{host}:{port}/` for a loopback caller, else the public subdomain (see
/// [`SelfHostedApp::subdomain_url`] and `docs/Origins/Explanation.md`). A
/// forwarded launch with **no** `public_host` configured has no reachable
/// target, so it fails `503 LaunchUnavailable` rather than handing back loopback.
///
/// A bundle that shipped a `launch.html` carries a
/// [`launch_path`](SelfHostedApp::launch_path): the target becomes
/// `/launch.html?…` hung off that app origin, with `{origin}` substituted to the
/// *served* (FHIR) origin — a different origin from the per-app base — and
/// `{launch}` to a fresh nonce. Without one, the bare origin is returned (root →
/// `index.html`), unchanged from before the field existed.
fn render_self_hosted_target(
    child: &SelfHostedApp,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<String, HandlerError> {
    let app_base = match provenance {
        RequestProvenance::Forwarded { .. } => {
            let Some(public_host) = state.tunnel.current_public_host() else {
                return Err(HandlerError::Unavailable {
                    reason: "no public host is configured for this remote launch".to_owned(),
                });
            };
            child.subdomain_url(&public_host)
        }
        RequestProvenance::Loopback => child.launch_url(&state.loopback_hostname()),
    };
    let served = served_origin(state, provenance);
    let launch = mint_launch_nonce();
    Ok(child.render_launch(&app_base, &served, &launch))
}

/// Render a cloud app's launch target: resolve the served origin (or the
/// tunnel's verified origin for a `requires_tunnel` launch), then substitute
/// `{origin}` / `{launch}` in the stored [`AppUrl`](crate::domain::AppUrl)
/// template. Fails `503 LaunchUnavailable` when a `requires_tunnel` launch can't
/// bring the tunnel up (see [`resolve_origin`]).
async fn render_cloud_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    app: &CloudApp,
) -> Result<String, HandlerError> {
    let origin = resolve_origin(state, provenance, app.requires_tunnel).await?;
    let launch = mint_launch_nonce();
    Ok(app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// The served origin for a non-tunnel launch: the forwarded public origin when
/// the trusted front relayed the request, else loopback.
fn served_origin(state: &AppsState, provenance: &RequestProvenance) -> String {
    match provenance {
        RequestProvenance::Forwarded { origin } => origin.clone(),
        RequestProvenance::Loopback => state.loopback_origin(),
    }
}

/// Resolve the launch origin for a cloud app.
///
/// A non-tunnel launch resolves to the *served* origin (see [`served_origin`])
/// so the `302`'s `Location` is something the caller can actually reach. A
/// `requires_tunnel` launch asks the `TunnelService` to start: `Ok(origin)` is
/// the live verified origin; `Err(reason)` means the tunnel couldn't be brought
/// up — and since the third-party app needs the tunnel to reach the user's FHIR
/// server, there is no reachable origin to fall back to, so the launch fails with
/// `503 LaunchUnavailable` rather than pointing the app at an unreachable
/// loopback origin.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> Result<String, HandlerError> {
    if !requires_tunnel {
        return Ok(served_origin(state, provenance));
    }
    state.tunnel.try_start().await.map_err(|reason| {
        // The reason distinguishes "no relay configured" from "dial timed out"
        // from "daemon stopped" — log it so an unavailable launch is diagnosable,
        // and carry it into the 503 body for the SPA.
        tracing::warn!(%reason, "requires_tunnel launch failed: tunnel unavailable");
        HandlerError::Unavailable { reason }
    })
}

/// 302 with an empty body. The `Content-Type` of `text/html; charset=utf-8`
/// matches the TS contract (`HttpApiSchema.Text`). A failure here means the
/// rendered URL contained a byte the header codec rejected; surfaces as a
/// logged 500 (never a handler panic).
fn redirect(location: String) -> Result<Response, HandlerError> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, &location)
        .header("content-type", "text/html; charset=utf-8")
        .body(axum::body::Body::empty())
        .map_err(|e| HandlerError::internal("redirect builder failed", e))
}

/// 204 No Content — the response when the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) has taken the launch
/// (the host opened the URL; there's nothing for the SPA to follow).
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
