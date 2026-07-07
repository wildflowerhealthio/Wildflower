mod authorization_status;
mod authorize;
mod client_auth;
mod device_authorization;
mod error_codes;
mod internal;
mod openapi;
mod token_exchange;
mod token_request;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::AppState;

/// Re-exported so the code-flow consent handler
/// ([`crate::http::handlers::oauth_consents::approve`]) can build the same
/// client callback URL the polling endpoint returns, without reaching into the
/// private `internal` module.
pub(crate) use internal::build_client_redirect_url;

/// The `/oauth/*` routes as an `OpenApiRouter`, so the OpenAPI spec is collected
/// from the same handlers that serve traffic. Mounted under `/oauth` by
/// [`crate::http`]; `routes!` reads each handler's `#[utoipa::path]` for its
/// method + path.
pub(crate) fn openapi_router() -> OpenApiRouter<AppState> {
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
