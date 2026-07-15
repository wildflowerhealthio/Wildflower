//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`),
//! each exposing a `MethodRouter`; the DTOs shared with the device flow
//! (`ApproveBody`, `ConsentResult`) live in [`crate::http::wire_representations`],
//! the `get` response shape beside its route, and the consent logic in
//! [`crate::domain::actions`]. `router()` is the only path table.

mod approve;
mod deny;
mod get;

use std::sync::Arc;

use axum::Router;

use crate::http::state::GatekeeperState;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new()
        .route("/oauth-consents/{id}", get::route())
        .route("/oauth-consents/{id}/approve", approve::route())
        .route("/oauth-consents/{id}/deny", deny::route())
}
