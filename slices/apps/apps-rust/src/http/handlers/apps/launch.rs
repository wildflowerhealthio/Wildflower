//! `GET /apps/{id}` — resolve an app id to a redirect target.
//!
//! Every app — bundled or custom — is the same shape: a stored URL template
//! with `{origin}` and `{launch}` placeholders. The handler:
//!
//!   1. Loads the row (404 if absent).
//!   2. Resolves the served origin through the (currently no-op) tunnel
//!      seam — see [`resolve_origin`].
//!   3. Substitutes `{origin}` and `{launch}` into the stored URL.
//!   4. Re-validates the resolved URL through [`is_launchable_url`] before
//!      emitting the 302. This defence-in-depth catches a row whose URL
//!      passed the write-side filter but resolves to something we can't
//!      safely redirect to (e.g. an `http://` host after substitution).
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
use axum::routing::{get, MethodRouter};
use rand::distr::Alphanumeric;
use rand::Rng;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    get(handle_launch_app)
}

async fn handle_launch_app(
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
    let resolved = app
        .url
        .replace("{origin}", &origin)
        .replace("{launch}", &launch);

    if !is_launchable_url(&resolved, &origin) {
        tracing::warn!(
            app_id = %id,
            resolved = %resolved,
            "LaunchApp rejected a resolved URL that failed the launch-time guard",
        );
        return Err(HandlerError::NotFound { id });
    }

    let target = if tunnel_unavailable {
        append_tunnel_unavailable(&resolved)
    } else {
        resolved
    };
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

/// Append `?tunnel=unavailable` to `target` so the SPA can surface a banner.
///
/// Uses string manipulation rather than `url::Url`: bundled launch URLs
/// (e.g. growth-chart, medication-viewer) carry raw colons / slashes in
/// their `iss=` query values that round-tripping through `Url` would
/// percent-encode — downstream consumers expect the un-encoded form.
fn append_tunnel_unavailable(target: &str) -> String {
    let param = "tunnel=unavailable";
    let (base, hash) = match target.find('#') {
        Some(idx) => (&target[..idx], &target[idx..]),
        None => (target, ""),
    };
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}{param}{hash}")
}

/// Defence-in-depth at launch time. `validate_app_url` rejects bad shapes
/// on write, but the launch handler re-validates the *resolved* URL —
/// after `{origin}` interpolation — so a row whose template produced a
/// weird URL can't 302 to it. Acceptable targets:
///
///   * Any URL sharing the live origin (`origin_prefix`) — covers
///     bundled-style apps that resolve to the loopback host as well as
///     `/path`-shaped URLs.
///   * Any absolute `https://` URL — for off-device targets (growth-chart,
///     medication-viewer, third-party custom apps).
///
/// Anything else is treated as "not found" by the caller to avoid leaking
/// a distinct rejection signal.
fn is_launchable_url(target: &str, origin_prefix: &str) -> bool {
    if target.starts_with(origin_prefix) {
        return true;
    }
    target.starts_with("https://")
}

/// 21-char base62-ish nonce — close enough to nanoid (the TS handler's
/// `launch` source) without pulling in a fresh crate. The launch nonce is
/// opaque to this slice; bundled launch URLs forward it to the SMART-on-FHIR
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
    fn append_tunnel_unavailable_handles_query_hash_and_bare_url() {
        assert_eq!(
            append_tunnel_unavailable("http://x/y"),
            "http://x/y?tunnel=unavailable"
        );
        assert_eq!(
            append_tunnel_unavailable("http://x/y?z=1"),
            "http://x/y?z=1&tunnel=unavailable"
        );
        assert_eq!(
            append_tunnel_unavailable("http://x/y#hash"),
            "http://x/y?tunnel=unavailable#hash"
        );
        assert_eq!(
            append_tunnel_unavailable("http://x/y?z=1#hash"),
            "http://x/y?z=1&tunnel=unavailable#hash"
        );
    }

    #[test]
    fn is_launchable_url_accepts_origin_prefix_and_https_only() {
        assert!(is_launchable_url(
            "http://127.0.0.1:8080/x",
            "http://127.0.0.1:8080"
        ));
        assert!(is_launchable_url(
            "https://example.com/x",
            "http://127.0.0.1:8080"
        ));
        // `http://` to a foreign host is rejected
        assert!(!is_launchable_url(
            "http://evil.example.com/",
            "http://127.0.0.1:8080"
        ));
        // `javascript:` and friends — none of them start with the origin or `https://`
        assert!(!is_launchable_url(
            "javascript:alert(1)",
            "http://127.0.0.1:8080"
        ));
    }

    #[test]
    fn launch_nonce_is_alphanumeric_and_21_chars() {
        let n = launch_nonce();
        assert_eq!(n.len(), 21);
        assert!(n.chars().all(|c| c.is_ascii_alphanumeric()));
    }
}
