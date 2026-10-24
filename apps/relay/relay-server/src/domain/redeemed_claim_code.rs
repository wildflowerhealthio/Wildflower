//! [`RedeemedClaimCode`] — the tunnel a claim code was just redeemed for.

use crate::domain::{StoredClaimCode, StoredTunnel, Tunnel};

/// What redeeming a claim code gave: the name and token of the tunnel it
/// named, or a tunnel it created, whose token is shown only to the caller of
/// `POST /claim`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RedeemedClaimCode {
    /// The tunnel a [`Preset`](crate::domain::ClaimCodeTarget::Preset) code
    /// named, stored and served already.
    Preset(Tunnel),
    /// The tunnel an [`Open`](crate::domain::ClaimCodeTarget::Open) code
    /// created, as it is now stored, and the code it burned, for putting it
    /// back should serving the tunnel fail.
    Open {
        stored: StoredTunnel,
        claim_code: StoredClaimCode,
    },
}

impl RedeemedClaimCode {
    /// The tunnel the code redeemed for.
    #[must_use]
    pub fn tunnel(&self) -> &Tunnel {
        match self {
            RedeemedClaimCode::Preset(tunnel) => tunnel,
            RedeemedClaimCode::Open { stored, .. } => &stored.tunnel,
        }
    }
}
