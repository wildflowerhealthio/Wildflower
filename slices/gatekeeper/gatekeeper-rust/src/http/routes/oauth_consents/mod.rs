//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`),
//! each exposing a `MethodRouter`; the wire DTOs live in
//! [`crate::http::wire_representations`] and the pending-request loader in
//! [`crate::domain::actions`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;

use axum::Router;

use crate::http::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth-consents/{id}", get::route())
        .route("/oauth-consents/{id}/approve", approve::route())
        .route("/oauth-consents/{id}/deny", deny::route())
}
