use axum::extract::State;
use axum::routing::{get, MethodRouter};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// RFC 7517 JSON Web Key Set body served at `/.well-known/jwks.json`.
#[derive(Debug, Serialize, ToSchema)]
pub struct Jwks {
    pub keys: Vec<PublicJwk>,
}

/// `GET` handler for `/.well-known/jwks.json`, as a `MethodRouter` the caller
/// mounts at the full path — avoids wrapping a whole `Router` for one route.
pub fn route() -> MethodRouter<AppState> {
    get(handle_jwks_request)
}

async fn handle_jwks_request(State(state): State<AppState>) -> Result<Json<Jwks>, HandlerError> {
    let keys = state
        .store
        .all_signing_keys()
        .map_err(|e| HandlerError::internal("all_signing_keys lookup failed", e))?;
    Ok(Json(Jwks {
        keys: keys.iter().map(PublicJwk::from).collect(),
    }))
}
