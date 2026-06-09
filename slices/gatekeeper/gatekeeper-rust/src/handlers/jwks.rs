use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::crypto::signing_key::{public_jwk, PublicJwk};
use crate::require_auth::AppState;

#[derive(Debug, Serialize)]
pub struct Jwks {
    pub keys: Vec<PublicJwk>,
}

pub fn router() -> Router {
    Router::new().route("/jwks.json", get(handle))
}

async fn handle(Extension(state): Extension<AppState>) -> Response {
    match state.store.all_signing_keys() {
        Ok(keys) => Json(Jwks {
            keys: keys.iter().map(public_jwk).collect(),
        })
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
