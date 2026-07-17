//! [`Revocation`] — the token-revocation seam the domain calls out through, so
//! the scope-gated capabilities (`GrantsRevoker`, `TokenRevoker`) and the logout
//! session-revoke stay testable against a stub instead of the concrete
//! [`RevocationStore`](token_revocation_rust::RevocationStore). Object-safe on
//! purpose: the capabilities hold an `Arc<dyn Revocation>` lifted from the state.

use chrono::{DateTime, Utc};

/// Revoke issued tokens. Both operations are implemented over the shared
/// [`RevocationStore`](token_revocation_rust::RevocationStore); a test fake
/// records the calls (or fails, to prove a caller swallows or surfaces the
/// error). Errors are stringified so the port stays free of the store's concrete
/// error type.
pub(crate) trait Revocation: Send + Sync + 'static {
    /// Denylist a single token by its `jti` until `expires_at` (after which
    /// expiry validation rejects it regardless), tagging the row with `reason`.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the write fails.
    fn revoke_jti(&self, jti: &str, expires_at: DateTime<Utc>, reason: &str) -> Result<(), String>;

    /// Bump a subject's revocation epoch to now, killing every access **and**
    /// refresh token issued to it before this instant — the bulk revoke behind a
    /// grant revoke and `/access/revocations` subject revoke.
    ///
    /// # Errors
    ///
    /// Returns the store failure (stringified) when the write fails.
    fn revoke_subject_as_of_now(&self, subject: &str) -> Result<(), String>;
}
