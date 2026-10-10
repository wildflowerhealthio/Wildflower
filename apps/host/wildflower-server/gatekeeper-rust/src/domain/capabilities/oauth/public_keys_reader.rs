//! [`PublicKeysReader`] — `GET /.well-known/jwks.json`: the public halves of
//! every signing key. Public, and its only power is this one read; the private
//! material never leaves the domain type it is projected from.

use crate::crypto_util::public_jwk::PublicJwk;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// Read the public signing keys. Generic over the store port; the binding
/// instantiates it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct PublicKeysReader<S: GatekeeperStore> {
    store: S,
}

impl<S: GatekeeperStore> PublicKeysReader<S> {
    /// Build the reader over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        PublicKeysReader { store }
    }

    /// The RFC 7517 public JWKs of every stored signing key (active and
    /// rotated-out verify-only keys alike).
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn public_jwks(&self) -> Result<Vec<PublicJwk>, GatekeeperError> {
        Ok(self
            .store
            .all_signing_keys()?
            .iter()
            .map(PublicJwk::from)
            .collect())
    }
}
