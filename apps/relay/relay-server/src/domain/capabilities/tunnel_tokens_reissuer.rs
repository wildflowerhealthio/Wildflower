//! The reissue capability — [`TunnelTokensReissuer`], for
//! `POST /api/tunnels/{name}/token`.
//!
//! It draws a new token the way a create does and stores it in place of the
//! tunnel's token. Serving the new token, which stops the old one working,
//! and undoing the store write if that fails, is the registry's. The
//! tunnel's outstanding claim code is left alone: it reads the token when
//! it is redeemed, so it redeems for the new one.

use rand::Rng;

use super::tunnels_creator::generate_token;
use crate::domain::{ReissuedTunnel, Tunnel, TunnelError, TunnelStore};

/// Reissuing — `POST /api/tunnels/{name}/token`. Holds the store, lifted
/// from the state.
pub(crate) struct TunnelTokensReissuer<S: TunnelStore> {
    store: S,
}

impl<S: TunnelStore> TunnelTokensReissuer<S> {
    pub(crate) fn new(store: S) -> Self {
        Self { store }
    }

    /// Replace the token of the tunnel named `name` with a random one from
    /// `rng`. Returns the tunnel as now stored, with the token it replaced
    /// for [`Self::undo`].
    ///
    /// # Errors
    ///
    /// [`TunnelError::NotFound`] when no stored tunnel has the name, with
    /// nothing stored; [`TunnelError::Infrastructure`] if the store write
    /// fails.
    pub(crate) fn reissue<R: Rng + ?Sized>(
        &self,
        name: &str,
        rng: &mut R,
    ) -> Result<ReissuedTunnel, TunnelError> {
        let reissued = Tunnel {
            name: name.to_owned(),
            token: generate_token(rng),
        };
        let mut stored = self
            .store
            .replace_token(&reissued)?
            .ok_or(TunnelError::NotFound)?;
        let previous_token = std::mem::replace(&mut stored.tunnel, reissued).token;
        Ok(ReissuedTunnel {
            stored,
            previous_token,
        })
    }

    /// Put back the token [`Self::reissue`] replaced, when serving the
    /// change failed.
    ///
    /// # Errors
    ///
    /// [`TunnelError::NotFound`] if the tunnel has been deleted since;
    /// [`TunnelError::Infrastructure`] if the store write fails.
    pub(crate) fn undo(&self, reissued: &ReissuedTunnel) -> Result<(), TunnelError> {
        let previous = Tunnel {
            name: reissued.stored.tunnel.name.clone(),
            token: reissued.previous_token.clone(),
        };
        self.store
            .replace_token(&previous)?
            .map(drop)
            .ok_or(TunnelError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL;
    use base64::Engine;
    use rand::rngs::StdRng;
    use rand::SeedableRng;

    use super::super::tunnels_creator::TOKEN_BYTES;
    use super::*;
    use crate::domain::capabilities::ClaimCodesRedeemer;
    use crate::domain::test_fake::{stored_tunnel, FakeTunnelStore};
    use crate::domain::{ClaimCode, ClaimCodeStore, StoredClaimCode};

    /// A store holding `alice` and `bob`.
    fn store() -> FakeTunnelStore {
        let store = FakeTunnelStore::default();
        store.insert_tunnel(&stored_tunnel("alice")).unwrap();
        store.insert_tunnel(&stored_tunnel("bob")).unwrap();
        store
    }

    #[test]
    fn reissuing_stores_a_new_token_and_keeps_the_rest() {
        let reissuer = TunnelTokensReissuer::new(store());
        let reissued = reissuer
            .reissue("alice", &mut StdRng::seed_from_u64(0))
            .unwrap();
        let alice = stored_tunnel("alice");
        assert_eq!(reissued.previous_token, alice.tunnel.token);
        assert_ne!(reissued.stored.tunnel.token, alice.tunnel.token);
        assert_eq!(
            BASE64_URL
                .decode(reissued.stored.tunnel.token.expose())
                .unwrap()
                .len(),
            TOKEN_BYTES
        );
        assert_eq!(reissued.stored.email, alice.email);
        assert_eq!(reissued.stored.created_at, alice.created_at);
        assert_eq!(
            reissuer.store.list_tunnels().unwrap(),
            [reissued.stored.clone(), stored_tunnel("bob")]
        );

        reissuer.undo(&reissued).unwrap();
        assert_eq!(
            reissuer.store.list_tunnels().unwrap(),
            [alice, stored_tunnel("bob")]
        );
    }

    #[test]
    fn reissuing_for_an_unknown_tunnel_is_not_found() {
        let reissuer = TunnelTokensReissuer::new(store());
        assert_eq!(
            reissuer
                .reissue("nobody", &mut StdRng::seed_from_u64(0))
                .unwrap_err(),
            TunnelError::NotFound
        );
        assert_eq!(
            reissuer.store.list_tunnels().unwrap(),
            [stored_tunnel("alice"), stored_tunnel("bob")]
        );
    }

    /// A claim code issued before the reissue redeems for the new token.
    #[test]
    fn an_outstanding_claim_code_redeems_for_the_new_token() {
        let reissuer = TunnelTokensReissuer::new(store());
        let code = ClaimCode::generate(&mut StdRng::seed_from_u64(1));
        assert!(reissuer
            .store
            .replace_claim_code(&StoredClaimCode {
                code_hash: code.hash(),
                tunnel_name: "alice".to_owned(),
                expires_at: 1_900,
            })
            .unwrap());
        let reissued = reissuer
            .reissue("alice", &mut StdRng::seed_from_u64(0))
            .unwrap();

        let redeemer = ClaimCodesRedeemer::new(reissuer.store);
        assert_eq!(
            redeemer.redeem(&code.to_string(), || Ok(1_000)).unwrap(),
            reissued.stored.tunnel
        );
    }
}
