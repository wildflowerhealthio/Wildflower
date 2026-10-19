//! [`PublicKeysReader`] — `GET /.well-known/jwks.json`: the public halves of
//! every signing key. Public, and its only power is this one read; the private
//! material never leaves the domain type it is projected from.

use crate::crypto_util::public_jwk::PublicJwk;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::grant_store::SigningKeysTx as _;
use crate::domain::GrantStore;

/// Read the public signing keys. Generic over the store port; the binding
/// instantiates it over the concrete `SqliteGrantStore`.
pub(crate) struct PublicKeysReader<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> PublicKeysReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        PublicKeysReader { store }
    }

    /// The RFC 7517 public JWKs of every stored signing key (active and
    /// rotated-out verify-only keys alike).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub(crate) fn public_jwks(&self) -> Result<Vec<PublicJwk>, AuthorizationServerError> {
        let signing_keys = self.store.read(|tx| tx.all_signing_keys())?;
        Ok(signing_keys.iter().map(PublicJwk::from).collect())
    }
}
