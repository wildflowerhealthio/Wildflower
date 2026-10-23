//! The redeem capability — [`AccessCodesRedeemer`], for `POST /access`.
//!
//! Like the claim-code redeemer it is not gated by the admin signature: the
//! code is the credential. It checks the code first, so every way a code can
//! fail is the one [`TunnelError::AccessCodeRejected`], whatever email and
//! name came with it. Only for a code that would redeem are the email and
//! name checked, as `POST /api/tunnels` checks them, and refused with the
//! same reasons, leaving the code unburned for another try. Then the tunnel
//! is stored and the code burned in one store write. Serving the new tunnel,
//! and undoing the write if that fails, is the registry's.

use rand::Rng;

use super::tunnels_creator::new_stored_tunnel;
use crate::domain::{AccessCodeStore, ClaimCode, RedeemedAccessCode, TunnelError, TunnelStore};
use crate::settings::FrontSettings;

/// Redeeming — `POST /access`. Holds the store and the front's settings (for
/// reserved names), lifted from the state.
pub(crate) struct AccessCodesRedeemer<S: TunnelStore + AccessCodeStore> {
    store: S,
    front: FrontSettings,
}

impl<S: TunnelStore + AccessCodeStore> AccessCodesRedeemer<S> {
    pub(crate) fn new(store: S, front: FrontSettings) -> Self {
        Self { store, front }
    }

    /// Redeem the access code `typed_code` spells (see [`ClaimCode::parse`])
    /// at the time `now` reads (Unix epoch seconds) for a new tunnel for
    /// `email`, named `name` or, without one, two random words, with a
    /// random token from `rng`: store the tunnel and burn the code.
    ///
    /// # Errors
    ///
    /// [`TunnelError::AccessCodeRejected`] when the code is malformed (before
    /// `now` is read), unknown, already redeemed or expired, with nothing
    /// changed; whatever `now` fails with; then, for a code that redeems,
    /// [`TunnelError::InvalidEmail`], [`InvalidName`](TunnelError::InvalidName),
    /// [`Reserved`](TunnelError::Reserved), [`Taken`](TunnelError::Taken) or
    /// [`Exhausted`](TunnelError::Exhausted), with the code unburned; and
    /// [`TunnelError::Infrastructure`] if a store read or write fails.
    pub(crate) fn redeem<R: Rng + ?Sized>(
        &self,
        typed_code: &str,
        email: &str,
        name: Option<&str>,
        rng: &mut R,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<RedeemedAccessCode, TunnelError> {
        let code_hash = ClaimCode::parse(typed_code)
            .ok_or(TunnelError::AccessCodeRejected)?
            .hash();
        let now = now()?;
        if !self.store.contains_access_code(&code_hash, now)? {
            return Err(TunnelError::AccessCodeRejected);
        }
        let stored = new_stored_tunnel(&self.store, &self.front, email, name, rng, || Ok(now))?;
        let access_code = self
            .store
            .take_access_code_for_tunnel(&code_hash, now, &stored)?
            .ok_or(TunnelError::AccessCodeRejected)?;
        Ok(RedeemedAccessCode {
            stored,
            access_code,
        })
    }

    /// Take back a tunnel [`Self::redeem`] stored, and put its code back,
    /// when serving the tunnel failed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if a store write fails.
    pub(crate) fn undo(&self, redeemed: &RedeemedAccessCode) -> Result<(), TunnelError> {
        self.store.delete_tunnel(&redeemed.stored.tunnel.name)?;
        self.store
            .insert_access_code(&redeemed.access_code)
            .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::{StoredAccessCode, StoredTunnel};
    use crate::test_support::settings;

    /// A store holding `alice` and an access code that expires at `1_900`,
    /// and that code as typed.
    fn issued() -> (AccessCodesRedeemer<FakeTunnelStore>, String) {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        let code = ClaimCode::generate(&mut StdRng::seed_from_u64(0));
        assert!(store
            .insert_access_code(&StoredAccessCode {
                code_hash: code.hash(),
                expires_at: 1_900,
            })
            .unwrap());
        let front = settings(std::path::Path::new("/nonexistent"), None).front;
        (AccessCodesRedeemer::new(store, front), code.to_string())
    }

    fn redeem(
        redeemer: &AccessCodesRedeemer<FakeTunnelStore>,
        code: &str,
        email: &str,
        name: Option<&str>,
        now: i64,
    ) -> Result<RedeemedAccessCode, TunnelError> {
        let mut rng = StdRng::seed_from_u64(1);
        redeemer.redeem(code, email, name, &mut rng, || Ok(now))
    }

    #[test]
    fn a_code_redeems_once_for_a_tunnel_under_the_chosen_email_and_name() {
        let (redeemer, code) = issued();
        let redeemed = redeem(
            &redeemer,
            &code.to_lowercase(),
            " bob@example.com ",
            Some("bob"),
            1_000,
        )
        .unwrap();
        assert_eq!(redeemed.stored.tunnel.name, "bob");
        assert_eq!(redeemed.stored.email, "bob@example.com");
        assert_eq!(redeemed.stored.created_at, 1_000);
        assert_eq!(redeemed.access_code.expires_at, 1_900);
        assert_eq!(
            redeemer.store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), redeemed.stored.clone()]
        );
        assert!(redeemer.store.access_codes().is_empty(), "burned");
        assert_eq!(
            redeem(&redeemer, &code, "carol@example.com", Some("carol"), 1_000).unwrap_err(),
            TunnelError::AccessCodeRejected
        );
    }

    #[test]
    fn without_a_name_the_tunnel_gets_an_unused_default() {
        let (redeemer, code) = issued();
        let redeemed = redeem(&redeemer, &code, "bob@example.com", None, 1_000).unwrap();
        assert_ne!(redeemed.stored.tunnel.name, "alice");
        assert_eq!(redeemer.store.list_tunnels().unwrap().len(), 2);
    }

    /// A bad email or name is refused only for a code that would redeem,
    /// and leaves it to redeem on another try.
    #[test]
    fn a_refused_email_or_name_leaves_the_code_unburned() {
        let (redeemer, code) = issued();
        for (email, name, expected) in [
            ("not an email", Some("bob"), TunnelError::InvalidEmail),
            ("bob@example.com", Some("Bob"), TunnelError::InvalidName),
            ("bob@example.com", Some("admin"), TunnelError::Reserved),
            ("bob@example.com", Some("alice"), TunnelError::Taken),
        ] {
            assert_eq!(
                redeem(&redeemer, &code, email, name, 1_000).unwrap_err(),
                expected,
                "{email:?} {name:?}"
            );
        }
        assert_eq!(redeemer.store.access_codes().len(), 1, "unburned");
        assert_eq!(redeemer.store.list_tunnels().unwrap().len(), 1);
        redeem(&redeemer, &code, "bob@example.com", Some("bob"), 1_000).unwrap();
    }

    /// Malformed, unknown, used and expired codes are one refusal, whatever
    /// email and name come with them.
    #[test]
    fn every_code_failure_is_the_same_refusal() {
        let (redeemer, code) = issued();
        let (expired_redeemer, expired) = issued();
        redeem(&redeemer, &code, "bob@example.com", Some("bob"), 1_000).unwrap();
        for (redeemer, typed, now) in [
            (&redeemer, "not a code", 1_000),
            (&redeemer, "2222-2222", 1_000),
            (&redeemer, code.as_str(), 1_000),
            (&expired_redeemer, expired.as_str(), 1_900),
        ] {
            assert_eq!(
                redeem(redeemer, typed, "not an email", Some("Bad Name"), now).unwrap_err(),
                TunnelError::AccessCodeRejected,
                "{typed:?}"
            );
        }
    }

    /// A malformed code is refused before the clock is read.
    #[test]
    fn a_malformed_code_is_refused_before_the_clock() {
        let (redeemer, _) = issued();
        let mut rng = StdRng::seed_from_u64(0);
        let result = redeemer.redeem("O0O0-O0O0", "bob@example.com", None, &mut rng, || {
            Err(TunnelError::infrastructure(
                "reading the clock failed",
                "boom",
            ))
        });
        assert_eq!(result.unwrap_err(), TunnelError::AccessCodeRejected);
    }

    /// A claim code is not an access code.
    #[test]
    fn a_claim_code_does_not_redeem_here() {
        use crate::domain::{ClaimCodeStore, StoredClaimCode};
        let (redeemer, _) = issued();
        let claim_code = ClaimCode::generate(&mut StdRng::seed_from_u64(7));
        assert!(redeemer
            .store
            .replace_claim_code(&StoredClaimCode {
                code_hash: claim_code.hash(),
                tunnel_name: "alice".to_owned(),
                expires_at: 1_900,
            })
            .unwrap());
        assert_eq!(
            redeem(
                &redeemer,
                &claim_code.to_string(),
                "bob@example.com",
                None,
                1_000
            )
            .unwrap_err(),
            TunnelError::AccessCodeRejected
        );
    }

    /// Undoing a redemption takes the tunnel back and puts the code back to
    /// redeem again.
    #[test]
    fn undo_takes_the_tunnel_back_and_restores_the_code() {
        let (redeemer, code) = issued();
        let redeemed = redeem(&redeemer, &code, "bob@example.com", Some("bob"), 1_000).unwrap();
        redeemer.undo(&redeemed).unwrap();
        assert_eq!(
            redeemer.store.list_tunnels().unwrap(),
            [stored_tunnel("alice")]
        );
        let again: StoredTunnel = redeem(&redeemer, &code, "bob@example.com", Some("bob"), 1_000)
            .unwrap()
            .stored;
        assert_eq!(again.tunnel.name, "bob");
    }
}
