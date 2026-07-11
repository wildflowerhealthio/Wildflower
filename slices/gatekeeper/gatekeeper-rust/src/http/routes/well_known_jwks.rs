use axum::extract::State;
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;

/// RFC 7517 JSON Web Key Set body served at `/.well-known/jwks.json`.
#[derive(Debug, Serialize, ToSchema)]
pub struct Jwks {
    pub keys: Vec<PublicJwk>,
}

/// `GET /.well-known/jwks.json` — serve the active public signing keys.
#[utoipa::path(
    get,
    tag = "Discovery",
    path = "/.well-known/jwks.json",
    responses((status = 200, description = "RFC 7517 JSON Web Key Set", body = Jwks))
)]
pub(crate) async fn handle_jwks_request(
    State(state): State<AppState>,
) -> Result<Json<Jwks>, HandlerError> {
    let keys = state.store.all_signing_keys()?;
    Ok(Json(Jwks {
        keys: keys.iter().map(PublicJwk::from).collect(),
    }))
}
