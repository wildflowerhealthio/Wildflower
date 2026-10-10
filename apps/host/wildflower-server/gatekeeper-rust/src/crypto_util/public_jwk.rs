use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicJwk {
    /// Key identifier matching the source `SigningKey.kid`; verifiers use this to select the key.
    pub kid: String,
    /// JWK key type — always `"RSA"`.
    pub kty: String,
    /// JWS algorithm the key is intended for — always `"RS256"`.
    pub alg: String,
    /// Permitted JWK operations — always `["verify"]` for published public keys.
    pub key_ops: Vec<String>,
    /// RSA modulus `n`, base64url-encoded.
    pub n: String,
    /// RSA public exponent `e`, base64url-encoded.
    pub e: String,
}
