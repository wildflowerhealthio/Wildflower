//! The gatekeeper's HTTP layer — everything axum-shaped lives under this
//! module. The only crate-facing surface is [`router`], [`gate`],
//! [`AppState`], and the origin-resolution types; the handler and
//! middleware files are private implementation detail behind the route
//! table.

mod error_pages;
mod gate;
mod handlers;
mod middleware;
pub mod origin;
mod page_paths;
mod state;

pub use gate::gate;
pub use middleware::require_auth::AuthedClaims;
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
    let well_known = Router::new().nest("/.well-known", handlers::jwks::router());
    let oauth = handlers::oauth::router();
    let access = Router::new()
        .merge(handlers::access_management::router())
        .merge(handlers::oauth_consent::router())
        .merge(handlers::devices::router())
        .layer(axum_middleware::from_fn(middleware::require_owner_auth));

    Router::new()
        .merge(well_known)
        .nest("/oauth", oauth)
        .nest("/access", access)
        .layer(axum_middleware::from_fn(middleware::loopback_gate))
        .layer(Extension(state))
}
