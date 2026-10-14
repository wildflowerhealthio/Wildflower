//! The [`SigningKeysReader`] binding — the read of the [`PublicKeysReader`]
//! capability over the concrete `SqliteGrantStore`, for in-process verifiers
//! outside the authorization server: the host's FHIR server checks each bearer
//! against these keys rather than fetching `/.well-known/jwks.json`.

use crate::crypto_util::public_jwk::PublicJwk;
use crate::db::SqliteGrantStore;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::oauth::PublicKeysReader;

/// Read the public halves of the authorization server's signing keys. Cheap to
/// clone (the store wraps a pool). [`crate::setup_authorization_server`] hands
/// one out on
/// [`AuthorizationServer::signing_keys_reader`](crate::AuthorizationServer::signing_keys_reader).
#[derive(Clone)]
pub struct SigningKeysReader {
    store: SqliteGrantStore,
}

impl SigningKeysReader {
    /// A reader over the authorization server's store.
    pub(crate) fn new(store: SqliteGrantStore) -> Self {
        SigningKeysReader { store }
    }

    /// The RFC 7517 public JWKs of every stored signing key (active and
    /// rotated-out verify-only keys alike), as `/.well-known/jwks.json` serves
    /// them.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] on a store failure.
    pub fn public_jwks(&self) -> Result<Vec<PublicJwk>, AuthorizationServerError> {
        PublicKeysReader::new(self.store.clone()).public_jwks()
    }
}
