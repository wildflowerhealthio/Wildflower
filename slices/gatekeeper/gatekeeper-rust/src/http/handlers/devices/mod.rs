//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; shared DTOs and the request loader
//! live in [`internal`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;
mod internal;

use axum::Router;

use crate::http::state::AppState;

/// Build the `/devices/{userCode}` consent routes. The per-IP throttle on the
/// short `user_code` they look up is layered on at the router-assembly site
/// ([`crate::http::router`]) — ahead of the owner-auth gate — rather than here,
/// so it isn't entangled with these route definitions.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices/{userCode}", get::route())
        .route("/devices/{userCode}/approve", approve::route())
        .route("/devices/{userCode}/deny", deny::route())
}
