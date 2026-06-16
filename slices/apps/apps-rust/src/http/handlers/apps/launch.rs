//! `GET /apps/{id}` — resolve an app id to a redirect target.
//!
//! Three shapes of target:
//!
//!   1. The FHIR-sharing action and any bundled `action` kind: redirect to
//!      the served origin (the loopback origin, until a real tunnel seam is
//!      wired in).
//!   2. A bundled `bundled` row: invoke the registry's `build_url` with the
//!      served origin and a fresh launch nonce.
//!   3. A custom row: substitute `{origin}` (and `{launch}`) into its
//!      stored URL.
//!
//! For (2) and (3) the resolved URL is re-validated through
//! [`is_launchable_url`] before being emitted — defence-in-depth against
//! a row that was inserted out-of-band with a non-https target.
//!
//! `requires_tunnel` is honoured through a no-op seam ([`resolve_origin`]):
//! until tunnel-rust exposes a served-origin reader the loopback origin is
//! used unconditionally, and a `requires_tunnel` launch appends
//! `?tunnel=unavailable` so the SPA can surface a banner. This matches the
//! TS `resolveLaunchOrigin` behaviour and is the hook for the eventual
//! tunnel-rust integration.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::header::LOCATION;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, MethodRouter};
use rand::distr::Alphanumeric;
use rand::Rng;

use crate::db::AppRow;
use crate::domain::{find_bundled, BundledKind, FHIR_SHARING_ID};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    get(handle_launch_app)
}

async fn handle_launch_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Response, HandlerError> {
    let row = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?;

    let context = resolve_launch_context(&id, row.as_ref())
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    // Until tunnel-rust grows a served-origin reader, every launch resolves
    // to the loopback origin. A `requires_tunnel` launch flags the SPA so
    // it can surface a "tunnel unavailable" banner.
    let (origin, tunnel_unavailable) =
        resolve_origin(&state.loopback_origin, context.requires_tunnel);

    // The FHIR-sharing action (and any other action kind) redirects straight
    // to the served origin — no further URL building, no launch nonce.
    if id == FHIR_SHARING_ID || context.is_action {
        let target = if tunnel_unavailable {
            append_tunnel_unavailable(&origin)
        } else {
            origin
        };
        return Ok(redirect(target));
    }

    let launch = launch_nonce();
    let resolved = (context.build_url)(&origin, &launch);
    if !is_launchable_url(&resolved, &origin) {
        tracing::warn!(
            "[apps-rust] LaunchApp rejected resolved URL for {}: {}",
            id,
            resolved,
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

/// A closure that takes the served `origin` and a launch nonce and returns
/// the target URL to redirect to. Boxed because the custom-row path closes
/// over the row's stored URL string.
type UrlBuilder = Box<dyn Fn(&str, &str) -> String + Send>;

/// What the launch handler needs from a resolved row: how to build the
/// target URL, whether the app requires the tunnel, and whether it's a
/// no-op action (in which case `build_url` is never called).
struct LaunchContext {
    build_url: UrlBuilder,
    requires_tunnel: bool,
    is_action: bool,
}

/// Map an id (plus its row, if any) to a [`LaunchContext`]. `None` when
/// the id has no bundled-registry entry AND no custom row — that's a 404.
fn resolve_launch_context(id: &str, row: Option<&AppRow>) -> Option<LaunchContext> {
    if let Some(bundled) = find_bundled(id) {
        return Some(LaunchContext {
            build_url: Box::new(move |origin, launch| (bundled.build_url)(origin, launch)),
            requires_tunnel: bundled.requires_tunnel,
            is_action: matches!(bundled.kind, BundledKind::Action),
        });
    }
    let row = row?;
    if row.kind != "custom" {
        return None;
    }
    let url = row.custom_url.clone()?;
    let requires_tunnel = row.custom_requires_tunnel.unwrap_or(false);
    Some(LaunchContext {
        build_url: Box::new(move |origin, launch| {
            url.replace("{origin}", origin).replace("{launch}", launch)
        }),
        requires_tunnel,
        is_action: false,
    })
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

/// Defence-in-depth at launch time. `validate_custom_url` rejects bad
/// shapes on write, but `LaunchApp` re-validates the *resolved* URL — after
/// `{origin}` interpolation — so a row whose template produced a weird URL
/// can't 302 to it. Acceptable targets:
///
///   * Any URL sharing the live origin (`origin_prefix`) — covers the
///     bundled apps that build against the loopback host as well as a
///     custom app whose template resolves to `/path` or `{origin}/path`.
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
