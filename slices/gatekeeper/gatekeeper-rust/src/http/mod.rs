//! The gatekeeper's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`],
//! [`layer_router_with_gatekeeper_auth_gating`], and [`AppState`]; the handler
//! and middleware files are private implementation detail behind the route
//! table.

mod error_pages;
mod handlers;
mod middleware;
mod origin;
mod page_paths;
mod response_templates;
mod state;

pub(crate) use middleware::{user_code_rate_limiter, SlidingWindowRateLimiter};
pub(crate) use origin::{served_origin_for, ServedOrigin};
pub use state::AppState;

use axum::middleware as axum_middleware;
use axum::Router;

/// Build the gatekeeper's public HTTP surface. Routes live at
/// `/.well-known/jwks.json`, `/oauth/*`, and `/access/*` (Owner-only via
/// bearer JWT) — the module owns its mount paths so the caller just
/// `.merge()`s. The whole surface is gated by the loopback middleware —
/// non-loopback peers receive 403 before any handler runs.
pub fn router(state: AppState) -> Router {
    let oauth = handlers::oauth::router();
    let access = Router::new()
        .merge(handlers::grants::router())
        .merge(handlers::oauth_consents::router())
        // The device routes carry their own per-IP throttle on the
        // `user_code`-lookup path; the other `/access` groups don't need it.
        .merge(handlers::devices::router(
            state.user_code_rate_limiter.clone(),
        ))
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            middleware::require_owner_auth,
        ))
        // Outermost on `/access`, so every response — handler output, the
        // owner-auth 401, the rate-limiter 429, a 404 — is cache-suppressed
        // (`no-store` + `Pragma: no-cache`) via the same `CacheSuppressed`
        // wrapper the `/oauth` handlers apply per-response.
        .layer(axum_middleware::from_fn(middleware::cache_suppress));

    Router::new()
        .route(
            "/.well-known/jwks.json",
            handlers::jwks::handle_get_jwks_request(),
        )
        .nest("/oauth", oauth)
        .nest("/access", access)
        .layer(axum_middleware::from_fn(middleware::loopback_gate))
        .with_state(state)
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification
/// against the gatekeeper's signing keys. Any request missing or
/// presenting an invalid bearer token gets 401.
pub fn layer_router_with_gatekeeper_auth_gating(router: Router, state: AppState) -> Router {
    router.layer(axum_middleware::from_fn_with_state(
        state,
        middleware::require_valid_bearer_token,
    ))
}
