//! [`IssuedClaimCode`] — a claim code as the admin is shown it, once.

use crate::domain::ClaimCode;

/// A claim code just issued: the only time the code itself is seen, since
/// the store keeps only its hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedClaimCode {
    pub code: ClaimCode,
    /// Unix epoch seconds: the code redeems while the clock reads earlier.
    pub expires_at: i64,
}
