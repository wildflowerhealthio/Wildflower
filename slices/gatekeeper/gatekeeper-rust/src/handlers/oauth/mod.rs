pub mod authorize;
pub mod authorization_status;
pub mod device_authorization;
pub mod shared;
pub mod token_exchange;

use axum::routing::{get, post};
use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/authorize", get(authorize::handle_authorize_request))
        .route(
            "/authorize/{id}",
            get(authorization_status::handle_authorization_status_request),
        )
        .route("/token", post(token_exchange::handle_token_request))
        .route(
            "/device_authorization",
            post(device_authorization::handle_device_authorization_request),
        )
}
