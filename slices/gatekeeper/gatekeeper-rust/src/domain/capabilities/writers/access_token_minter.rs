//! [`AccessTokenMinter`] — the writer that reads the active signing key and
//! mints a JWT. What a token claims (client, scopes, patient, owner marker)
//! comes from a [`TokenEntitlement`] proof, never from a caller-assembled scope
//! slice, so what a token can be minted *for* is the closed set of proof types
//! in [`crate::domain::authority`]. Where the token is valid (issuer, audience)
//! and for how long are fixed when the minter is built.

use chrono::Duration;

use crate::domain::authority::TokenEntitlement;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::domain::GatekeeperStore;

/// The ways minting can fail. `NoActiveSigningKey` is an operator problem
/// (bootstrap has not run, or the key store was tampered with); `Signing` is a
/// key-material or encoding failure from [`mint_access_token`].
#[derive(Debug, thiserror::Error)]
pub(crate) enum TokenIssuanceError {
    #[error("no active signing key in store")]
    NoActiveSigningKey,
    #[error("sign access token")]
    Signing(#[from] MintError),
    #[error(transparent)]
    Store(#[from] GatekeeperError),
}

/// Mint access tokens for one issuer and audience. A borrowed view over the
/// store; the gate is the [`TokenEntitlement`] proof [`mint`](Self::mint) takes.
pub(crate) struct AccessTokenMinter<'a, S: GatekeeperStore> {
    store: &'a S,
    /// The `iss` claim.
    issuer: &'a str,
    /// The `aud` claim.
    audience: &'a str,
    ttl: Duration,
}

impl<'a, S: GatekeeperStore> AccessTokenMinter<'a, S> {
    /// A writer over `store` minting tokens issued by `issuer`, for `audience`,
    /// that live for `ttl`.
    pub(crate) fn new(store: &'a S, issuer: &'a str, audience: &'a str, ttl: Duration) -> Self {
        AccessTokenMinter {
            store,
            issuer,
            audience,
            ttl,
        }
    }

    /// Sign a token carrying exactly the entitlement's client, scopes, patient,
    /// and owner marker, and return it.
    ///
    /// # Errors
    ///
    /// [`TokenIssuanceError::NoActiveSigningKey`] when no key can sign;
    /// [`TokenIssuanceError::Signing`] on a key-material or encoding failure;
    /// [`TokenIssuanceError::Store`] when the key store can't be read.
    pub(crate) fn mint(
        &self,
        entitlement: &impl TokenEntitlement,
    ) -> Result<String, TokenIssuanceError> {
        let key = self
            .store
            .active_signing_key()?
            .ok_or(TokenIssuanceError::NoActiveSigningKey)?;
        Ok(mint_access_token(
            &key,
            &NewJwtArgs {
                client_id: entitlement.client_id(),
                scope: entitlement.scopes(),
                ttl: self.ttl,
                origin: self.issuer,
                audience: Some(self.audience),
                patient: entitlement.patient(),
                is_host_owner: entitlement.is_host_owner(),
            },
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authority::HostOwnerEntitlement;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::FakeGatekeeperStore;
    use crate::domain::token::{verify_jwt, VerifyOptions};

    fn minter(store: &FakeGatekeeperStore) -> AccessTokenMinter<'_, FakeGatekeeperStore> {
        AccessTokenMinter::new(
            store,
            "https://issuer.example",
            "https://issuer.example",
            Duration::minutes(5),
        )
    }

    /// With no signing key seeded, minting fails closed rather than producing an
    /// unsigned or differently-signed token.
    #[test]
    fn mint_fails_closed_without_an_active_key() {
        let store = FakeGatekeeperStore::default();
        let entitlement = HostOwnerEntitlement::for_host("host", &["openid".to_owned()]);
        let outcome = minter(&store).mint(&entitlement);
        assert!(matches!(
            outcome,
            Err(TokenIssuanceError::NoActiveSigningKey)
        ));
    }

    /// The minted token carries exactly the entitlement's claims — client,
    /// scopes, the owner marker — and verifies against the seeded key.
    #[test]
    fn mint_signs_exactly_the_proofs_claims() {
        let store = FakeGatekeeperStore::default();
        let mut key = SigningKey::generate().expect("key");
        key.is_active = true;
        store.insert_signing_key(&key).unwrap();
        let scopes = vec!["system/*.cruds".to_owned(), "openid".to_owned()];
        let entitlement = HostOwnerEntitlement::for_host("host", &scopes);
        let access_token = minter(&store).mint(&entitlement).expect("mint");
        let keys = store.all_signing_keys().unwrap();
        let claims = verify_jwt(
            &access_token,
            &keys,
            &VerifyOptions {
                expected_issuer: "https://issuer.example",
                accepted_audiences: &["https://issuer.example".to_owned()],
            },
        )
        .expect("verifies against the seeded key");
        assert_eq!(claims.subject, "host");
        assert_eq!(claims.scope.as_deref(), Some("system/*.cruds openid"));
        assert_eq!(claims.host_owner, Some(true));
    }
}
