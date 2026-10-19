//! [`SigningKeysTx`] — the `signing_keys` table: the keys tokens are signed
//! and verified with.

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::signing_key::SigningKey;

/// The keys tokens are signed and verified with. Every method is one statement on the caller's
/// [`GrantStore`](super::GrantStore) scope.
pub trait SigningKeysTx {
    /// Load every signing key, active keys first then by `kid`.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`SigningKey`].
    fn all_signing_keys(&mut self) -> Result<Vec<SigningKey>, AuthorizationServerError>;

    /// Load the active signing key, or `None` when none is active.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`SigningKey`].
    fn active_signing_key(&mut self) -> Result<Option<SigningKey>, AuthorizationServerError>;

    /// Whether an active signing key exists, without loading its (private) key
    /// material — a cheap presence probe.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the query fails.
    fn has_active_signing_key(&mut self) -> Result<bool, AuthorizationServerError>;

    /// Persist a signing key.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the `kid`).
    fn insert_signing_key(&mut self, key: &SigningKey) -> Result<(), AuthorizationServerError>;
}
