//! The issue capability — [`ClaimCodesIssuer`], for
//! `POST /api/tunnels/{name}/claim-codes` and `POST /api/claim-codes`.
//!
//! For a [`Preset`](ClaimCodeTarget::Preset) code it refuses an unknown
//! tunnel before the clock is read. Then it drops the codes that have
//! expired, draws a code and stores its hash with an expiry the relay's
//! settings give. A tunnel has one outstanding code, so a new preset code
//! replaces any earlier one, which stops redeeming; any number of
//! [`Open`](ClaimCodeTarget::Open) codes are outstanding at once. The code
//! itself is returned once and never stored.

use std::time::Duration;

use rand::Rng;

use crate::domain::{
    ClaimCode, ClaimCodeStore, ClaimCodeTarget, IssuedClaimCode, StoredClaimCode, TunnelError,
    TunnelStore,
};

/// How many codes [`ClaimCodesIssuer::issue`] draws before giving up, should
/// each already be stored. Among 31⁸ codes, a second draw is already
/// vanishingly rare.
const MAX_DRAWS: usize = 8;

/// Issuing — `POST /api/tunnels/{name}/claim-codes` and
/// `POST /api/claim-codes`. Holds the store and how long a code redeems
/// for, lifted from the state.
pub(crate) struct ClaimCodesIssuer<S: TunnelStore + ClaimCodeStore> {
    store: S,
    claim_code_ttl: Duration,
}

impl<S: TunnelStore + ClaimCodeStore> ClaimCodesIssuer<S> {
    pub(crate) fn new(store: S, claim_code_ttl: Duration) -> Self {
        Self {
            store,
            claim_code_ttl,
        }
    }

    /// Issue a claim code for `target`, drawn from `rng`, that redeems until
    /// `claim_code_ttl` after the time `now` reads (Unix epoch seconds). A
    /// preset code replaces its tunnel's earlier code. Codes expired by then
    /// are deleted first.
    ///
    /// For a preset code, the caller keeps the tunnel from being deleted
    /// between the check that it exists and the store write.
    ///
    /// # Errors
    ///
    /// [`TunnelError::NotFound`] when no stored tunnel has a preset code's
    /// name, before `now` is read and with nothing stored; then whatever
    /// `now` fails with; [`TunnelError::Exhausted`] if every draw is already
    /// stored; and [`TunnelError::Infrastructure`] if a store read or write
    /// fails.
    pub(crate) fn issue<R: Rng + ?Sized>(
        &self,
        target: &ClaimCodeTarget,
        rng: &mut R,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<IssuedClaimCode, TunnelError> {
        if let ClaimCodeTarget::Preset { tunnel_name } = target {
            if !self.store.contains_tunnel(tunnel_name)? {
                return Err(TunnelError::NotFound);
            }
        }
        let now = now()?;
        let ttl_secs = i64::try_from(self.claim_code_ttl.as_secs())
            .map_err(|e| TunnelError::infrastructure("the claim code lifetime is too long", e))?;
        let expires_at = now + ttl_secs;
        self.store.delete_expired_claim_codes(now)?;
        for _ in 0..MAX_DRAWS {
            let code = ClaimCode::generate(rng);
            let stored = StoredClaimCode {
                code_hash: code.hash(),
                target: target.clone(),
                expires_at,
            };
            if self.store.insert_claim_code(&stored)? {
                return Ok(IssuedClaimCode { code, expires_at });
            }
        }
        Err(TunnelError::Exhausted("no unused claim code was drawn"))
    }
}

#[cfg(test)]
mod tests {
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::ClaimCodeHash;

    const TTL: Duration = Duration::from_secs(900);

    /// An issuer over a store holding `alice` and `bob`.
    fn issuer() -> ClaimCodesIssuer<FakeTunnelStore> {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        ClaimCodesIssuer::new(store, TTL)
    }

    fn preset(tunnel_name: &str) -> ClaimCodeTarget {
        ClaimCodeTarget::Preset {
            tunnel_name: tunnel_name.to_owned(),
        }
    }

    #[test]
    fn issues_a_code_stored_only_by_hash_until_the_ttl() {
        for target in [preset("alice"), ClaimCodeTarget::Open] {
            let issuer = issuer();
            let mut rng = StdRng::seed_from_u64(0);
            let issued = issuer.issue(&target, &mut rng, || Ok(1_000)).unwrap();
            assert_eq!(issued.expires_at, 1_900);
            assert_eq!(
                issuer.store.claim_codes(),
                [StoredClaimCode {
                    code_hash: issued.code.hash(),
                    target,
                    expires_at: 1_900,
                }]
            );
        }
    }

    /// An unknown tunnel is refused before the clock is read, so a clock
    /// failure can't turn the `404` into a `500`.
    #[test]
    fn an_unknown_tunnel_is_not_found_before_the_clock() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        let result = issuer.issue(&preset("nobody"), &mut rng, || {
            Err(TunnelError::infrastructure(
                "reading the clock failed",
                "boom",
            ))
        });
        assert_eq!(result.unwrap_err(), TunnelError::NotFound);
        assert!(issuer.store.claim_codes().is_empty());
    }

    #[test]
    fn issuing_drops_the_codes_that_have_expired() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        let expired = issuer
            .issue(&ClaimCodeTarget::Open, &mut rng, || Ok(1_000))
            .unwrap();
        let live = issuer
            .issue(&preset("bob"), &mut rng, || Ok(expired.expires_at))
            .unwrap();
        assert_eq!(
            issuer
                .store
                .claim_codes()
                .iter()
                .map(|stored| stored.code_hash)
                .collect::<Vec<ClaimCodeHash>>(),
            [live.code.hash()]
        );
    }

    /// Issuing again for a tunnel replaces its code; open codes add up.
    #[test]
    fn a_preset_code_replaces_the_tunnels_earlier_one_and_open_codes_add_up() {
        let issuer = issuer();
        let mut rng = StdRng::seed_from_u64(0);
        issuer
            .issue(&preset("alice"), &mut rng, || Ok(1_000))
            .unwrap();
        let later = issuer
            .issue(&preset("alice"), &mut rng, || Ok(1_000))
            .unwrap();
        assert_eq!(
            issuer
                .store
                .claim_codes()
                .iter()
                .map(|stored| stored.code_hash)
                .collect::<Vec<ClaimCodeHash>>(),
            [later.code.hash()]
        );
        for _ in 0..2 {
            issuer
                .issue(&ClaimCodeTarget::Open, &mut rng, || Ok(1_000))
                .unwrap();
        }
        assert_eq!(issuer.store.claim_codes().len(), 3);
    }

    /// A drawn code already stored, of either kind, is drawn again.
    #[test]
    fn a_code_already_stored_is_drawn_again() {
        let issuer = issuer();
        let mut codes = Vec::new();
        for target in [preset("alice"), ClaimCodeTarget::Open, preset("bob")] {
            let issued = issuer
                .issue(&target, &mut StdRng::seed_from_u64(0), || Ok(1_000))
                .unwrap();
            assert!(!codes.contains(&issued.code), "{target:?}");
            codes.push(issued.code);
        }
        assert_eq!(issuer.store.claim_codes().len(), 3);
    }
}
