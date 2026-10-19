//! [`AccessTokenMinter`] — the writer that reads the active signing key and
//! mints a JWT. What a token claims (client, scopes, patient) comes from a
//! [`TokenEntitlement`] proof, never from a caller-assembled scope slice, so
//! what a token can be minted *for* is that enum's closed set of variants. Where
//! the token is valid (the server's origin, its `iss` and `aud` both) and for
//! how long are fixed when the minter is built.

use chrono::Duration;

use crate::domain::authority::TokenEntitlement;
use crate::domain::grant_store::SigningKeysTx;
use crate::domain::signing_key::SigningKey;
use crate::domain::token::{mint_access_token, NewJwtArgs, TokenIssuanceError};

/// Mint access tokens for one server with the signing key that was active
/// when the minter was loaded; the gate is the [`TokenEntitlement`] proof
/// [`mint`](Self::mint) takes. Loaded inside the caller's scope (reading the
/// key's private material is the privileged read) and used after it closes,
/// so the signing itself holds no lock.
pub(crate) struct AccessTokenMinter<'a> {
    signing_key: SigningKey,
    /// The server's bare origin: both the `iss` and the `aud` claim.
    server_origin: &'a str,
    ttl: Duration,
}

impl<'a> AccessTokenMinter<'a> {
    /// A minter holding `tx`'s active signing key, minting tokens issued by
    /// and for `server_origin` that live for `ttl`.
    ///
    /// # Errors
    ///
    /// [`TokenIssuanceError::NoActiveSigningKey`] when no key can sign;
    /// [`TokenIssuanceError::Store`] when the key store can't be read.
    pub(crate) fn with_active_key(
        tx: &mut impl SigningKeysTx,
        server_origin: &'a str,
        ttl: Duration,
    ) -> Result<Self, TokenIssuanceError> {
        let signing_key = tx
            .active_signing_key()?
            .ok_or(TokenIssuanceError::NoActiveSigningKey)?;
        Ok(AccessTokenMinter {
            signing_key,
            server_origin,
            ttl,
        })
    }

    /// Sign a token carrying exactly the entitlement's client, scopes,
    /// patient and browser session, and return it.
    ///
    /// # Errors
    ///
    /// [`TokenIssuanceError::Signing`] on a key-material or encoding failure.
    pub(crate) fn mint(
        &self,
        entitlement: TokenEntitlement<'_>,
    ) -> Result<String, TokenIssuanceError> {
        Ok(mint_access_token(
            &self.signing_key,
            &NewJwtArgs {
                client_id: entitlement.client_id(),
                scopes: entitlement.token_scopes(),
                ttl: self.ttl,
                issuer: self.server_origin,
                audience: Some(self.server_origin),
                patient: entitlement.patient(),
                sid: entitlement.sid(),
            },
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::domain::test_fake::{redeemed_code, seed_active_signing_key, FakeGrantStore};
    use crate::domain::token::{verify_jwt, VerifyOptions};

    fn minter(store: &FakeGrantStore) -> Result<AccessTokenMinter<'static>, TokenIssuanceError> {
        AccessTokenMinter::with_active_key(
            &mut store.tx(),
            "https://server.example",
            Duration::minutes(5),
        )
    }

    /// With no signing key seeded, loading the minter fails closed, so nothing
    /// can be minted, unsigned or differently signed.
    #[test]
    fn mint_fails_closed_without_an_active_key() {
        let store = FakeGrantStore::default();
        assert!(matches!(
            minter(&store),
            Err(TokenIssuanceError::NoActiveSigningKey)
        ));
    }

    /// The minted token carries exactly the entitlement's claims — client,
    /// scopes and patient — names the server's origin as both `iss` and `aud`,
    /// and verifies against the seeded key.
    #[test]
    fn mint_signs_exactly_the_proofs_claims() {
        let store = FakeGrantStore::default();
        seed_active_signing_key(&store);
        let redeemed = redeemed_code(&store, "client-a", &["patient/Patient.rs", "openid"]);
        let access_token = minter(&store)
            .expect("an active key")
            .mint(TokenEntitlement::AuthorizationCode(&redeemed))
            .expect("mint");
        let keys = store.tx().all_signing_keys().unwrap();
        let claims = verify_jwt(
            &access_token,
            &keys,
            &VerifyOptions {
                expected_issuer: "https://server.example",
                accepted_audiences: &["https://server.example".to_owned()],
            },
        )
        .expect("verifies against the seeded key");
        assert_eq!(claims.subject, "client-a");
        assert_eq!(claims.scope, Some(redeemed.token_scopes().join(" ")));
        assert_eq!(claims.patient.as_deref(), Some("pat-1"));
        assert_eq!(claims.issuer, "https://server.example");
        assert_eq!(claims.audience, vec!["https://server.example".to_owned()]);
    }
}
