//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Every app is the same shape: a stored [`AppUrl`]
//! template with `{origin}` and `{launch}` placeholders. The handler:
//!
//!   1. Loads the row (404 if absent).
//!   2. Reads the request's [`RequestProvenance`] *once* — both "is this a
//!      remote caller?" (decides sink vs. redirect) and "what origin do we
//!      render?" derive from the same single header read, so an empty/spoofed
//!      `x-public-origin` can't make the two answers disagree.
//!   3. Resolves the served origin through the tunnel seam — see
//!      [`resolve_origin`].
//!   4. Renders the launch target through [`AppUrl::to_url_with_params`],
//!      which substitutes the placeholders and is safe by construction (an
//!      origin-relative target stays same-origin, an external one stays on
//!      its `https://` authority) — so there's no launch-time re-validation:
//!      the stored value was validated when it was parsed into an [`AppUrl`].
//!   5. Dispatches the target: when a [`LaunchSink`](crate::LaunchSink) is
//!      installed (the Tauri host) *and* the caller is loopback (a local
//!      webview that a host popup can actually serve), it hands the URL to
//!      the sink and `204`s; otherwise it returns a `302` redirect for the
//!      browser to follow.
//!
//! `requires_tunnel` is honoured through the shared `TunnelService` contract:
//! the launch asks the tunnel to start and resolves to its live *verified*
//! origin, or — when the tunnel can't be brought up — falls back to the loopback
//! origin with `?tunnel=unavailable` so the SPA can surface a banner. A
//! non-tunnel launch resolves to the *served* origin — loopback for a direct
//! caller, the forwarded public origin for a request the trusted front relayed
//! — so a redirect handed back to a remote browser is reachable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::LaunchParams;
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
    let app = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    // Single read of the forwarding headers — both decisions below derive
    // from this one value, so an empty/spoofed `x-public-origin` can't make
    // them disagree (a header that fails validation reads as Loopback).
    let provenance = request_provenance(&headers);
    let (origin, tunnel_unavailable) =
        resolve_origin(&state, &provenance, app.requires_tunnel).await;
    let launch = random_id_21();
    let target = app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
        tunnel_unavailable,
    });
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
