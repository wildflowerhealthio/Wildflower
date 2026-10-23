//! The [`AccessCodeStore`] **port** — the pure trait the access-code
//! capabilities depend on for persistence, beside the [`ClaimCodeStore`]
//! whose codes share their format and hashes. Like it, it speaks only domain
//! types and raises only the opaque
//! [`Infrastructure`](TunnelError::Infrastructure) failure; refusals are
//! decided in the [`capabilities`](crate::domain::capabilities).
//!
//! The `SQLite` adapter, `SqliteTunnelStore` in [`crate::db`], keeps the codes
//! in the same database as the tunnels and the claim codes; tests substitute
//! the in-memory `FakeTunnelStore` in `crate::domain::test_fake`. In both, no
//! hash is stored as an access code and a claim code at once, so a typed code
//! is one kind or the other.
//!
//! [`ClaimCodeStore`]: crate::domain::ClaimCodeStore

use crate::domain::{ClaimCodeHash, StoredAccessCode, StoredTunnel, TunnelError};

/// The persistence port for access codes.
pub trait AccessCodeStore {
    /// Store `stored`. Returns `true` when it was stored, `false`, storing
    /// nothing, when a stored access code or claim code has the same hash.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / write failure.
    fn insert_access_code(&self, stored: &StoredAccessCode) -> Result<bool, TunnelError>;

    /// Whether an access code hashed `code_hash` is stored and unexpired at
    /// `now` (Unix epoch seconds).
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure.
    fn contains_access_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<bool, TunnelError>;

    /// Remove the access code hashed `code_hash` if it is unexpired at
    /// `now`, and store `tunnel`, as one write; returns the code as it was
    /// stored. `None`, storing and removing nothing, when no unexpired code
    /// has the hash. Of any number of calls for the same code, at most one
    /// stores its tunnel.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / write failure,
    /// including a tunnel name already stored, with nothing changed: the
    /// caller checks the name first.
    fn take_access_code_for_tunnel(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
        tunnel: &StoredTunnel,
    ) -> Result<Option<StoredAccessCode>, TunnelError>;

    /// Remove every access code expired at `now`. Returns how many were
    /// removed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_expired_access_codes(&self, now: i64) -> Result<usize, TunnelError>;
}
