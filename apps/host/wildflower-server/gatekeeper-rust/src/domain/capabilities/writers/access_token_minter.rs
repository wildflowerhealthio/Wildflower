//! [`AccessTokenMinter`] — the writer that reads the active signing key and
//! mints a JWT. What a token claims (client, scopes, patient) comes from a
//! [`TokenEntitlement`] proof, never from a caller-assembled scope slice, so
//! what a token can be minted *for* is that enum's closed set of variants. Where
//! the token is valid (the server's origin, its `iss` and `aud` both) and for
//! how long are fixed when the minter is built.

use chrono::Duration;

use crate::domain::authority::TokenEntitlement;
use crate::domain::token::{mint_access_token, NewJwtArgs, TokenIssuanceError};
use crate::domain::GatekeeperStore;

/// Mint access tokens for one server. A borrowed view over the store; the gate
/// is the [`TokenEntitlement`] proof [`mint`](Self::mint) takes.
pub(crate) struct AccessTokenMinter<'a, S: GatekeeperStore> {
    store: &'a S,
    /// The server's bare origin: both the `iss` and the `aud` claim.
    server_origin: &'a str,
    ttl: Duration,
}

impl<'a, S: GatekeeperStore> AccessTokenMinter<'a, S> {
    /// A writer over `store` minting tokens issued by and for `server_origin`,
    /// that live for `ttl`.
    pub(crate) fn new(store: &'a S, server_origin: &'a str, ttl: Duration) -> Self {
        AccessTokenMinter {
            store,
            server_origin,
            ttl,
        }
    }

    /// Sign a token carrying exactly the entitlement's client, scopes and
    /// patient, and return it.
    ///
    /// # Errors
    ///
    /// [`TokenIssuanceError::NoActiveSigningKey`] when no key can sign;
    /// [`TokenIssuanceError::Signing`] on a key-material or encoding failure;
    /// [`TokenIssuanceError::Store`] when the key store can't be read.
    pub(crate) fn mint(
        &self,
        entitlement: TokenEntitlement<'_>,
    ) -> Result<String, TokenIssuanceError> {
        let key = self
            .store
            .active_signing_key()?
            .ok_or(TokenIssuanceError::NoActiveSigningKey)?;
        Ok(mint_access_token(
            &key,
            &NewJwtArgs {
                client_id: entitlement.client_id(),
                scopes: entitlement.token_scopes(),
                ttl: self.ttl,
                issuer: self.server_origin,
                audience: Some(self.server_origin),
                patient: entitlement.patient(),
            },
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authority::HostOwnerEntitlement;

    use crate::domain::test_fake::{seed_active_signing_key, FakeGatekeeperStore};
    use crate::domain::token::{verify_jwt, VerifyOptions};

    fn minter(store: &FakeGatekeeperStore) -> AccessTokenMinter<'_, FakeGatekeeperStore> {
        AccessTokenMinter::new(store, "https://server.example", Duration::minutes(5))
    }

    /// With no signing key seeded, minting fails closed rather than producing an
    /// unsigned or differently-signed token.
    #[test]
    fn mint_fails_closed_without_an_active_key() {
        let store = FakeGatekeeperStore::default();
        let entitlement = HostOwnerEntitlement::for_host("host", &["openid".to_owned()]);
        let outcome = minter(&store).mint(TokenEntitlement::HostOwner(&entitlement));
        assert!(matches!(
            outcome,
            Err(TokenIssuanceError::NoActiveSigningKey)
        ));
    }

    /// The minted token carries exactly the entitlement's claims — client and
    /// scopes — names the server's origin as both `iss` and `aud`, and verifies
    /// against the seeded key.
    #[test]
    fn mint_signs_exactly_the_proofs_claims() {
        let store = FakeGatekeeperStore::default();
        seed_active_signing_key(&store);
        let scopes = vec!["system/*.cruds".to_owned(), "openid".to_owned()];
        let entitlement = HostOwnerEntitlement::for_host("host", &scopes);
        let access_token = minter(&store)
            .mint(TokenEntitlement::HostOwner(&entitlement))
            .expect("mint");
        let keys = store.all_signing_keys().unwrap();
        let claims = verify_jwt(
            &access_token,
            &keys,
            &VerifyOptions {
                expected_issuer: "https://server.example",
                accepted_audiences: &["https://server.example".to_owned()],
            },
        )
        .expect("verifies against the seeded key");
        assert_eq!(claims.subject, "host");
        assert_eq!(claims.scope.as_deref(), Some("system/*.cruds openid"));
        assert_eq!(claims.issuer, "https://server.example");
        assert_eq!(claims.audience, vec!["https://server.example".to_owned()]);
    }
}
