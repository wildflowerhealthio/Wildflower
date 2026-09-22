//! [`AccessTokenMinter`] — the writer that reads the active signing key and
//! mints a JWT. The claims it signs come from a [`MintAuthority`] proof, never
//! from a caller-assembled scope slice, so what a token can be minted *for* is
//! the closed set of proof types in [`crate::domain::authority`].

use chrono::Duration;

use crate::domain::authority::MintAuthority;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::token::{mint_access_token, MintError, NewJwtArgs};
use crate::domain::GatekeeperStore;

/// The per-request framing of a mint: who issues it, for which audience, and
/// for how long. Everything about *what* is minted comes from the proof.
pub(crate) struct MintRequest<'a> {
    /// The `iss` claim.
    pub(crate) issuer: &'a str,
    /// The `aud` claim.
    pub(crate) audience: &'a str,
    pub(crate) ttl: Duration,
}

/// A freshly minted, signed access token.
pub(crate) struct IssuedAccessToken {
    pub(crate) access_token: String,
}

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

/// Mint access tokens. A borrowed view over the store; the gate is the
/// [`MintAuthority`] proof [`mint`](Self::mint) takes.
pub(crate) struct AccessTokenMinter<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> AccessTokenMinter<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        AccessTokenMinter { store }
    }

    /// Sign a token carrying exactly the proof's client, scopes, patient, and
    /// owner marker, framed by `request`.
    ///
    /// # Errors
    ///
    /// [`TokenIssuanceError::NoActiveSigningKey`] when no key can sign;
    /// [`TokenIssuanceError::Signing`] on a key-material or encoding failure;
    /// [`TokenIssuanceError::Store`] when the key store can't be read.
    pub(crate) fn mint(
        &self,
        authority: &impl MintAuthority,
        request: &MintRequest<'_>,
    ) -> Result<IssuedAccessToken, TokenIssuanceError> {
        let key = self
            .store
            .active_signing_key()?
            .ok_or(TokenIssuanceError::NoActiveSigningKey)?;
        let access_token = mint_access_token(
            &key,
            &NewJwtArgs {
                client_id: authority.client_id(),
                scope: authority.scopes(),
                ttl: request.ttl,
                origin: request.issuer,
                audience: Some(request.audience),
                patient: authority.patient(),
                is_host_owner: authority.is_host_owner(),
            },
        )?;
        Ok(IssuedAccessToken { access_token })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authority::HostBootstrap;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::FakeGatekeeperStore;
    use crate::domain::token::{verify_jwt, VerifyOptions};

    fn request() -> MintRequest<'static> {
        MintRequest {
            issuer: "https://issuer.example",
            audience: "https://issuer.example",
            ttl: Duration::minutes(5),
        }
    }

    /// With no signing key seeded, minting fails closed rather than producing an
    /// unsigned or differently-signed token.
    #[test]
    fn mint_fails_closed_without_an_active_key() {
        let store = FakeGatekeeperStore::default();
        let authority = HostBootstrap::for_host("host", &["openid".to_owned()]);
        let outcome = AccessTokenMinter::over(&store).mint(&authority, &request());
        assert!(matches!(
            outcome,
            Err(TokenIssuanceError::NoActiveSigningKey)
        ));
    }

    /// The minted token carries exactly the proof's claims — client, scopes, the
    /// owner marker — and verifies against the seeded key.
    #[test]
    fn mint_signs_exactly_the_proofs_claims() {
        let store = FakeGatekeeperStore::default();
        let mut key = SigningKey::generate().expect("key");
        key.is_active = true;
        store.insert_signing_key(&key).unwrap();
        let scopes = vec!["system/*.cruds".to_owned(), "openid".to_owned()];
        let authority = HostBootstrap::for_host("host", &scopes);
        let issued = AccessTokenMinter::over(&store)
            .mint(&authority, &request())
            .expect("mint");
        let keys = store.all_signing_keys().unwrap();
        let claims = verify_jwt(
            &issued.access_token,
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
