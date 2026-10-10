//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`),
//! each exposing a `MethodRouter`; the DTO shared with the device flow
//! (`ConsentResult`) lives in [`crate::http::wire_representations`], the `get`
//! response shape and the approve body beside their routes (both carry the
//! registration verdict this flow alone has), and the consent logic in
//! `domain::capabilities`. `router()` is the only path table.

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
