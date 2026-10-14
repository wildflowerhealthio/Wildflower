mod authorization_pages;
mod authorization_status;
mod authorize;
mod client_auth;
mod device_authorization;
mod device_name_hint;
mod internal;
mod openapi;
mod pages;
mod sign_in;
mod token_exchange;
mod token_request;
mod wait_page;

use std::sync::Arc;

use axum::Router;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AuthorizationServerState;

/// The `/oauth/*` pages — the [`wait_page`] and its assets, the
/// [`authorization_pages`] (the consent card) and theirs, and the Owner's
/// [`sign_in`] — mounted under `/oauth` beside [`openapi_router`]. Kept out of
/// the `OpenAPI` spec: they are a browser's pages, not API surface.
pub(crate) fn page_router() -> Router<Arc<AuthorizationServerState>> {
    wait_page::router()
        .merge(authorization_pages::router())
        .merge(sign_in::router())
}

/// The `/oauth/*` routes as an `OpenApiRouter`, so the OpenAPI spec is collected
/// from the same handlers that serve traffic. Mounted under `/oauth` by
/// [`crate::http`]; `routes!` reads each handler's `#[utoipa::path]` for its
/// method + path.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(routes!(authorize::handle_authorize_request))
        .routes(routes!(
            authorization_status::handle_authorization_status_request
        ))
        .routes(routes!(token_exchange::handle_token_request))
        .routes(routes!(
            device_authorization::handle_device_authorization_request
        ))
}
