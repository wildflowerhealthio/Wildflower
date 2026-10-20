//! [`AuthorizationCodesTx`] — the `authorization_codes` table: the issued,
//! single-use codes `/oauth/token` redeems.

use chrono::{DateTime, Utc};

use crate::domain::authorization_code::IssuedAuthorizationCode;
use crate::domain::authorization_server_error::AuthorizationServerError;

/// The issued authorization codes. Every method is one primitive on the caller's
/// [`GrantStore`](super::GrantStore) scope: a single statement, or a few
/// that land together within that scope.
pub trait AuthorizationCodesTx {
    /// Atomically read-and-delete the authorization `code` (`DELETE …
    /// RETURNING`), returning the row exactly once or `None` to any racer —
    /// RFC 6749 §10.5 single-use.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete-returning query fails or
    /// a returned row cannot be mapped to an [`IssuedAuthorizationCode`].
    fn redeem_authorization_code(
        &mut self,
        code: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError>;

    /// Look up the code issued for a given `request_id`, or `None` when absent —
    /// used by the authorize-status poll to build the final redirect URL.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the read fails or a returned row
    /// cannot be mapped to an [`IssuedAuthorizationCode`].
    fn authorization_code_by_request_id(
        &mut self,
        request_id: &str,
    ) -> Result<Option<IssuedAuthorizationCode>, AuthorizationServerError>;

    /// Persist a freshly-minted authorization code.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the insert fails (for example a
    /// unique-constraint violation on the code).
    fn issue_authorization_code(
        &mut self,
        code: &IssuedAuthorizationCode,
    ) -> Result<(), AuthorizationServerError>;

    /// Delete every authorization code whose `expires_at` fell before `cutoff`,
    /// returning how many rows went. Redemption already deletes a code as it is
    /// used, so this reaps only abandoned ones.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::Infrastructure`] if the delete fails.
    fn delete_authorization_codes_expired_before(
        &mut self,
        cutoff: DateTime<Utc>,
    ) -> Result<usize, AuthorizationServerError>;
}
