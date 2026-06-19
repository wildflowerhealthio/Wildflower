//! `GET /apps/{id}` — resolve an app id to a redirect target.
//!
//! Every app is the same shape: a stored [`AppUrl`]
//! template with `{origin}` and `{launch}` placeholders. The handler:
//!
//!   1. Loads the row (404 if absent).
//!   2. Resolves the served origin through the (currently no-op) tunnel
//!      seam — see [`resolve_origin`].
//!   3. Renders the redirect target through [`AppUrl::to_url_with_params`],
//!      which substitutes the placeholders and is safe by construction (an
//!      origin-relative target stays same-origin, an external one stays on
//!      its `https://` authority) — so there's no launch-time re-validation:
//!      the stored value was validated when it was parsed into an [`AppUrl`].
//!
//! `requires_tunnel` is honoured through the same no-op seam: the loopback
//! origin is used unconditionally for now, and a `requires_tunnel` launch
//! appends `?tunnel=unavailable` so the SPA can surface a banner. This is
//! the hook for the eventual tunnel-rust integration where a
//! `requires_tunnel` launch would resolve to the live `servedOrigin`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::StatusCode;
use axum::response::Response;
use rand::distr::Alphanumeric;
use rand::Rng;

use crate::domain::LaunchParams;
use crate::http::response_templates::{AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;

/// `GET /apps/{id}` — 302 to the resolved launch URL, or 404 if no app has
/// this id. Reachable unauthenticated (the webview follows the redirect).
#[utoipa::path(
    get,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 302, description = "Redirect (Location header) to the resolved launch URL"),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    let app = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    let (origin, tunnel_unavailable) = resolve_origin(&state.loopback_origin, app.requires_tunnel);
    let launch = launch_nonce();
    let target = app.url.to_url_with_params(&LaunchParams {
        origin: &origin,
        launch: &launch,
        tunnel_unavailable,
    });
    Ok(redirect(target))
}

/// NO-OP tunnel seam — mirrors the TS `resolveLaunchOrigin`. Always returns
/// the loopback origin; the second tuple element flags the caller to append
/// `?tunnel=unavailable` when the launch wanted a tunnel that isn't there.
///
/// This is the hook for the future tunnel-rust integration: when that
/// lands, `requires_tunnel = true` will resolve to the live `servedOrigin`
/// (and `tunnel_unavailable` will only flip true on the timeout/fallback
/// path).
fn resolve_origin(loopback_origin: &str, requires_tunnel: bool) -> (String, bool) {
    (loopback_origin.to_owned(), requires_tunnel)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_nonce_is_alphanumeric_and_21_chars() {
        let n = launch_nonce();
        assert_eq!(n.len(), 21);
        assert!(n.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
