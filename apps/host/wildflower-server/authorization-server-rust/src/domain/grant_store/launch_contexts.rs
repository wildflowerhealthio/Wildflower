//! [`LaunchContextsTx`] — the `launch_contexts` table: the SMART App Launch
//! contexts a launch mints and `/oauth/authorize` consumes.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::launch_context::LaunchContext;

/// The SMART App Launch contexts. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait LaunchContextsTx {
    /// Persist a freshly minted SMART App Launch context.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (including a
    /// duplicate `nonce`).
    fn insert_launch_context(
        &mut self,
        context: &LaunchContext,
    ) -> Result<(), AuthorizationServerError>;

    /// Stamp the launch `nonce` consumed at `now` and return it, iff it was
    /// minted for `client_id` or for any client, is unconsumed, and is
    /// unexpired at `now`; otherwise `None` and nothing changes. The check and
    /// the stamp are one statement, so of two concurrent consumes of one nonce
    /// exactly one gets the context.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails or the returned
    /// row cannot be mapped to a [`LaunchContext`].
    fn consume_launch_context(
        &mut self,
        nonce: &str,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError>;

    /// The launch context `nonce`, as stored, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the query fails or the row
    /// cannot be mapped to a [`LaunchContext`].
    fn launch_context_by_nonce(
        &mut self,
        nonce: &str,
    ) -> Result<Option<LaunchContext>, AuthorizationServerError>;

    /// Delete every launch context that expired at or before `now`, returning
    /// how many went — the opportunistic prune a mint runs.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_launch_contexts_expired_by(
        &mut self,
        now: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}
