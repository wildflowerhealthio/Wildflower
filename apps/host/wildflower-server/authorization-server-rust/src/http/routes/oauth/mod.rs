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

pub(crate) use authorization_pages::device_page_url;

/// [`OAUTH_MOUNT`] as a literal, so [`concat!`] can build a route's full path
/// from it.
macro_rules! oauth_mount {
    () => {
        "/oauth"
    };
}

/// Where [`page_router`] and [`openapi_router`] are mounted, so a URL built
/// for one of their routes names the same prefix the router serves it under.
pub(crate) const OAUTH_MOUNT: &str = oauth_mount!();

/// The full path of `GET /oauth/authorize`, which starts an
/// authorization-code request ([`authorize::handle_authorize_request`]).
pub const AUTHORIZE_PATH: &str = concat!(oauth_mount!(), "/authorize");

/// The full path of `POST /oauth/device_authorization`, which starts a
/// device-code request
/// ([`device_authorization::handle_device_authorization_request`]).
pub const DEVICE_AUTHORIZATION_PATH: &str = concat!(oauth_mount!(), "/device_authorization");

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
