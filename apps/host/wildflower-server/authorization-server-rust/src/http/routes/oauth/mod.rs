mod authorization_pages;
mod authorization_status;
mod authorize;
mod browser_pairing;
mod client_auth;
mod device_authorization;
mod device_name_hint;
mod internal;
mod openapi;
mod pages;
mod sign_in;
mod sign_out;
mod token_exchange;
mod token_request;
mod token_revocation;
mod wait_page;

use std::sync::Arc;

use axum::Router;
use utoipa_axum::router::{OpenApiRouter, UtoipaMethodRouter};
use utoipa_axum::routes;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

use crate::http::middleware::AuthorizationStartRoute;
use crate::http::state::AuthorizationServerState;

pub(crate) use authorization_pages::device_page_url;

/// Where [`page_router`] and [`openapi_router`] are mounted, so a URL built
/// for one of their routes names the same prefix the router serves it under.
pub(crate) const OAUTH_MOUNT: &str = "/oauth";

/// The `/oauth/*` pages — the [`wait_page`] and its assets, the
/// [`authorization_pages`] (the consent card, the device page, the pairing
/// page) and theirs, the Owner's [`sign_in`], and a browser's [`sign_out`] —
/// mounted under `/oauth` beside [`openapi_router`]. Kept out of the `OpenAPI`
/// spec: they are a browser's pages, not API surface. `launcher_base` is where
/// a sign-out sends the browser, which the authorization pages' policy lets
/// their sign-out form follow.
pub(crate) fn page_router(launcher_base: &LauncherBase) -> Router<Arc<AuthorizationServerState>> {
    wait_page::router()
        .merge(authorization_pages::router(launcher_base))
        .merge(sign_in::router())
        .merge(sign_out::router())
}

/// The `/oauth/*` routes as an `OpenApiRouter`, so the OpenAPI spec is collected
/// from the same handlers that serve traffic. Mounted under `/oauth` by
/// [`crate::http`]; `routes!` reads each handler's `#[utoipa::path]` for its
/// method + path.
///
/// `limit_authorization_starts` wraps the two routes that start an
/// authorization request, `/authorize` and `/device_authorization`, each
/// named by its [`AuthorizationStartRoute`], in the limit on how fast they
/// are started (see
/// [`limit_authorization_starts`](crate::http::middleware::limit_authorization_starts)),
/// so it covers every method axum serves them on; the spec, which serves
/// nothing, leaves them as they are.
pub(crate) fn openapi_router(
    limit_authorization_starts: impl Fn(
        UtoipaMethodRouter<Arc<AuthorizationServerState>>,
        AuthorizationStartRoute,
    ) -> UtoipaMethodRouter<Arc<AuthorizationServerState>>,
) -> OpenApiRouter<Arc<AuthorizationServerState>> {
    OpenApiRouter::new()
        .routes(limit_authorization_starts(
            routes!(authorize::handle_authorize_request),
            AuthorizationStartRoute::Authorize,
        ))
        .routes(routes!(
            authorization_status::handle_authorization_status_request
        ))
        .routes(routes!(token_exchange::handle_token_request))
        .routes(routes!(token_revocation::handle_token_revocation_request))
        .routes(limit_authorization_starts(
            routes!(device_authorization::handle_device_authorization_request),
            AuthorizationStartRoute::DeviceAuthorization,
        ))
        .routes(routes!(browser_pairing::handle_browser_pairing_start))
        .routes(routes!(browser_pairing::handle_browser_pairing_poll))
}
