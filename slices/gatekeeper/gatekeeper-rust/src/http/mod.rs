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

pub(crate) use origin::served_origin_for;
pub use state::AppState;

use axum::extract::Extension;
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
        .merge(handlers::devices::router())
        .layer(axum_middleware::from_fn(middleware::require_owner_auth));

    Router::new()
        .route(
            "/.well-known/jwks.json",
            handlers::jwks::handle_get_jwks_request(),
        )
        .nest("/oauth", oauth)
        .nest("/access", access)
        .layer(axum_middleware::from_fn(middleware::loopback_gate))
        .layer(Extension(state))
}

/// Wrap a router (e.g. emr-rust's FHIR router) with JWT verification
/// against the gatekeeper's signing keys. Any request missing or
/// presenting an invalid bearer token gets 401.
pub fn layer_router_with_gatekeeper_auth_gating(router: Router, state: AppState) -> Router {
    router
        .layer(axum_middleware::from_fn(
            middleware::require_valid_bearer_token,
        ))
        .layer(Extension(state))
}
