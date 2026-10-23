//! The issue capability — [`AccessCodesIssuer`], for
//! `POST /api/access-codes`.
//!
//! It drops the access codes that have expired, draws a code and stores its
//! hash with an expiry the relay's settings give, the claim codes' lifetime.
//! An access code names no tunnel, so any number are outstanding at once.
//! The code itself is returned once and never stored.

use std::time::Duration;

use rand::Rng;

use crate::domain::{AccessCodeStore, ClaimCode, IssuedClaimCode, StoredAccessCode, TunnelError};

/// How many codes [`AccessCodesIssuer::issue`] draws before giving up,
/// should each already be stored as an access code or a claim code.
const MAX_DRAWS: usize = 8;

/// Issuing — `POST /api/access-codes`. Holds the store and how long a code
/// redeems for, lifted from the state.
pub(crate) struct AccessCodesIssuer<S: AccessCodeStore> {
    store: S,
    access_code_ttl: Duration,
}

impl<S: AccessCodeStore> AccessCodesIssuer<S> {
    pub(crate) fn new(store: S, access_code_ttl: Duration) -> Self {
        Self {
            store,
            access_code_ttl,
        }
    }

    /// Issue an access code drawn from `rng` that redeems until
    /// `access_code_ttl` after the time `now` reads (Unix epoch seconds).
    /// Access codes expired by then are deleted first.
    ///
    /// # Errors
    ///
    /// Whatever `now` fails with; [`TunnelError::Exhausted`] if every draw
    /// is already stored; and [`TunnelError::Infrastructure`] if a store
    /// write fails.
    pub(crate) fn issue<R: Rng + ?Sized>(
        &self,
        rng: &mut R,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<IssuedClaimCode, TunnelError> {
        let now = now()?;
        let ttl_secs = i64::try_from(self.access_code_ttl.as_secs())
            .map_err(|e| TunnelError::infrastructure("the access code lifetime is too long", e))?;
        let expires_at = now + ttl_secs;
        self.store.delete_expired_access_codes(now)?;
        for _ in 0..MAX_DRAWS {
            let code = ClaimCode::generate(rng);
            let stored = StoredAccessCode {
                code_hash: code.hash(),
                expires_at,
            };
            if self.store.insert_access_code(&stored)? {
                return Ok(IssuedClaimCode { code, expires_at });
            }
        }
        Err(TunnelError::Exhausted("no unused access code was drawn"))
    }
}

#[cfg(test)]
mod tests {
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::{ClaimCodeStore, StoredClaimCode, TunnelStore};

    const TTL: Duration = Duration::from_secs(900);

    fn issuer() -> AccessCodesIssuer<FakeTunnelStore> {
        AccessCodesIssuer::new(FakeTunnelStore::default(), TTL)
    }

    #[test]
    fn issues_a_code_stored_only_by_hash_until_the_ttl() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        let issued = issuer.issue(&mut rng, || Ok(1_000)).unwrap();
        assert_eq!(issued.expires_at, 1_900);
        assert_eq!(
            issuer.store.access_codes(),
            [StoredAccessCode {
                code_hash: issued.code.hash(),
                expires_at: 1_900,
            }]
        );
    }

    /// Codes are not tied to anything, so each issue adds one.
    #[test]
    fn each_issue_adds_a_code() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        let first = issuer.issue(&mut rng, || Ok(1_000)).unwrap();
        let second = issuer.issue(&mut rng, || Ok(1_000)).unwrap();
        assert_ne!(first.code, second.code);
        assert_eq!(issuer.store.access_codes().len(), 2);
    }

    #[test]
    fn issuing_drops_the_codes_that_have_expired() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        let expired = issuer.issue(&mut rng, || Ok(1_000)).unwrap();
        let live = issuer.issue(&mut rng, || Ok(expired.expires_at)).unwrap();
        assert_eq!(
            issuer.store.access_codes(),
            [StoredAccessCode {
                code_hash: live.code.hash(),
                expires_at: live.expires_at,
            }]
        );
    }

    /// A drawn code already stored, as an access code or as a claim code,
    /// is drawn again.
    #[test]
    fn a_code_already_stored_of_either_kind_is_drawn_again() {
        let issuer = issuer();
        let as_access_code = issuer
            .issue(&mut StdRng::seed_from_u64(0), || Ok(1_000))
            .unwrap();
        let redrawn = issuer
            .issue(&mut StdRng::seed_from_u64(0), || Ok(1_000))
            .unwrap();
        assert_ne!(redrawn.code, as_access_code.code);

        let claim_code_issuer = AccessCodesIssuer::new(FakeTunnelStore::default(), TTL);
        let store = &claim_code_issuer.store;
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let first_draw = ClaimCode::generate(&mut StdRng::seed_from_u64(0));
        assert!(store
            .replace_claim_code(&StoredClaimCode {
                code_hash: first_draw.hash(),
                tunnel_name: "alice".to_owned(),
                expires_at: 1_900,
            })
            .unwrap());
        let issued = claim_code_issuer
            .issue(&mut StdRng::seed_from_u64(0), || Ok(1_000))
            .unwrap();
        assert_ne!(issued.code, first_draw);
    }
}
