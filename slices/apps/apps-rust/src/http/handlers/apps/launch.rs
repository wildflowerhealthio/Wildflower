//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! One store ([`AppsStore`](crate::db::AppsStore)) backs both halves of the
//! id-space, across two tables:
//!
//!   * **Internals** (`internal_apps`, via
//!     [`find_internal_app`](crate::db::AppsStore::find_internal_app)) —
//!     locally-served apps with a fixed origin per row. A loopback caller
//!     gets `http://{host}:{port}/` (from host config + the row's `port`);
//!     a forwarded caller (one whose `Forwarded` header indicates the
//!     trusted front relayed the request) gets the matching public-origin
//!     URL `https://{id}.{public_host}/` — the same shape the host's
//!     subdomain dispatch matches inbound. So a remote browser launching
//!     the app follows the redirect back through the relay rather than
//!     chasing a loopback IP it can't reach. A forwarded launch with **no
//!     public host configured** can't build a reachable subdomain, so it
//!     fails with `503 LaunchUnavailable` rather than handing the remote
//!     browser a loopback URL it can't follow. No `{origin}` / `{launch}`
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
//!      `Forwarded` host can't make the two answers disagree.
//!   3. Render the launch target (internal: from config; external: through
//!      `AppUrl`). This step can fail with `503 LaunchUnavailable` when no
//!      *reachable* target exists (a forwarded launch with no public host, or a
//!      `requires_tunnel` app while the tunnel is down) — the launch returns the
//!      error rather than a dead redirect / a popup pointed at an origin the
//!      caller can't reach.
//!   4. Dispatch on provenance: a loopback (local) caller hands the URL to the
//!      host's [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) — which
//!      opens a native popup a local webview can actually serve — and `204`s; a
//!      forwarded (remote) caller gets a `302` redirect for the browser to
//!      follow.
//!
//! `requires_tunnel` applies only to externals: the launch asks the tunnel
//! to start and resolves to its live *verified* origin, or — when the tunnel
//! can't be brought up — fails with `503 LaunchUnavailable`. (The third-party
//! `https` app needs the tunnel to reach the user's FHIR server at all, so a
//! popup/redirect pointed at the loopback origin would silently fail; the
//! error lets the SPA surface the failure instead.) A non-tunnel external
//! launch resolves to the *served* origin — loopback for a direct caller, the
//! forwarded public origin for a request the trusted front relayed — so a
//! redirect handed back to a remote browser is reachable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use shared_structures_rust::served_origin::{request_provenance, RequestProvenance};

use crate::domain::{AppEntry, InternalApp, LaunchParams};
use crate::http::response_templates::{AppNotFoundBody, HandlerError, LaunchUnavailableBody};
use crate::http::state::AppsState;
use crate::id::mint_launch_nonce;

/// `POST /apps/{id}` — launch an app. `404` if no app has this id. Reachable
/// unauthenticated (the webview follows the redirect).
///
/// A loopback (local) caller hands the resolved URL to the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle), which opens it in a
/// native popup *on this device* (returning `204` so the SPA stays mounted) —
/// that only helps a local caller, which is why it's gated on loopback. A
/// request **forwarded by the trusted front** (the relay/tunnel sets the
/// `Forwarded` header) is a *remote* caller, for whom a host-side popup is
/// invisible; it gets the `302` redirect instead.
#[utoipa::path(
    post,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 204, description = "Host sink opened the launch URL for a loopback caller (no redirect)"),
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 503, description = "No reachable launch target (forwarded launch with no public host, or a requires_tunnel app while the tunnel is down)", body = LaunchUnavailableBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    // Single read of the forwarding headers — both decisions below derive
    // from this one value, so an empty/spoofed `Forwarded` host can't make
    // them disagree (a header that fails validation reads as Loopback).
    let provenance = request_provenance(&headers);

    // Resolve before dispatching: an unreachable target (forwarded launch with
    // no public host, or a `requires_tunnel` app while the tunnel is down) bails
    // here with `503 LaunchUnavailable` rather than opening a doomed popup /
    // emitting a dead redirect.
    let (name, target_url) = resolve_launch_target(&state, &id, &provenance).await?;

    // The loopback-only rule lives in this match: only a loopback caller is
    // handed to the on-device webview seam (a host popup is useless to a remote
    // caller); a forwarded caller takes the redirect.
    //
    // Defense-in-depth note: the popup is a host-side side-effect on the owner's
    // device, and `Loopback` here is only the *absence* of a valid `Forwarded`
    // header — header-derived, so it must not be the sole gate. The network-layer
    // backstop is the host's loopback-peer gate (gatekeeper's `loopback_gate`,
    // applied to the whole `api_router` in `wildflower-tauri/src/lib.rs`): a
    // request from a non-loopback peer is rejected with 403 (and logged) before
    // this handler runs, so a `Loopback` classification can only come from a
    // genuine loopback peer (the trusted front relays remote callers from
    // loopback too, but those always carry `Forwarded` and so read as
    // `Forwarded`, not `Loopback`).
    match &provenance {
        // Loopback (local) caller: the host owns the side-effect — hand it the
        // resolved URL (it opens a native popup) and 204 so the SPA stays
        // mounted. The seam is contractually fire-and-forget (the Tauri impl
        // spawns the blocking webview-open onto a blocking thread, so this call
        // returns promptly).
        RequestProvenance::Loopback => {
            state.on_device_webview_handle.open(name, target_url);
            Ok(no_content())
        }
        RequestProvenance::Forwarded { .. } => redirect(target_url),
    }
}

/// Resolve `id` to its `(app name, launch target)`. The name is only for the
/// loopback popup's chrome; the launch URL is the provenance-aware target.
/// Internals win on id collision — looked up first (the only path that puts an
/// internal and an external row at the same id is a pre-migration-002 edit; see
/// the list-merge handler) — then externals; `404` if absent from both,
/// `503` if the matched app has no reachable target.
///
/// Internals get a provenance-aware fixed URL: a loopback caller redirects to
/// the per-app loopback listener, a forwarded caller to the public subdomain so
/// the remote browser can follow it through the relay. Externals resolve their
/// `AppUrl` template through the tunnel/served origin.
async fn resolve_launch_target(
    state: &AppsState,
    id: &str,
    provenance: &RequestProvenance,
) -> Result<(String, String), HandlerError> {
    if let Some(internal) = state
        .store
        .find_internal_app(id)
        .map_err(|e| HandlerError::internal("internal_apps find lookup failed", e))?
    {
        let target_url = render_internal_target(&internal, state, provenance)?;
        // Only the name escapes — the handler reads it for the popup chrome. The
        // launch URL is the provenance-aware `target_url` above (loopback for a
        // local caller, the public subdomain for a forwarded one).
        return Ok((internal.name, target_url));
    }

    let external = state
        .store
        .find_app(id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.to_owned() })?;
    let target_url = render_external_target(state, provenance, &external).await?;
    Ok((external.name, target_url))
}

/// Render an internal app's launch target. A loopback caller gets the loopback
/// `http://{host}:{port}/`. A forwarded (remote) caller gets
/// `https://{id}.{public_host}/` — the same subdomain shape the host's
/// subdomain dispatch routes inbound — when a `public_host` is configured;
/// with **no** `public_host` there is no reachable target (a loopback URL the
/// remote browser can't follow), so the launch fails with
/// `503 LaunchUnavailable` rather than handing back a dead redirect.
fn render_internal_target(
    internal: &InternalApp,
    state: &AppsState,
    provenance: &RequestProvenance,
) -> Result<String, HandlerError> {
    if matches!(provenance, RequestProvenance::Forwarded { .. }) {
        let Some(public_host) = state.tunnel.current_public_host() else {
            return Err(HandlerError::Unavailable {
                reason: "no public host is configured for this remote launch".to_owned(),
            });
        };
        return Ok(internal.subdomain_url(&public_host));
    }
    Ok(internal.launch_url(&state.loopback_hostname))
}

/// Render an external app's launch target: resolve the served origin (or
/// the tunnel's verified origin for a `requires_tunnel` launch), then
/// substitute `{origin}` / `{launch}` in the stored [`AppUrl`] template.
/// Fails with `503 LaunchUnavailable` when a `requires_tunnel` launch can't
/// bring the tunnel up (see [`resolve_origin`]).
async fn render_external_target(
    state: &AppsState,
    provenance: &RequestProvenance,
    app: &AppEntry,
) -> Result<String, HandlerError> {
    let origin = resolve_origin(state, provenance, app.requires_tunnel).await?;
    let launch = mint_launch_nonce();
    Ok(app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
    }))
}

/// Resolve the launch origin.
///
/// A non-tunnel launch resolves to the *served* origin: the forwarded public
/// origin from `provenance` when the trusted front relayed the request, else
/// loopback — so the `302`'s `Location` is something the caller can actually
/// reach. A `requires_tunnel` launch asks the `TunnelService` to start:
/// `Ok(origin)` is the live verified origin; `Err(reason)` means the tunnel
/// couldn't be brought up — and since the third-party app needs the tunnel to
/// reach the user's FHIR server, there is no reachable origin to fall back to,
/// so the launch fails with `503 LaunchUnavailable` rather than pointing the
/// app at an unreachable loopback origin.
async fn resolve_origin(
    state: &AppsState,
    provenance: &RequestProvenance,
    requires_tunnel: bool,
) -> Result<String, HandlerError> {
    if !requires_tunnel {
        let origin = match provenance {
            RequestProvenance::Forwarded { origin } => origin.clone(),
            RequestProvenance::Loopback => state.loopback_origin.clone(),
        };
        return Ok(origin);
    }
    state.tunnel.try_start().await.map_err(|reason| {
        // The reason distinguishes "no relay configured" from "dial timed out"
        // from "daemon stopped" — log it so an unavailable launch is diagnosable,
        // and carry it into the 503 body for the SPA.
        tracing::warn!(%reason, "requires_tunnel launch failed: tunnel unavailable");
        HandlerError::Unavailable { reason }
    })
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

/// 204 No Content with an empty body — the response when the host's
/// [`OnDeviceWebviewHandle`](crate::OnDeviceWebviewHandle) has taken the launch
/// (the host opened the URL; there's nothing for the SPA to follow).
/// `StatusCode::NO_CONTENT.into_response()` already yields an empty body, so no
/// header juggling is needed.
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}
