use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::http::state::AppState;

/// RFC 7517 JSON Web Key Set body served at `/.well-known/jwks.json`.
#[derive(Debug, Serialize)]
pub struct Jwks {
    pub keys: Vec<PublicJwk>,
}

pub fn router() -> Router {
    Router::new().route("/jwks.json", get(handle_jwks_request))
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
