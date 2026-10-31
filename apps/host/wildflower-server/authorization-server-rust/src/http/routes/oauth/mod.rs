//! The `/oauth/*` routes, reached before anyone holds a bearer token: an
//! app's browser at the front door, an app's back end trading a code for
//! tokens, a device asking for a code to show its user, a browser asking to be
//! paired. None of them is the Owner, so none sits behind the
//! `/authorization` session gate; each answers from what the request itself
//! proves: a browser session cookie, a client's credentials, a code.
//!
//! Two route tables are mounted side by side under [`OAUTH_MOUNT`]: the API
//! routes ([`openapi_router`]), from which the OpenAPI spec is collected, and
//! the browser's pages ([`page_router`]), which are no API surface and stay
//! out of the spec.

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
mod session_shortfall;
mod session_widening;
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
/// [`authorization_pages`] (the consent card, the limited page, a session
/// widening's card, the device page, the pairing page) and theirs, the Owner's [`sign_in`], and a browser's [`sign_out`] —
/// mounted under `/oauth` beside [`openapi_router`]. Kept out of the `OpenAPI`
/// spec: they are a browser's pages, not API surface. `launcher_base` is where
/// a sign-out sends the browser, which the authorization pages' policy lets
/// their sign-out form follow.
///
/// The routes, all `GET` but the sign-out:
///
/// - `/oauth/authorize/{id}/wait`, `/oauth/authorize/wait.js` and
///   `/oauth/authorize/wait.css`: the wait page and its two files;
/// - `/oauth/authorize/{id}/consent`, `/oauth/authorize/{id}/limited`,
///   `/oauth/session-widenings/{id}/consent`, `/oauth/device`, `/oauth/pair`
///   and `/oauth/assets/{*file}`: the React authorization pages and their
///   assets;
/// - `/oauth/sign-in`: the Owner's same-device sign-in;
/// - `POST /oauth/sign-out`: a browser ending its own session.
pub(crate) fn page_router(launcher_base: &LauncherBase) -> Router<Arc<AuthorizationServerState>> {
    wait_page::router()
        .merge(authorization_pages::router(launcher_base))
        .merge(sign_in::router())
        .merge(sign_out::router())
}

/// The `/oauth/*` routes as an `OpenApiRouter`, so the OpenAPI spec is collected
/// from the same handlers that serve traffic. Mounted under `/oauth` by
/// [`crate::http`]; `routes!` reads each handler's `#[utoipa::path]` for its
/// method + path. The routes:
///
/// - `GET /oauth/authorize`: the front door of the authorization-code flow;
/// - `GET /oauth/authorize/{id}`: the wait page's status poll;
/// - `GET /oauth/authorize/{id}/session-shortfall`,
///   `POST /oauth/authorize/{id}/continue`,
///   `POST /oauth/authorize/{id}/cancel`,
///   `POST /oauth/authorize/{id}/ask-to-widen` and
///   `POST /oauth/session-widenings/{id}/poll`: the limited page's calls;
/// - `POST /oauth/token` and `POST /oauth/revoke`: the token endpoint and
///   revocation;
/// - `POST /oauth/device_authorization`: a device asking for its codes;
/// - `POST /oauth/pair/start` and `POST /oauth/pair/poll`: the pairing page's
///   calls.
///
/// `limit_authorization_starts` wraps the three routes that start a request
/// for the Owner, `/authorize`, `/device_authorization` and
/// `/authorize/{id}/ask-to-widen`, each named by its
/// [`AuthorizationStartRoute`], in the limit on how fast they are started (see
/// [`limit_authorization_starts`](crate::http::middleware::limit_authorization_starts)),
/// so it covers every method axum serves them on, `HEAD /oauth/authorize`
/// included; the spec, which serves nothing, leaves them as they are. Only
/// those three are limited: anyone who knows the server's domain can start a
/// request, and one raised for the Owner pops up on the Owner's device.
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
        .routes(routes!(session_shortfall::handle_session_shortfall_read))
        .routes(routes!(
            session_shortfall::handle_session_shortfall_continue
        ))
        .routes(routes!(session_shortfall::handle_session_shortfall_cancel))
        .routes(limit_authorization_starts(
            routes!(session_widening::handle_session_widening_ask),
            AuthorizationStartRoute::AskToWidenSession,
        ))
        .routes(routes!(session_widening::handle_session_widening_poll))
        .routes(routes!(token_exchange::handle_token_request))
        .routes(routes!(token_revocation::handle_token_revocation_request))
        .routes(limit_authorization_starts(
            routes!(device_authorization::handle_device_authorization_request),
            AuthorizationStartRoute::DeviceAuthorization,
        ))
        .routes(routes!(browser_pairing::handle_browser_pairing_start))
        .routes(routes!(browser_pairing::handle_browser_pairing_poll))
}
