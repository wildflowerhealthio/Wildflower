//! `GET /.well-known/jwks.json`: the public halves of the server's signing
//! keys, which anyone verifying one of its access tokens fetches.

use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::crypto_util::public_jwk::PublicJwk;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::http::extractors::Live;
use crate::live_bindings::LivePublicKeysReader;

/// RFC 7517 JSON Web Key Set body served at `/.well-known/jwks.json`.
#[derive(Debug, Serialize, ToSchema)]
pub struct Jwks {
    /// Every stored signing key's public half, the active key and the
    /// rotated-out keys kept to verify tokens they signed alike.
    pub keys: Vec<PublicJwk>,
}

/// `GET /.well-known/jwks.json` — serve every stored signing key's public half.
///
/// Active and rotated-out verify-only keys alike.
#[utoipa::path(
    get,
    tag = "Discovery",
    path = "/.well-known/jwks.json",
    responses((status = 200, description = "RFC 7517 JSON Web Key Set", body = Jwks))
)]
pub(crate) async fn handle_jwks_request(
    keys: Live<LivePublicKeysReader>,
) -> Result<Json<Jwks>, AuthorizationServerError> {
    Ok(Json(Jwks {
        keys: keys.public_jwks()?,
    }))
}
