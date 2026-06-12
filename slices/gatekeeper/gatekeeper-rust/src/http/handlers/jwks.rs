use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::http::state::AppState;

/// RFC 7517 JSON Web Key Set body served at `/.well-known/jwks.json`.
#[derive(Debug, Serialize)]
pub struct Jwks {
    pub keys: Vec<PublicJwk>,
}

/// `GET` handler for `/.well-known/jwks.json`, as a `MethodRouter` the caller
/// mounts at the full path — avoids wrapping a whole `Router` for one route.
pub fn handle_get_jwks_request() -> MethodRouter {
    get(handle_jwks_request)
}

async fn handle_jwks_request(Extension(state): Extension<AppState>) -> Response {
    match state.store.all_signing_keys() {
        Ok(keys) => Json(Jwks {
            keys: keys.iter().map(PublicJwk::from).collect(),
        })
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "all_signing_keys lookup failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
