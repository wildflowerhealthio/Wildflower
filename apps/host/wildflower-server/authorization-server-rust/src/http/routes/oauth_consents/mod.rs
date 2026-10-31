//! `/oauth-consents/{id}` routes — the Owner-facing consent prompt for the
//! authorization-code flow. One module per route (`get`, `approve`, `deny`,
//! `ask_owner`),
//! each a documented handler; the DTO shared with the device flow
//! (`ConsentResult`) lives in [`crate::http::wire_representations`], the `get`
//! response shape and the approve body beside their routes (both carry the
//! presented client change this flow alone has), and the consent logic in
//! `domain::capabilities`. `openapi_router()` is the only path table.

/// `POST /oauth-consents/{id}/approve`, and the approve body it reads.
mod approve;
/// `POST /oauth-consents/{id}/ask-owner`.
mod ask_owner;
/// `POST /oauth-consents/{id}/deny`.
mod deny;
/// `GET /oauth-consents/{id}`, and the prompt body it answers with.
mod get;

use std::sync::Arc;

use utoipa_axum::router::{OpenApiRouter, UtoipaMethodRouter};
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/oauth-consents` route table, as an `OpenApiRouter` so the spec is
/// collected from the routes that serve traffic. `defer_start_limit` wraps the
/// `ask-owner` route, which raises a request for the Owner and so spends from
/// the authorization start limit (see
/// [`defer_authorization_start_limit`](crate::http::middleware::defer_authorization_start_limit));
/// the spec, which serves nothing, leaves it as it is.
pub(crate) fn openapi_router(
    defer_start_limit: impl Fn(
        UtoipaMethodRouter<Arc<AuthorizationServerState>>,
    ) -> UtoipaMethodRouter<Arc<AuthorizationServerState>>,
) -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(get::handle_get_oauth_consent))
        .routes(routes!(approve::handle_approve_oauth_consent))
        .routes(routes!(deny::handle_deny_oauth_consent))
        .routes(defer_start_limit(routes!(ask_owner::handle_ask_owner)))
}
