//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Two stores back the id-space:
//!
//!   * **Internals** ([`InternalAppsStore`](crate::db::InternalAppsStore)) —
//!     locally-served apps with a fixed origin per row. A loopback caller
//!     gets `http://{host}:{port}/` (from host config + the row's `port`);
//!     a forwarded caller (one whose `x-public-origin` indicates the
//!     trusted front relayed the request) gets the matching public-origin
//!     URL `https://{id}.{public_host}/` — the same shape the host's
//!     subdomain dispatch matches inbound. So a remote browser launching
//!     the app follows the redirect back through the relay rather than
//!     chasing a loopback IP it can't reach. No `{origin}` / `{launch}`
//!     substitution, no tunnel-up resolution: the launch URL is fixed per
//!     row and the only variable is loopback-vs-subdomain.
//!   * **Externals** ([`AppsStore`](crate::db::AppsStore)) — user-editable
//!     rows carrying an [`AppUrl`] template with `{origin}` / `{launch}`
//!     placeholders. The handler resolves the served origin through the
//!     tunnel seam (see [`resolve_origin`]) and renders the target through
//!     [`AppUrl::to_url_with_params`], which substitutes the placeholders
//!     and is safe by construction.
//!
//! The flow:
//!
//!   1. Look up the id in internals first, then externals (404 if absent
//!      from both).
//!   2. Read the request's [`RequestProvenance`] *once* — both "is this a
//!      remote caller?" (decides sink vs. redirect) and "what origin do we
//!      render?" derive from the same single header read, so an empty/spoofed
//!      `x-public-origin` can't make the two answers disagree.
//!   3. Render the launch target (internal: from config; external: through
//!      `AppUrl`).
//!   4. Dispatch: when a [`LaunchSink`](crate::LaunchSink) is installed
//!      (the Tauri host) *and* the caller is loopback (a local webview that
//!      a host popup can actually serve), it hands the URL to the sink and
//!      `204`s; otherwise it returns a `302` redirect for the browser to
//!      follow.
//!
//! `requires_tunnel` applies only to externals: the launch asks the tunnel
//! to start and resolves to its live *verified* origin, or — when the tunnel
//! can't be brought up — falls back to the loopback origin with
//! `?tunnel=unavailable` so the SPA can surface a banner. A non-tunnel
//! external launch resolves to the *served* origin — loopback for a direct
//! caller, the forwarded public origin for a request the trusted front
//! relayed — so a redirect handed back to a remote browser is reachable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{AppEntry, InternalApp, LaunchParams};
use crate::http::response_templates::{AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;
use crate::id::random_id_21;

/// `POST /apps/{id}` — launch an app. `404` if no app has this id. Reachable
/// unauthenticated (the webview follows the redirect).
///
/// A host [`LaunchSink`](crate::LaunchSink) opens the resolved URL in a native
/// popup *on this device*, which only helps the **local** caller — so the sink
/// is used (returning `204`) only when the request came in over loopback. A
/// request **forwarded by the trusted front** (the relay/tunnel sets
/// `x-public-origin`) is a *remote* caller, for whom a host-side popup is
/// invisible; it gets the `302` redirect instead, the same as a host that
/// installs no sink at all (web/standalone).
#[utoipa::path(
    post,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    // Single read of the forwarding headers — both decisions below derive
    // from this one value, so an empty/spoofed `x-public-origin` can't make
    // them disagree (a header that fails validation reads as Loopback).
    let provenance = request_provenance(&headers);

    // Internals win on id collision (the only path that puts an internal
    // and an external row at the same id is a pre-migration-002 edit; see
    // the list-merge handler). The internal's launch URL is
    // provenance-aware: a loopback caller redirects to the per-app
    // loopback listener; a forwarded caller redirects to the public
    // subdomain so the remote browser can follow it through the relay.
    let (app, target) = if let Some(internal) = state
        .internal_apps
        .find(&id)
        .map_err(|e| HandlerError::internal("internal_apps find lookup failed", e))?
    {
        let target = render_internal_target(&internal, &state, &provenance);
        // The sink path only fires for loopback callers (see below), so the
        // sink-bound `AppEntry` always carries the loopback URL — the host
        // popup opens the local origin. That matches the redirect a no-sink
        // loopback caller would chase, so loopback callers see one URL
        // regardless of which dispatch fires.
        (
            internal.to_app_entry(&state.internal_apps_loopback_host),
            target,
        )
    } else {
        let external = state
            .store
            .find_app(&id)
            .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
            .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;
        let target = render_external_target(&state, &provenance, &external).await;
        (external, target)
    };

    match (&state.launch_sink, &provenance) {
        // Loopback caller + a host sink: the host owns the side-effect — hand
        // it the resolved URL (it opens a native popup) and 204 so the SPA
        // stays mounted. The sink is contractually fire-and-forget (the Tauri
        // impl spawns the blocking webview-open onto a blocking thread, so
        // this call returns promptly). A forwarded (remote) request, or no
        // sink at all, falls through to the redirect.
        (Some(sink), RequestProvenance::Loopback) => {
            sink.open(&app, &target);
            Ok(no_content())
        }
        _ => redirect(target),
    }
}

/// Render an internal app's launch target. A loopback caller (and a
/// forwarded caller when `public_host` is unconfigured — degraded, the
/// browser will fail to reach a 127.0.0.1 URL but at least the catalogue
/// is consistent) gets the loopback `http://{host}:{port}/`; a forwarded
/// caller with a configured `public_host` gets
/// `https://{id}.{public_host}/`, the same subdomain shape the host's
/// subdomain dispatch routes inbound.
fn render_internal_target(
    internal: &InternalApp,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> String {
    if matches!(provenance, RequestProvenance::Forwarded { .. }) {
        if let Some(public_host) = state.tunnel.current_public_host() {
            return internal.subdomain_url(&public_host);
        }
    }
    internal.launch_url(&state.internal_apps_loopback_host)
}

/// Render an external app's launch target: resolve the served origin (or
/// the tunnel's verified origin for a `requires_tunnel` launch), substitute
/// `{origin}` / `{launch}` in the stored [`AppUrl`] template, append the
/// `?tunnel=unavailable` flag if a tunnel launch fell back to loopback.
async fn render_external_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    app: &AppEntry,
) -> String {
    let (origin, tunnel_unavailable) =
        resolve_origin(state, provenance, app.requires_tunnel).await;
    let launch = random_id_21();
    app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
        tunnel_unavailable,
    })
}

/// Resolve the launch origin and the `tunnel_unavailable` flag.
///
/// A non-tunnel launch resolves to the *served* origin: the forwarded public
/// origin from `provenance` when the trusted front relayed the request, else
/// loopback — so the `302`'s `Location` is something the caller can actually
/// reach. A `requires_tunnel` launch asks the `TunnelService` to start:
/// `Ok(origin)` is the live verified origin; `Err(_)` means the tunnel
/// couldn't be brought up, so it falls back to loopback and flags
/// `?tunnel=unavailable` for the SPA banner.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> (String, bool) {
    if !requires_tunnel {
        let origin = match provenance {
            RequestProvenance::Forwarded { origin } => origin.clone(),
            RequestProvenance::Loopback => state.loopback_origin.clone(),
        };
        return (origin, false);
    }
    match state.tunnel.try_start().await {
        Ok(origin) => (origin, false),
        Err(reason) => {
            // The wire only carries a coarse `?tunnel=unavailable` flag, but the
            // reason distinguishes "no relay configured" from "dial timed out"
            // from "daemon stopped" — log it so an unavailable launch is
            // diagnosable rather than silently swallowed.
            tracing::warn!(%reason, "tunnel launch fell back to loopback");
            (state.loopback_origin.clone(), true)
        }
    }
}

/// 302 response with the given location, plus a `Content-Type` of
/// `text/html; charset=utf-8` to match the TS contract (`HttpApiSchema.Text`
/// with that content-type). The body is empty — the redirect is the whole
/// signal. A failure here means the rendered URL contained a byte the header
/// codec rejected; surfaces as a logged 500 (never a handler panic).
fn redirect(location: String) -> Result<Response, HandlerError> {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, &location)
        .header("content-type", "text/html; charset=utf-8")
        .body(axum::body::Body::empty())
        .map_err(|e| HandlerError::internal("redirect builder failed", e))
}

/// 204 No Content with an empty body — the response when a host [`LaunchSink`]
/// has taken the launch (the host opened the URL; there's nothing for the SPA
/// to follow). `StatusCode::NO_CONTENT.into_response()` already yields an empty
/// body, so no header juggling is needed.
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
