//! `POST /apps/{id}` — resolve an app id to a launch target.
//!
//! Every app is the same shape: a stored [`AppUrl`]
//! template with `{origin}` and `{launch}` placeholders. The handler:
//!
//!   1. Loads the row (404 if absent).
//!   2. Resolves the served origin through the tunnel seam — see
//!      [`resolve_origin`].
//!   3. Renders the launch target through [`AppUrl::to_url_with_params`],
//!      which substitutes the placeholders and is safe by construction (an
//!      origin-relative target stays same-origin, an external one stays on
//!      its `https://` authority) — so there's no launch-time re-validation:
//!      the stored value was validated when it was parsed into an [`AppUrl`].
//!   4. Dispatches the target: when a [`LaunchSink`](crate::LaunchSink) is
//!      installed (the Tauri host) it hands the URL to the sink — which opens
//!      it in a native webview popup — and `204`s; otherwise it returns a
//!      `302` redirect for the browser to follow.
//!
//! `requires_tunnel` is honoured through the shared `TunnelService` contract:
//! the launch asks the tunnel to start and resolves to its live *verified*
//! origin, or — when the tunnel can't be brought up — falls back to the loopback
//! origin with `?tunnel=unavailable` so the SPA can surface a banner. A
//! non-tunnel launch always uses the loopback origin.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rand::distr::Alphanumeric;
use rand::Rng;

use crate::domain::LaunchParams;
use crate::http::response_templates::{AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;

/// `POST /apps/{id}` — launch an app. `404` if no app has this id. Reachable
/// unauthenticated (the webview follows the redirect).
///
/// A host [`LaunchSink`](crate::LaunchSink) opens the resolved URL in a native
/// popup *on this device*, which only helps the **local** caller — so the sink
/// is used (returning `204`) only when the request came in over loopback. A
/// request **forwarded by the trusted front** (the relay/tunnel sets
/// `x-public-origin`) is a *remote* caller, for whom a host-side popup is
/// invisible; it gets the `302` redirect instead, the same as a host that
/// installs no sink at all (web/standalone). See [`request_is_forwarded`].
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

    let (origin, tunnel_unavailable) = resolve_origin(&state, app.requires_tunnel).await;
    let launch = launch_nonce();
    let target = app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
        tunnel_unavailable,
    });
    match &state.launch_sink {
        // Loopback caller + a host sink: the host owns the side-effect — hand it
        // the resolved URL (it opens a native popup) and 204 so the SPA stays
        // mounted. Fire-and-forget; the sink logs any failure. A forwarded
        // (remote) request, or no sink at all, falls through to the redirect.
        Some(sink) if !request_is_forwarded(&headers) => {
            sink.open(&app, &target);
            Ok(no_content())
        }
        _ => Ok(redirect(target)),
    }
}

/// Whether the request was forwarded by the trusted front (the relay/tunnel),
/// rather than arriving directly over loopback. Keys on the `x-public-origin`
/// header the front sets on forwarded requests — the same signal
/// `gatekeeper_rust`'s `served_origin_for` uses to resolve the served origin
/// (and that `wildflower-relay` sets). A forwarded request is a remote caller,
/// so the launch redirects it rather than popping a webview on the host device.
fn request_is_forwarded(headers: &HeaderMap) -> bool {
    headers.contains_key("x-public-origin")
}

/// Resolve the launch origin and the `tunnel_unavailable` flag.
///
/// A non-tunnel launch uses the loopback origin (never unavailable). A
/// `requires_tunnel` launch asks the `TunnelService` to start:
/// `Ok(origin)` is the live verified origin; `Err(_)` means the tunnel couldn't
/// be brought up, so it falls back to loopback and flags `?tunnel=unavailable`
/// for the SPA banner.
async fn resolve_origin(state: &AppsState, requires_tunnel: bool) -> (String, bool) {
    if !requires_tunnel {
        return (state.loopback_origin.clone(), false);
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

/// 21-char base62-ish nonce — close enough to nanoid (the TS handler's
/// `launch` source) without pulling in a fresh crate. The launch nonce is
/// opaque to this slice; some launch URLs forward it to the SMART-on-FHIR
/// authorize endpoint where it's checked against the AS-issued value.
fn launch_nonce() -> String {
    rand::rng()
        .sample_iter(&Alphanumeric)
        .take(21)
        .map(char::from)
        .collect()
}

/// 302 response with the given location, plus a `Content-Type` of
/// `text/html; charset=utf-8` to match the TS contract (`HttpApiSchema.Text`
/// with that content-type). The body is empty — the redirect is the whole
/// signal.
fn redirect(location: String) -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(LOCATION, &location)
        .header("content-type", "text/html; charset=utf-8")
        .body(axum::body::Body::empty())
        // Builder errors come from an invalid header value (e.g. non-ASCII
        // in `location`). Our launches build URLs from validated inputs and
        // an alphanumeric nonce — none of which can contain non-visible
        // ASCII. A failure here is a bug in the URL builder, not user input.
        .expect("redirect builder failed on a validated URL")
}

/// 204 No Content with an empty body — the response when a host [`LaunchSink`]
/// has taken the launch (the host opened the URL; there's nothing for the SPA
/// to follow). `StatusCode::NO_CONTENT.into_response()` already yields an empty
/// body, so no header juggling is needed.
fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_nonce_is_alphanumeric_and_21_chars() {
        let n = launch_nonce();
        assert_eq!(n.len(), 21);
        assert!(n.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn request_is_forwarded_keys_on_the_public_origin_header() {
        // A direct loopback request carries no forwarding header.
        assert!(!request_is_forwarded(&HeaderMap::new()));
        // The trusted front sets `x-public-origin` on forwarded (remote) requests.
        let mut forwarded = HeaderMap::new();
        forwarded.insert("x-public-origin", "emr.example.com".parse().unwrap());
        assert!(request_is_forwarded(&forwarded));
    }
}
