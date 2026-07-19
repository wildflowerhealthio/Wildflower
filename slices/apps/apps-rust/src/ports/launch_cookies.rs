//! [`LaunchCookies`] — the host seam that re-scopes the caller's owner session
//! onto the host a **forwarded self-hosted** launch redirects to.
//!
//! A Self-Hosted app reachable remotely lives at its own subdomain
//! `https://<subdomain>.<public_host>/`. The web owner session cookie
//! (`wf_auth`) is **host-only** on `<public_host>`, so it never rides to that
//! subdomain — the app's own origin would carry no owner session. On a forwarded
//! self-hosted launch (`POST /apps/{id}` → `302`) the handler asks this seam for
//! the `Set-Cookie` header values that re-scope the caller's session onto
//! `<public_host>` (`Domain=`, subdomain-inclusive) and attaches them to the
//! redirect, so the browser holds the session on the app's subdomain once it
//! follows the `Location`. It only *widens the scope* of a token the caller
//! already presents; it mints nothing.
//!
//! The host wires the real implementation (the gatekeeper cookie builder) when it
//! builds [`AppsState`](crate::http::AppsState); a host with no cookie-auth path
//! wires the [`NoLaunchCookies`] no-op. apps-rust never learns the `wf_auth`
//! cookie name or format — the seam keeps that in the gatekeeper slice, exactly
//! as [`AppLaunchScopes`](crate::ports::AppLaunchScopes) keeps the SMART
//! client-scope lookup there.

use axum::http::{HeaderMap, HeaderValue};

/// Re-scopes the caller's owner session onto the host a forwarded self-hosted
/// launch opens.
pub trait LaunchCookies: Send + Sync {
    /// The `Set-Cookie` header values that plant the caller's owner session on
    /// `host` (and its subdomains). `headers` is the launch request — the impl
    /// reads whatever session cookie the caller carries and re-emits it
    /// `Domain`-scoped to `host`. Empty when there is nothing to re-scope (the
    /// caller carries no session), so the handler attaches no cookie.
    fn rescope_for_host(&self, headers: &HeaderMap, host: &str) -> Vec<HeaderValue>;
}

/// A no-op [`LaunchCookies`] that plants nothing — for a host with no cookie-auth
/// path, and the default in the slice's own tests. Unlike a fail-open auth stub
/// this is a legitimate production posture (planting no cookie is safe: the app
/// simply isn't pre-authed), so it is a plain impl, not `#[deprecated]`.
#[derive(Debug, Clone, Copy)]
pub struct NoLaunchCookies;

impl LaunchCookies for NoLaunchCookies {
    fn rescope_for_host(&self, _headers: &HeaderMap, _host: &str) -> Vec<HeaderValue> {
        Vec::new()
    }
}
