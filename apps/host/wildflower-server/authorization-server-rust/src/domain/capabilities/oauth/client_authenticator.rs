//! [`ClientAuthenticator`] — authenticate an OAuth client's presented
//! credentials against the store, yielding the
//! [`AuthenticatedClient`] proof every client-gated capability takes.

use crate::domain::authority::{AuthenticatedClient, ClientAuthenticationError};
use crate::domain::client_credentials::ClientCredentials;
use crate::domain::GrantStore;

/// Authenticate clients (RFC 6749 §2.3). Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the concrete
/// `SqliteGrantStore`.
pub(crate) struct ClientAuthenticator<S: GrantStore> {
    store: S,
}

impl<S: GrantStore> ClientAuthenticator<S> {
    /// Build the authenticator over a store handle lifted from the state.
    pub(crate) fn new(store: S) -> Self {
        ClientAuthenticator { store }
    }

    /// Verify `presented` and return the proof — the rule itself lives on the
    /// proof's constructor, [`AuthenticatedClient::authenticate`].
    ///
    /// # Errors
    ///
    /// A [`ClientAuthenticationError`] naming the failed check.
    pub(crate) fn authenticate(
        &self,
        presented: &ClientCredentials,
    ) -> Result<AuthenticatedClient, ClientAuthenticationError> {
        self.store
            .read(|tx| AuthenticatedClient::authenticate(tx, presented))
    }
}
