//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`,
//! `ask_owner`),
//! each exposing a `MethodRouter`; the DTO shared with the device flow
//! (`ConsentResult`) lives in [`crate::http::wire_representations`], the `get`
//! response shape and the approve body beside their routes (both carry the
//! registration verdict this flow alone has), and the consent logic in
//! `domain::capabilities`. `router()` is the only path table.

mod approve;
mod ask_owner;
mod deny;
mod get;

use std::sync::Arc;

use axum::routing::MethodRouter;
use axum::Router;

use crate::http::state::AuthorizationServerState;

/// `defer_start_limit` wraps the `ask-owner` route, which raises a request for
/// the Owner and so spends from the authorization start limit (see
/// [`defer_authorization_start_limit`](crate::http::middleware::defer_authorization_start_limit)).
pub fn router(
    defer_start_limit: impl Fn(
        MethodRouter<Arc<AuthorizationServerState>>,
    ) -> MethodRouter<Arc<AuthorizationServerState>>,
) -> Router<Arc<AuthorizationServerState>> {
    Router::new()
        .route("/oauth-consents/{id}", get::route())
        .route("/oauth-consents/{id}/approve", approve::route())
        .route("/oauth-consents/{id}/deny", deny::route())
        .route(
            "/oauth-consents/{id}/ask-owner",
            defer_start_limit(ask_owner::route()),
        )
}
