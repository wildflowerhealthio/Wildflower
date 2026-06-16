//! The apps slice's HTTP surface. Two routers — the public one (list +
//! launch) the webview consumes unauthenticated and the admin one (create /
//! update / delete) the consumer wraps with the gatekeeper. `setup_apps`
//! returns both so the host can `.merge()` the public one and
//! `layer_router_with_gatekeeper_auth_gating` the admin one. Mirrors the way
//! gatekeeper-rust separates `/oauth` from `/access`.

mod handlers;
mod response_templates;
mod state;

pub use state::AppsState;

use std::sync::Arc;

use axum::Router;

/// Build the public `/apps` router (`GET /apps`, `GET /apps/{id}`). Owner
/// auth is NOT applied — both endpoints are reachable by embedded webviews
/// and iframes that can't easily carry a bearer token.
pub fn public_router(state: Arc<AppsState>) -> Router {
    handlers::public_router().with_state(state)
}

/// Build the admin `/apps` router (`POST /apps`, `PATCH /apps/{id}`,
/// `DELETE /apps/{id}`). The router itself carries no middleware — the host
/// wraps it with `layer_router_with_gatekeeper_auth_gating` so a future
/// composing app applies its own auth gate.
pub fn admin_router(state: Arc<AppsState>) -> Router {
    handlers::admin_router().with_state(state)
}
