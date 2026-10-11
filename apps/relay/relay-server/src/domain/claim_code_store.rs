//! The [`ClaimCodeStore`] **port** — the pure trait the claim-code
//! capabilities depend on for persistence, beside the [`TunnelStore`] whose
//! tunnels the codes redeem for. Like it, it speaks only domain types and
//! raises only the opaque [`Infrastructure`](TunnelError::Infrastructure)
//! failure; refusals are decided in the
//! [`capabilities`](crate::domain::capabilities).
//!
//! The `SQLite` adapter, `SqliteTunnelStore` in [`crate::db`], keeps the codes
//! in the same database as the tunnels; tests substitute the in-memory
//! `FakeTunnelStore` in `crate::domain::test_fake`. In both, deleting a
//! tunnel deletes its codes.
//!
//! [`TunnelStore`]: crate::domain::TunnelStore

use crate::domain::{ClaimCodeHash, StoredClaimCode, Tunnel, TunnelError};

/// The persistence port for claim codes.
pub trait ClaimCodeStore {
    /// Add `stored`. Returns `true` when it was added, `false`, storing
    /// nothing, when a code with the same hash is already stored. The
    /// tunnel it names must be stored.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / insert failure,
    /// including a tunnel name that is not stored.
    fn insert_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError>;

    /// Remove the code hashed `code_hash` if it is unexpired at `now` (Unix
    /// epoch seconds), returning the tunnel it redeems for; `None`, removing
    /// nothing, when no unexpired code has the hash. Of any number of calls
    /// for the same code, at most one returns its tunnel.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn take_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError>;

    /// Remove every code expired at `now`. Returns how many were removed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError>;
}
