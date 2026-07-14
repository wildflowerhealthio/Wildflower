//! [`SessionRevoker`] — the seam the logout action calls to denylist a
//! logged-out session token, so the action stays testable without a real
//! revocation store.

use chrono::{DateTime, Utc};

/// Denylist a session token by its `jti` until `expires_at` (after which expiry
/// validation rejects it regardless, so the row is only worth keeping until
/// then). The real implementation is the shared
/// [`RevocationStore`](token_revocation_rust::RevocationStore); a test fake
/// records the revocation (or fails, to prove the caller swallows it).
pub(crate) trait SessionRevoker {
    /// Revoke `jti` until `expires_at`, tagging the denylist row with `reason`.
    /// The error is stringified so the port stays free of the store's concrete
    /// error type — the one caller (logout) only logs it.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the write fails.
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String>;
}
