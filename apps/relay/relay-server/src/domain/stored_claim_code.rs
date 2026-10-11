//! [`StoredClaimCode`] — a claim code as the
//! [`ClaimCodeStore`](crate::domain::ClaimCodeStore) keeps it: by hash, at
//! most one per tunnel.

use crate::domain::ClaimCodeHash;

/// A tunnel's outstanding claim code: its hash, the tunnel it redeems for
/// and when it stops redeeming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredClaimCode {
    pub code_hash: ClaimCodeHash,
    /// The name of the tunnel it redeems for.
    pub tunnel_name: String,
    /// Unix epoch seconds: the code redeems while the clock reads earlier.
    pub expires_at: i64,
}
