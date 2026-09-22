//! [`TokenVerifier`] — the access-token verification policy both authN gates
//! run: signature and issuer against the stored keys, the accepted audiences
//! for the request's served origin, the canonical-audience rule for the host
//! owner token, and revocation as the last gate. Moved out of the middleware so
//! the policy is a unit-testable domain rule and the middleware only extracts
//! the token, resolves the origin, and maps the outcome to a status.

use std::sync::Arc;

use crate::domain::token::{verify_jwt, VerifiedClaims, VerifyError, VerifyOptions};
use crate::domain::GatekeeperStore;
use crate::ports::RevocationCheck;

/// Verify presented access tokens. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGatekeeperStore`.
pub(crate) struct TokenVerifier<S: GatekeeperStore> {
    store: S,
    revocation: Arc<dyn RevocationCheck>,
}

impl<S: GatekeeperStore> TokenVerifier<S> {
    /// Build the verifier over the store and the revocation-check port, both
    /// lifted from the state.
    pub(crate) fn new(store: S, revocation: Arc<dyn RevocationCheck>) -> Self {
        TokenVerifier { store, revocation }
    }

    /// Verify `token` for `origin`, accepting the per-request served-origin
    /// audiences (`{origin}` and `{origin}/fhir-r4`) plus the canonical
    /// audience — honoured only for the `wf_owner`-marked host owner token,
    /// which is presented at every served origin (#256). See
    /// `docs/Origins/Explanation.md`.
    ///
    /// Revocation is the last gate: the token is cryptographically valid, but
    /// a logout / owner revoke / grant revoke may have denylisted its `jti` or
    /// bumped the subject's epoch since it was minted. Both authN gates funnel
    /// through here, so it runs the *complete* check (per-`jti` denylist **and**
    /// per-subject epoch). A store-read failure fails closed, never admitting
    /// the token.
    ///
    /// # Errors
    ///
    /// [`VerifyError::TokenRejected`] for a bad, expired, wrong-audience, or
    /// non-owner-canonical-audience token; [`VerifyError::Revoked`] for a
    /// revoked one; the server-side variants when the key or revocation store
    /// can't be read.
    pub(crate) fn verify(&self, origin: &str, token: &str) -> Result<VerifiedClaims, VerifyError> {
        let keys = self
            .store
            .all_signing_keys()
            .map_err(VerifyError::KeyStoreUnavailable)?;
        let accepted = vec![
            format!("{origin}/fhir-r4"),
            origin.to_string(),
            shared_structures_rust::CANONICAL_ISSUER.to_string(),
        ];
        let claims = verify_jwt(
            token,
            &keys,
            &VerifyOptions {
                expected_issuer: shared_structures_rust::CANONICAL_ISSUER,
                accepted_audiences: &accepted,
            },
        )?;
        let via_canonical_audience = claims
            .audience
            .iter()
            .any(|aud| aud == shared_structures_rust::CANONICAL_ISSUER);
        if via_canonical_audience && claims.host_owner != Some(true) {
            return Err(VerifyError::TokenRejected);
        }
        let revoked = self
            .revocation
            .is_revoked(claims.jti.as_deref(), claims.issued_at, &claims.subject)
            .map_err(VerifyError::RevocationStoreUnavailable)?;
        if revoked {
            return Err(VerifyError::Revoked);
        }
        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::{DateTime, Duration, Utc};

    use super::*;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::FakeGatekeeperStore;
    use crate::domain::token::{mint_access_token, NewJwtArgs};

    /// A revocation check that answers from a fixed set of revoked `jti`s and
    /// records what it was asked.
    #[derive(Default)]
    struct FakeRevocation {
        revoked_jtis: Vec<String>,
        asked: Mutex<Vec<String>>,
        fail: bool,
    }

    impl RevocationCheck for FakeRevocation {
        fn is_revoked(
            &self,
            jti: Option<&str>,
            _issued_at: Option<DateTime<Utc>>,
            subject: &str,
        ) -> Result<bool, String> {
            self.asked.lock().unwrap().push(subject.to_owned());
            if self.fail {
                return Err("store unavailable".to_owned());
            }
            Ok(jti.is_some_and(|jti| self.revoked_jtis.iter().any(|r| r == jti)))
        }
    }

    const ORIGIN: &str = "http://127.0.0.1";

    fn store_with_key() -> (FakeGatekeeperStore, SigningKey) {
        let store = FakeGatekeeperStore::default();
        let mut key = SigningKey::generate().expect("key");
        key.is_active = true;
        store.insert_signing_key(&key).unwrap();
        (store, key)
    }

    fn mint(key: &SigningKey, audience: &str, is_host_owner: bool) -> String {
        mint_access_token(
            key,
            &NewJwtArgs {
                client_id: "client",
                scope: &["openid".to_owned()],
                ttl: Duration::minutes(5),
                origin: shared_structures_rust::CANONICAL_ISSUER,
                audience: Some(audience),
                patient: None,
                is_host_owner,
            },
        )
        .expect("mint")
    }

    /// A token for this origin's FHIR audience verifies, and the revocation
    /// check is consulted for its subject.
    #[test]
    fn verifies_a_served_origin_token_and_consults_revocation() {
        let (store, key) = store_with_key();
        let revocation = Arc::new(FakeRevocation::default());
        let verifier = TokenVerifier::new(store, revocation.clone());
        let claims = verifier
            .verify(ORIGIN, &mint(&key, &format!("{ORIGIN}/fhir-r4"), false))
            .expect("verifies");
        assert_eq!(claims.subject, "client");
        assert_eq!(*revocation.asked.lock().unwrap(), vec!["client".to_owned()]);
    }

    /// The canonical audience is honoured only for the host owner token: a
    /// non-owner token presenting it is rejected even though its signature is
    /// valid.
    #[test]
    fn canonical_audience_is_owner_only() {
        let (store, key) = store_with_key();
        let verifier = TokenVerifier::new(store, Arc::new(FakeRevocation::default()));
        let canonical = shared_structures_rust::CANONICAL_ISSUER;
        assert!(verifier
            .verify(ORIGIN, &mint(&key, canonical, true))
            .is_ok());
        assert!(matches!(
            verifier.verify(ORIGIN, &mint(&key, canonical, false)),
            Err(VerifyError::TokenRejected)
        ));
    }

    /// Revocation is the last gate: a valid token whose `jti` is denylisted is
    /// `Revoked`, and a revocation-store failure fails closed rather than
    /// admitting the token.
    #[test]
    fn revocation_is_the_last_gate_and_fails_closed() {
        let (store, key) = store_with_key();
        let token = mint(&key, ORIGIN, false);
        let jti = verify_jwt(
            &token,
            &store.all_signing_keys().unwrap(),
            &VerifyOptions {
                expected_issuer: shared_structures_rust::CANONICAL_ISSUER,
                accepted_audiences: &[ORIGIN.to_owned()],
            },
        )
        .unwrap()
        .jti
        .expect("minted tokens carry a jti");

        let revoked = TokenVerifier::new(
            FakeGatekeeperStore::default(),
            Arc::new(FakeRevocation {
                revoked_jtis: vec![jti],
                ..FakeRevocation::default()
            }),
        );
        // Re-seed the key so the revoked verifier can check the signature.
        revoked.store.insert_signing_key(&key).unwrap();
        assert!(matches!(
            revoked.verify(ORIGIN, &token),
            Err(VerifyError::Revoked)
        ));

        let failing = TokenVerifier::new(
            store,
            Arc::new(FakeRevocation {
                fail: true,
                ..FakeRevocation::default()
            }),
        );
        assert!(matches!(
            failing.verify(ORIGIN, &token),
            Err(VerifyError::RevocationStoreUnavailable(_))
        ));
    }
}
