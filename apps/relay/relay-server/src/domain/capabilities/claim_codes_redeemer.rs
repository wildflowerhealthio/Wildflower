//! The redeem capability — [`ClaimCodesRedeemer`], for `POST /claim`.
//!
//! Unlike the other capabilities it is not gated by the admin signature:
//! the code is the credential. It checks the code first, so every way a code
//! can fail to redeem is the one [`TunnelError::ClaimCodeRejected`], whatever
//! details came with it, and the answer says nothing about which codes
//! exist. Guessing is throttled by the route's rate limits.
//!
//! A code that would redeem then decides what the request needs:
//!
//! - A [`Preset`](ClaimCodeTarget::Preset) code, sent alone, is burned for
//!   its tunnel's name and token. Sent with details it is
//!   [`TunnelError::ClaimCodeNamesTunnel`], unburned.
//! - An [`Open`](ClaimCodeTarget::Open) code, sent alone, is
//!   [`TunnelError::ClaimCodeNeedsDetails`], unburned, so a device that has
//!   only the code learns to ask for an email and a name. Sent with them,
//!   the email and name are checked as `POST /api/tunnels` checks them, and
//!   refused with the same reasons, leaving the code unburned for another
//!   try. Then the tunnel is stored and the code burned in one store write.
//!   Serving the new tunnel, and undoing the write if that fails, is the
//!   registry's.

use rand::Rng;
use wildflowerhealthio_rathole_settings::ClaimDetails;

use super::tunnels_creator::new_stored_tunnel;
use crate::domain::{
    ClaimCode, ClaimCodeStore, ClaimCodeTarget, RedeemedClaimCode, TunnelError, TunnelStore,
};
use crate::settings::RelayHostnames;

/// Redeeming — `POST /claim`. Holds the store and the relay's hostnames
/// (for reserved names), lifted from the state.
pub(crate) struct ClaimCodesRedeemer<S: TunnelStore + ClaimCodeStore> {
    store: S,
    hostnames: RelayHostnames,
}

impl<S: TunnelStore + ClaimCodeStore> ClaimCodesRedeemer<S> {
    pub(crate) fn new(store: S, hostnames: RelayHostnames) -> Self {
        Self { store, hostnames }
    }

    /// Redeem the code `typed_code` spells (see [`ClaimCode::parse`]) at the
    /// time `now` reads (Unix epoch seconds), burning it: for the tunnel it
    /// names, or, with `details`, for a new tunnel for their email, named
    /// their name or, without one, two random words, with a random token
    /// from `rng`.
    ///
    /// # Errors
    ///
    /// [`TunnelError::ClaimCodeRejected`] when the code is malformed (before
    /// `now` is read), unknown, already redeemed or expired, with nothing
    /// changed; whatever `now` fails with; then, with the code unburned,
    /// [`TunnelError::ClaimCodeNamesTunnel`] or
    /// [`ClaimCodeNeedsDetails`](TunnelError::ClaimCodeNeedsDetails) when
    /// `details` are sent for a code that names its tunnel or missing for
    /// one that does not, and [`TunnelError::InvalidEmail`],
    /// [`InvalidName`](TunnelError::InvalidName),
    /// [`Reserved`](TunnelError::Reserved), [`Taken`](TunnelError::Taken) or
    /// [`Exhausted`](TunnelError::Exhausted) for their email and name; and
    /// [`TunnelError::Infrastructure`] if a store read or write fails.
    pub(crate) fn redeem<R: Rng + ?Sized>(
        &self,
        typed_code: &str,
        details: Option<&ClaimDetails>,
        rng: &mut R,
        now: impl FnOnce() -> Result<i64, TunnelError>,
    ) -> Result<RedeemedClaimCode, TunnelError> {
        let code_hash = ClaimCode::parse(typed_code)
            .ok_or(TunnelError::ClaimCodeRejected)?
            .hash();
        let now = now()?;
        let target = self
            .store
            .claim_code_target(&code_hash, now)?
            .ok_or(TunnelError::ClaimCodeRejected)?;
        match (target, details) {
            (ClaimCodeTarget::Preset { .. }, None) => self
                .store
                .take_preset_claim_code(&code_hash, now)?
                .map(RedeemedClaimCode::Preset)
                .ok_or(TunnelError::ClaimCodeRejected),
            (ClaimCodeTarget::Preset { .. }, Some(_)) => Err(TunnelError::ClaimCodeNamesTunnel),
            (ClaimCodeTarget::Open, None) => Err(TunnelError::ClaimCodeNeedsDetails),
            (ClaimCodeTarget::Open, Some(details)) => {
                let stored = new_stored_tunnel(
                    &self.store,
                    &self.hostnames,
                    &details.email,
                    details.tunnel_name.as_deref(),
                    rng,
                    || Ok(now),
                )?;
                let claim_code = self
                    .store
                    .take_open_claim_code_for_tunnel(&code_hash, now, &stored)?
                    .ok_or(TunnelError::ClaimCodeRejected)?;
                Ok(RedeemedClaimCode::Open { stored, claim_code })
            }
        }
    }

    /// Take back what [`Self::redeem`] stored, and put its code back, when
    /// serving the tunnel it created failed. A
    /// [`Preset`](RedeemedClaimCode::Preset) redemption created nothing to
    /// serve, so there is nothing to undo.
    ///
    /// # Errors
    ///
    /// [`TunnelError::Infrastructure`] if a store write fails.
    pub(crate) fn undo(&self, redeemed: &RedeemedClaimCode) -> Result<(), TunnelError> {
        let RedeemedClaimCode::Open { stored, claim_code } = redeemed else {
            return Ok(());
        };
        self.store.delete_tunnel(&stored.tunnel.name)?;
        self.store.insert_claim_code(claim_code).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::*;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::{StoredClaimCode, StoredTunnel, Tunnel};
    use crate::test_support::settings;

    /// A redeemer over a store holding `alice` and `bob`, a code for `alice`
    /// and an open code, both expiring at `1_900`; and the two codes as
    /// typed, `alice`'s first.
    fn issued() -> (ClaimCodesRedeemer<FakeTunnelStore>, String, String) {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        let [preset, open] =
            [0, 1].map(|seed| ClaimCode::generate(&mut StdRng::seed_from_u64(seed)));
        for (code, target) in [
            (
                &preset,
                ClaimCodeTarget::Preset {
                    tunnel_name: "alice".to_owned(),
                },
            ),
            (&open, ClaimCodeTarget::Open),
        ] {
            assert!(store
                .insert_claim_code(&StoredClaimCode {
                    code_hash: code.hash(),
                    target,
                    expires_at: 1_900,
                })
                .unwrap());
        }
        let hostnames = settings(std::path::Path::new("/nonexistent"), None)
            .front
            .hostnames;
        (
            ClaimCodesRedeemer::new(store, hostnames),
            preset.to_string(),
            open.to_string(),
        )
    }

    fn details(email: &str, name: Option<&str>) -> ClaimDetails {
        ClaimDetails {
            email: email.to_owned(),
            tunnel_name: name.map(str::to_owned),
        }
    }

    fn redeem(
        redeemer: &ClaimCodesRedeemer<FakeTunnelStore>,
        code: &str,
        details: Option<&ClaimDetails>,
        now: i64,
    ) -> Result<RedeemedClaimCode, TunnelError> {
        let mut rng = StdRng::seed_from_u64(2);
        redeemer.redeem(code, details, &mut rng, || Ok(now))
    }

    /// The open code `redeemer` holds, as stored.
    fn open_code(redeemer: &ClaimCodesRedeemer<FakeTunnelStore>) -> Vec<StoredClaimCode> {
        redeemer
            .store
            .claim_codes()
            .into_iter()
            .filter(|stored| stored.target == ClaimCodeTarget::Open)
            .collect()
    }

    #[test]
    fn a_preset_code_redeems_once_for_its_tunnel() {
        let (redeemer, preset, _) = issued();
        let typed = preset.to_lowercase();
        assert_eq!(
            redeem(&redeemer, &typed, None, 1_899).unwrap(),
            RedeemedClaimCode::Preset(stored_tunnel("alice").tunnel)
        );
        assert_eq!(
            redeem(&redeemer, &typed, None, 1_899).unwrap_err(),
            TunnelError::ClaimCodeRejected,
            "a redeemed code is burned"
        );
        assert_eq!(redeemer.store.claim_codes().len(), 1, "the open code stays");
    }

    #[test]
    fn an_open_code_redeems_once_for_a_tunnel_under_the_chosen_email_and_name() {
        let (redeemer, _, open) = issued();
        let carol = details(" carol@example.com ", Some("carol"));
        let redeemed = redeem(&redeemer, &open.to_lowercase(), Some(&carol), 1_000).unwrap();
        let RedeemedClaimCode::Open { stored, claim_code } = &redeemed else {
            panic!("redeemed {redeemed:?}");
        };
        assert_eq!(stored.tunnel.name, "carol");
        assert_eq!(stored.email, "carol@example.com");
        assert_eq!(stored.created_at, 1_000);
        assert_eq!(claim_code.target, ClaimCodeTarget::Open);
        assert_eq!(claim_code.expires_at, 1_900);
        assert_eq!(
            redeemer.store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored_tunnel("bob"), stored.clone()]
        );
        assert!(open_code(&redeemer).is_empty(), "burned");
        assert_eq!(
            redeem(
                &redeemer,
                &open,
                Some(&details("dave@example.com", None)),
                1_000
            )
            .unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }

    #[test]
    fn without_a_name_an_open_code_s_tunnel_gets_an_unused_default() {
        let (redeemer, _, open) = issued();
        let redeemed = redeem(
            &redeemer,
            &open,
            Some(&details("carol@example.com", None)),
            1_000,
        )
        .unwrap();
        assert!(!["alice", "bob"].contains(&redeemed.tunnel().name.as_str()));
        assert_eq!(redeemer.store.list_tunnels().unwrap().len(), 3);
    }

    /// Each code asks for what it lacks, or refuses what it has no use for,
    /// and stays to redeem when sent as it should be.
    #[test]
    fn a_code_sent_with_the_wrong_details_stays_unburned() {
        let (redeemer, preset, open) = issued();
        let carol = details("carol@example.com", Some("carol"));
        for _ in 0..2 {
            assert_eq!(
                redeem(&redeemer, &preset, Some(&carol), 1_000).unwrap_err(),
                TunnelError::ClaimCodeNamesTunnel
            );
            assert_eq!(
                redeem(&redeemer, &open, None, 1_000).unwrap_err(),
                TunnelError::ClaimCodeNeedsDetails
            );
        }
        assert_eq!(redeemer.store.claim_codes().len(), 2, "unburned");
        redeem(&redeemer, &preset, None, 1_000).unwrap();
        redeem(&redeemer, &open, Some(&carol), 1_000).unwrap();
    }

    /// A bad email or name is refused only for a code that would redeem,
    /// and leaves it to redeem on another try.
    #[test]
    fn a_refused_email_or_name_leaves_the_open_code_unburned() {
        let (redeemer, _, open) = issued();
        for (email, name, expected) in [
            ("not an email", Some("carol"), TunnelError::InvalidEmail),
            ("carol@example.com", Some("Carol"), TunnelError::InvalidName),
            ("carol@example.com", Some("admin"), TunnelError::Reserved),
            ("carol@example.com", Some("alice"), TunnelError::Taken),
        ] {
            assert_eq!(
                redeem(&redeemer, &open, Some(&details(email, name)), 1_000).unwrap_err(),
                expected,
                "{email:?} {name:?}"
            );
        }
        assert_eq!(open_code(&redeemer).len(), 1, "unburned");
        assert_eq!(redeemer.store.list_tunnels().unwrap().len(), 2);
        redeem(
            &redeemer,
            &open,
            Some(&details("carol@example.com", Some("carol"))),
            1_000,
        )
        .unwrap();
    }

    /// Malformed, unknown, used and expired codes are one refusal, whatever
    /// details come with them.
    #[test]
    fn every_code_failure_is_the_same_refusal() {
        let (redeemer, preset, open) = issued();
        redeem(&redeemer, &preset, None, 1_000).unwrap();
        redeem(
            &redeemer,
            &open,
            Some(&details("carol@example.com", None)),
            1_000,
        )
        .unwrap();
        let (expired_redeemer, expired_preset, expired_open) = issued();
        let bad_details = details("not an email", Some("Bad Name"));
        for (redeemer, typed, now) in [
            (&redeemer, "not a code", 1_000),
            (&redeemer, "2222-2222", 1_000),
            (&redeemer, preset.as_str(), 1_000),
            (&redeemer, open.as_str(), 1_000),
            (&expired_redeemer, expired_preset.as_str(), 1_900),
            (&expired_redeemer, expired_open.as_str(), 1_900),
        ] {
            for details in [None, Some(&bad_details)] {
                assert_eq!(
                    redeem(redeemer, typed, details, now).unwrap_err(),
                    TunnelError::ClaimCodeRejected,
                    "{typed:?} {details:?}"
                );
            }
        }
    }

    /// A malformed code is refused before the clock is read.
    #[test]
    fn a_malformed_code_is_refused_before_the_clock() {
        let (redeemer, _, _) = issued();
        let mut rng = StdRng::seed_from_u64(0);
        let result = redeemer.redeem("O0O0-O0O0", None, &mut rng, || {
            Err(TunnelError::infrastructure(
                "reading the clock failed",
                "boom",
            ))
        });
        assert_eq!(result.unwrap_err(), TunnelError::ClaimCodeRejected);
    }

    #[test]
    fn deleting_the_tunnel_deletes_its_code() {
        let (redeemer, preset, _) = issued();
        redeemer.store.delete_tunnel("alice").unwrap();
        assert_eq!(
            redeem(&redeemer, &preset, None, 1_000).unwrap_err(),
            TunnelError::ClaimCodeRejected
        );
    }

    /// Undoing an open code's redemption takes the tunnel back and puts the
    /// code back to redeem again; undoing a preset one changes nothing.
    #[test]
    fn undo_takes_back_an_open_code_s_tunnel_and_restores_the_code() {
        let (redeemer, preset, open) = issued();
        let carol = details("carol@example.com", Some("carol"));
        let redeemed = redeem(&redeemer, &open, Some(&carol), 1_000).unwrap();
        redeemer.undo(&redeemed).unwrap();
        assert_eq!(
            redeemer.store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored_tunnel("bob")]
        );
        let again: Tunnel = redeem(&redeemer, &open, Some(&carol), 1_000)
            .unwrap()
            .tunnel()
            .clone();
        assert_eq!(again.name, "carol");

        let preset_redeemed = redeem(&redeemer, &preset, None, 1_000).unwrap();
        let before: Vec<StoredTunnel> = redeemer.store.list_tunnels().unwrap();
        redeemer.undo(&preset_redeemed).unwrap();
        assert_eq!(redeemer.store.list_tunnels().unwrap(), before);
        assert!(redeemer.store.claim_codes().is_empty());
    }
}
