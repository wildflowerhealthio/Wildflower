pub mod authorize;
pub mod authorization_status;
pub mod device_authorization;
pub mod shared;
pub mod token_exchange;

use axum::routing::{get, post};
use axum::Router;

pub fn router() -> Router {
    Router::new()
        .route("/authorize", get(authorize::handle))
        .route("/authorize/{id}", get(authorization_status::handle))
        .route("/token", post(token_exchange::handle))
        .route("/device_authorization", post(device_authorization::handle))
}
