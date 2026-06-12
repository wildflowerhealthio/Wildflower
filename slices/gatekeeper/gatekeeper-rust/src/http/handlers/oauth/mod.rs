mod authorization_status;
mod authorize;
mod client_auth;
mod device_authorization;
mod internal;
mod token_exchange;

use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/authorize", authorize::route())
        .route("/authorize/{id}", authorization_status::route())
        .route("/token", token_exchange::route())
        .route("/device_authorization", device_authorization::route())
}
