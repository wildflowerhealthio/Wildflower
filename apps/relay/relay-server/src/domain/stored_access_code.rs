//! [`StoredAccessCode`] — an access code as the
//! [`AccessCodeStore`](crate::domain::AccessCodeStore) keeps it: by hash,
//! naming no tunnel.

use crate::domain::ClaimCodeHash;

/// An outstanding access code: its hash and when it stops redeeming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAccessCode {
    pub code_hash: ClaimCodeHash,
    /// Unix epoch seconds: the code redeems while the clock reads earlier.
    pub expires_at: i64,
}
