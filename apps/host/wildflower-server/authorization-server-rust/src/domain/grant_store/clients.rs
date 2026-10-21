//! [`ClientsTx`] — the `clients` table: the registered OAuth clients.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::client::{Client, RefreshPolicy};

/// The registered OAuth clients. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait ClientsTx {
    /// Look up a registered client by its `client_id`, or `None` when no client
    /// has this id.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to a [`Client`].
    fn client_by_id(&mut self, client_id: &str)
        -> Result<Option<Client>, AuthorizationServerError>;

    /// Whether `client_id`'s client is disabled. A client with no row is not:
    /// one trusted on first use has none until the Owner approves it.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails.
    fn is_client_disabled(&mut self, client_id: &str) -> Result<bool, AuthorizationServerError>;

    /// Insert a client, or update its registration fields if one with the
    /// same `client_id` already exists (`ON CONFLICT … DO UPDATE`), preserving
    /// `registered_at`, `disabled_at` and the refresh policy, which only
    /// [`set_client_refresh_policy`](Self::set_client_refresh_policy) changes.
    /// Used by the seeding every boot runs, so a seeded client's registration
    /// always matches the code, and by the grant recorder to create or widen a
    /// registration trusted on first use.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the upsert fails.
    fn upsert_client(&mut self, client: &Client) -> Result<(), AuthorizationServerError>;

    /// Every registered client, ordered by `client_id` — the Owner's "Trusted
    /// apps" list. Disabled clients are included (their `disabled_at` is set).
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or any returned row
    /// cannot be mapped to a [`Client`].
    fn list_clients(&mut self) -> Result<Vec<Client>, AuthorizationServerError>;

    /// Set (`Some`) or clear (`None`) a client's `disabled_at`, touching no other
    /// column. Returns whether a row with this `client_id` existed. A disabled
    /// client is refused at `/oauth/authorize` and `/oauth/token`; clearing the
    /// stamp re-enables it with its registration intact.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn set_client_disabled(
        &mut self,
        client_id: &str,
        disabled_at: Option<DateTime<Utc>>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Replace a client's refresh policy, touching no other column. Returns
    /// whether a row with this `client_id` existed. Its families pick the new
    /// policy up on their next refresh.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn set_client_refresh_policy(
        &mut self,
        client_id: &str,
        refresh_policy: &RefreshPolicy,
    ) -> Result<bool, AuthorizationServerError>;
}
