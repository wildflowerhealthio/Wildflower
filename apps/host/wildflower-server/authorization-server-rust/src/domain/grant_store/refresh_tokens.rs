//! [`RefreshTokensTx`] — the `refresh_token_families` and `refresh_tokens`
//! tables: the standing credentials and their rotation lineage.

use chrono::{DateTime, Utc};

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};

/// The refresh-token families and their tokens. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait RefreshTokensTx {
    /// Persist a new refresh-token family **row only** — a single-table insert.
    /// Pairing it with its first token in the same scope (so a family never
    /// persists tokenless) is
    /// `RefreshFamilyWriter::start_family`'s
    /// job.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails.
    fn insert_refresh_token_family_row(
        &mut self,
        family: &RefreshTokenFamily,
    ) -> Result<(), AuthorizationServerError>;

    /// Persist the successor token in an existing family's rotation.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the token hash, or a foreign-key violation
    /// for an unknown family).
    fn insert_refresh_token(
        &mut self,
        token: &RefreshToken,
    ) -> Result<(), AuthorizationServerError>;

    /// Resolve a presented token hash to its row plus the owning family in one
    /// JOIN (consumed tokens resolve too — the caller distinguishes live from
    /// replayed via `consumed_at`), or `None` when absent.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the join fails or a returned row
    /// cannot be mapped to a [`RefreshToken`]/[`RefreshTokenFamily`] pair.
    fn refresh_token_with_family_by_hash(
        &mut self,
        token_hash: &str,
    ) -> Result<Option<(RefreshToken, RefreshTokenFamily)>, AuthorizationServerError>;

    /// Stamp the live token `token_hash` consumed at `now`, returning `true` iff
    /// a live (un-consumed) row was actually transitioned — the guarded half of
    /// a refresh-token consume. The `consumed_at IS NULL` guard makes a replay a
    /// `false`, and pairing this with [`Self::refresh_token_exists`] in one
    /// write scope is how
    /// `consume_refresh_token`
    /// resolves the three-state consume without a dedicated store method.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the update fails.
    fn stamp_refresh_token_consumed_if_live(
        &mut self,
        token_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, AuthorizationServerError>;

    /// Whether any token row (live or consumed) bears `token_hash` — the
    /// existence probe that tells a replay (`true`) from a miss (`false`) after
    /// [`Self::stamp_refresh_token_consumed_if_live`] reported no live row.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the query fails.
    fn refresh_token_exists(&mut self, token_hash: &str) -> Result<bool, AuthorizationServerError>;

    /// End a token family (pull its `expires_at` back to `now` and stamp its
    /// still-live token consumed at the same instant). Rows are kept, not
    /// deleted, so the lineage stays auditable. The two updates land together
    /// or not at all.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_family(
        &mut self,
        family_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// End every refresh-token family issued to a client, with the same
    /// expire-and-stamp semantics as [`Self::expire_refresh_token_family`] — the
    /// standing-credential half of a grant revoke.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_client(
        &mut self,
        client_id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// End every refresh-token family minted from a given authorization code
    /// (by the code's hash), with the same expire-and-stamp semantics as
    /// [`Self::expire_refresh_token_family`] — authorization-code reuse detection
    /// (RFC 6749 §4.1.2). A code that never minted a family is a no-op.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either update
    /// fails.
    fn expire_refresh_token_families_for_authorization_code(
        &mut self,
        authorization_code_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError>;

    /// Delete every refresh-token family whose absolute deadline fell before
    /// `cutoff`, together with the tokens descended from it, returning how many
    /// **families** went — the counterpart to
    /// [`Self::expire_refresh_token_family`], which keeps the lineage readable.
    /// Children go before parents, together, so the foreign key holds.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the transaction or either delete
    /// fails.
    fn delete_refresh_token_families_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}
