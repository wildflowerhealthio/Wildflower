use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::extractors::Live;
use crate::live_bindings::LivePublicKeysReader;

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
    keys: Live<LivePublicKeysReader>,
) -> Result<Json<Jwks>, GatekeeperError> {
    Ok(Json(Jwks {
        keys: keys.public_jwks()?,
    }))
}
