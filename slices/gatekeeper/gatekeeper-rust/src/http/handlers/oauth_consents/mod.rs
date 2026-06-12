//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`),
//! each exposing a `MethodRouter`; shared DTOs and helpers live in
//! [`internal`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;
mod internal;

use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/oauth-consents/{id}", get::route())
        .route("/oauth-consents/{id}/approve", approve::route())
        .route("/oauth-consents/{id}/deny", deny::route())
}
