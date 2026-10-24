//! The [`ClaimCodeStore`] **port** — the pure trait the claim-code
//! capabilities depend on for persistence, beside the [`TunnelStore`] whose
//! tunnels the codes redeem for. Like it, it speaks only domain types and
//! raises only the opaque [`Infrastructure`](TunnelError::Infrastructure)
//! failure; refusals are decided in the
//! [`capabilities`](crate::domain::capabilities).
//!
//! The `SQLite` adapter, `SqliteTunnelStore` in [`crate::db`], keeps the codes
//! in the same database as the tunnels; tests substitute the in-memory
//! `FakeTunnelStore` in `crate::domain::test_fake`. In both, a code is kept
//! by its hash, a tunnel has at most one
//! [`Preset`](ClaimCodeTarget::Preset) code, and deleting the tunnel deletes
//! it.
//!
//! [`TunnelStore`]: crate::domain::TunnelStore

use crate::domain::{
    ClaimCodeHash, ClaimCodeTarget, StoredClaimCode, StoredTunnel, Tunnel, TunnelError,
};

/// The persistence port for claim codes.
pub trait ClaimCodeStore {
    /// Store `stored`. A [`Preset`](ClaimCodeTarget::Preset) code replaces
    /// any code its tunnel already has, which then stops redeeming; the
    /// tunnel it names must be stored. Returns `true` when it was stored,
    /// `false`, storing nothing, when a stored code has the same hash.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / write failure,
    /// including a tunnel name that is not stored.
    fn insert_claim_code(&self, stored: &StoredClaimCode) -> Result<bool, TunnelError>;

    /// What the code hashed `code_hash` redeems for, if it is stored and
    /// unexpired at `now` (Unix epoch seconds).
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / read failure.
    fn claim_code_target(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<ClaimCodeTarget>, TunnelError>;

    /// Remove the [`Preset`](ClaimCodeTarget::Preset) code hashed
    /// `code_hash` if it is unexpired at `now`, returning the tunnel it
    /// redeems for; `None`, removing nothing, when no such code has the
    /// hash. Of any number of calls for the same code, at most one returns
    /// its tunnel.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn take_preset_claim_code(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
    ) -> Result<Option<Tunnel>, TunnelError>;

    /// Remove the [`Open`](ClaimCodeTarget::Open) code hashed `code_hash` if
    /// it is unexpired at `now`, and store `tunnel`, as one write; returns
    /// the code as it was stored. `None`, storing and removing nothing, when
    /// no such code has the hash. Of any number of calls for the same code,
    /// at most one stores its tunnel.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / write failure,
    /// including a tunnel name already stored, with nothing changed: the
    /// caller checks the name first.
    fn take_open_claim_code_for_tunnel(
        &self,
        code_hash: &ClaimCodeHash,
        now: i64,
        tunnel: &StoredTunnel,
    ) -> Result<Option<StoredClaimCode>, TunnelError>;

    /// Remove every code expired at `now`. Returns how many were removed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] on a checkout / delete failure.
    fn delete_expired_claim_codes(&self, now: i64) -> Result<usize, TunnelError>;
}
