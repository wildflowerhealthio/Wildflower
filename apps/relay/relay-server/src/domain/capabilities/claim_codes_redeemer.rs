//! The redeem capability — [`ClaimCodesRedeemer`], for `POST /claim`.
//!
//! Unlike the other capabilities it is not gated by the admin signature:
//! the code is the credential. Every way a code can fail to redeem is the
//! one [`TunnelError::ClaimCodeRejected`], so the answer says nothing about
//! which codes exist. Guessing is throttled by the route's rate limits.
//!
//! A code that would redeem as an access code instead is
//! [`TunnelError::AccessCodeOffered`], unburned, so a device that has only
//! the code learns to ask for an email and a name and redeem it at
//! `POST /access`.

use crate::domain::{AccessCodeStore, ClaimCode, ClaimCodeStore, Tunnel, TunnelError};

/// Redeeming — `POST /claim`. Holds the store, lifted from the state.
pub(crate) struct ClaimCodesRedeemer<S: ClaimCodeStore + AccessCodeStore> {
    store: S,
}

impl<S: ClaimCodeStore + AccessCodeStore> ClaimCodesRedeemer<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Redeem the code `typed_code` spells (see [`ClaimCode::parse`]) at the
    /// time `now` reads (Unix epoch seconds): burn it and return the tunnel
    /// it was issued for, name and token.
    ///
    /// # Errors
    ///
    /// [`TunnelError::ClaimCodeRejected`] when the code is malformed,
    /// unknown, already redeemed or expired;
    /// [`TunnelError::AccessCodeOffered`] when it is an unexpired access
    /// code, which stays unburned; whatever `now` fails with; and
    /// [`TunnelError::Infrastructure`] if a store read or write fails.
    pub(crate) fn redeem(
        &self,
        typed_code: &str,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<Tunnel, TunnelError> {
        let code_hash = ClaimCode::parse(typed_code)
            .ok_or(TunnelError::ClaimCodeRejected)?
            .hash();
        let now = now()?;
        if let Some(tunnel) = self.store.take_claim_code(&code_hash, now)? {
            return Ok(tunnel);
        }
        if self.store.contains_access_code(&code_hash, now)? {
            return Err(TunnelError::AccessCodeOffered);
        }
        Err(TunnelError::ClaimCodeRejected)
    }
}

#[cfg(test)]
mod tests {
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::{IssuedClaimCode, StoredAccessCode, StoredClaimCode, TunnelStore};

    /// A store holding `alice` and `bob`, and a code for `alice` that
    /// expires at `1_900`.
    fn issued() -> (FakeTunnelStore, IssuedClaimCode) {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        let code = ClaimCode::generate(&mut StdRng::seed_from_u64(0));
        let stored = StoredClaimCode {
            code_hash: code.hash(),
            tunnel_name: "alice".to_owned(),
            expires_at: 1_900,
        };
        assert!(store.replace_claim_code(&stored).unwrap());
        let issued = IssuedClaimCode {
            code,
            expires_at: 1_900,
        };
        (store, issued)
    }

    #[test]
    fn a_code_redeems_once_for_its_tunnel() {
        let (store, issued) = issued();
        let redeemer = ClaimCodesRedeemer::new(store);
        let code = issued.code.to_string().to_lowercase();
        assert_eq!(
            redeemer.redeem(&code, || Ok(1_899)).unwrap(),
            stored_tunnel("alice").tunnel
        );
        assert_eq!(
            redeemer.redeem(&code, || Ok(1_899)).unwrap_err(),
            TunnelError::ClaimCodeRejected,
            "a redeemed code is burned"
        );
        assert!(redeemer.store.claim_codes().is_empty());
    }

    #[test]
    fn a_code_stops_redeeming_when_it_expires() {
        let (store, issued) = issued();
        let redeemer = ClaimCodesRedeemer::new(store);
        let code = issued.code.to_string();
        assert_eq!(
            redeemer
                .redeem(&code, || Ok(issued.expires_at))
                .unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }

    /// Malformed, unknown, used and expired codes are one refusal.
    #[test]
    fn every_failure_is_the_same_refusal() {
        let (store, issued) = issued();
        let redeemer = ClaimCodesRedeemer::new(store);
        let code = issued.code.to_string();
        redeemer.redeem(&code, || Ok(1_000)).unwrap();
        let (store, expired) = self::issued();
        let expired_redeemer = ClaimCodesRedeemer::new(store);
        for (redeemer, typed, now) in [
            (&redeemer, "not a code", 1_000),
            (&redeemer, "2222-2222", 1_000),
            (&redeemer, code.as_str(), 1_000),
            (&expired_redeemer, &expired.code.to_string(), 2_000),
        ] {
            assert_eq!(
                redeemer.redeem(typed, || Ok(now)).unwrap_err(),
                TunnelError::ClaimCodeRejected,
                "{typed:?}"
            );
        }
    }

    /// A malformed code is refused before the clock is read.
    #[test]
    fn a_malformed_code_is_refused_before_the_clock() {
        let (store, _) = issued();
        let redeemer = ClaimCodesRedeemer::new(store);
        let result = redeemer.redeem("O0O0-O0O0", || {
            Err(TunnelError::infrastructure(
                "reading the clock failed",
                "boom",
            ))
        });
        assert_eq!(result.unwrap_err(), TunnelError::ClaimCodeRejected);
    }

    /// An unexpired access code is answered as one, and stays to redeem at
    /// `POST /access`; an expired one is refused like any unknown code.
    #[test]
    fn an_access_code_is_offered_unburned() {
        let (store, _) = issued();
        let access_code = ClaimCode::generate(&mut StdRng::seed_from_u64(1));
        assert!(store
            .insert_access_code(&StoredAccessCode {
                code_hash: access_code.hash(),
                expires_at: 1_900,
            })
            .unwrap());
        let redeemer = ClaimCodesRedeemer::new(store);
        let typed = access_code.to_string();
        for _ in 0..2 {
            assert_eq!(
                redeemer.redeem(&typed, || Ok(1_899)).unwrap_err(),
                TunnelError::AccessCodeOffered
            );
        }
        assert_eq!(redeemer.store.access_codes().len(), 1, "unburned");
        assert_eq!(
            redeemer.redeem(&typed, || Ok(1_900)).unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }

    #[test]
    fn deleting_the_tunnel_deletes_its_codes() {
        let (store, issued) = issued();
        store.delete_tunnel("alice").unwrap();
        let redeemer = ClaimCodesRedeemer::new(store);
        assert_eq!(
            redeemer
                .redeem(&issued.code.to_string(), || Ok(1_000))
                .unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }
}
