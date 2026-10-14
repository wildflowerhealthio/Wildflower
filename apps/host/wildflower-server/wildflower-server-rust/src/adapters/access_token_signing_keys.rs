//! The host's [`wildflowerhealthio_fhir_r4::AccessTokenSigningKeys`], backed by the
//! authorization server's signing keys.

use anyhow::Context;
use wildflowerhealthio_fhir_r4::{AccessTokenPublicKey, AccessTokenSigningKeys};

/// The host's [`AccessTokenSigningKeys`]: the public halves of the keys the
/// authorization server signs its access tokens with, read through its
/// [`wildflowerhealthio_authorization_server::SigningKeysReader`], so HFS
/// verifies each bearer in-process.
pub(crate) struct AuthorizationServerSigningKeys {
    pub(crate) signing_keys_reader: wildflowerhealthio_authorization_server::SigningKeysReader,
}

impl AccessTokenSigningKeys for AuthorizationServerSigningKeys {
    fn public_keys(&self) -> anyhow::Result<Vec<AccessTokenPublicKey>> {
        self.signing_keys_reader
            .public_jwks()
            .context("read the authorization server's signing keys")?
            .into_iter()
            .map(|public_jwk| {
                anyhow::ensure!(
                    public_jwk.kty == "RSA" && public_jwk.alg == "RS256",
                    "signing key {} is {} {}, not RSA RS256",
                    public_jwk.kid,
                    public_jwk.kty,
                    public_jwk.alg
                );
                Ok(AccessTokenPublicKey {
                    kid: public_jwk.kid,
                    n: public_jwk.n,
                    e: public_jwk.e,
                })
            })
            .collect()
    }
}
