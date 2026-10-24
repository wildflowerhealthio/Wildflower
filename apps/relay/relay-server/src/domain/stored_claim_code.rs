//! [`StoredClaimCode`] — a claim code as the
//! [`ClaimCodeStore`](crate::domain::ClaimCodeStore) keeps it: by hash.

use crate::domain::{ClaimCodeHash, ClaimCodeTarget};

/// An outstanding claim code: its hash, what it redeems for and when it
/// stops redeeming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredClaimCode {
    pub code_hash: ClaimCodeHash,
    pub target: ClaimCodeTarget,
    /// Unix epoch seconds: the code redeems while the clock reads earlier.
    pub expires_at: i64,
}
