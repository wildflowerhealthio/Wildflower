mod authorization_status;
mod authorize;
mod client_auth;
mod device_authorization;
mod device_name_hint;
mod internal;
mod openapi;
mod token_exchange;
mod token_request;

use std::sync::Arc;

use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::http::state::GatekeeperState;

/// The `/oauth/*` routes as an `OpenApiRouter`, so the OpenAPI spec is collected
/// from the same handlers that serve traffic. Mounted under `/oauth` by
/// [`crate::http`]; `routes!` reads each handler's `#[utoipa::path]` for its
/// method + path.
pub(crate) fn openapi_router() -> OpenApiRouter<Arc<GatekeeperState>> {
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
