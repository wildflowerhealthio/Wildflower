//! `/devices/{userCode}` routes — the Owner-facing consent prompt for the
//! device-code flow (RFC 8628). One module per route (`get`, `approve`,
//! `deny`), each exposing a `MethodRouter`; shared DTOs and the request loader
//! live in [`internal`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;
mod internal;

use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/devices/{userCode}", get::route())
        .route("/devices/{userCode}/approve", approve::route())
        .route("/devices/{userCode}/deny", deny::route())
}
