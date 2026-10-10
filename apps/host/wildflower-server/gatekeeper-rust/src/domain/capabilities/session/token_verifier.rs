//! [`TokenVerifier`] — the access-token verification policy both authN gates
//! run: signature against the stored keys, `iss` and `aud` against this
//! server's origin, and revocation as the last gate. The middleware only
//! extracts the token and maps the outcome to a status.

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
    /// The server's bare origin: the one `iss` and the one `aud` accepted.
    server_origin: Arc<str>,
}

impl<S: GatekeeperStore> TokenVerifier<S> {
    /// Build the verifier over the store, the revocation-check port, and the
    /// server's origin, all lifted from the state.
    pub(crate) fn new(
        store: S,
        revocation: Arc<dyn RevocationCheck>,
        server_origin: Arc<str>,
    ) -> Self {
        TokenVerifier {
            store,
            revocation,
            server_origin,
        }
    }

    /// Verify `token`: its `iss` and `aud` must both be this server's origin.
    /// The origin the request was served on plays no part, so a token for this
    /// server is accepted over loopback and through the tunnel alike, and a
    /// token another server minted is refused by construction. See
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
    /// [`VerifyError::TokenRejected`] for a bad, expired, wrong-issuer or
    /// wrong-audience token; [`VerifyError::Revoked`] for a revoked one; the
    /// server-side variants when the key or revocation store can't be read.
    pub(crate) fn verify(&self, token: &str) -> Result<VerifiedClaims, VerifyError> {
        let keys = self
            .store
            .all_signing_keys()
            .map_err(VerifyError::KeyStoreUnavailable)?;
        let claims = verify_jwt(
            token,
            &keys,
            &VerifyOptions {
                expected_issuer: &self.server_origin,
                accepted_audiences: &[self.server_origin.to_string()],
            },
        )?;
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
    use crate::domain::test_fake::{seed_active_signing_key, FakeGatekeeperStore};
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

    /// This server's origin.
    const ORIGIN: &str = "https://ruth.relay.example";
    /// Another server's origin.
    const OTHER_ORIGIN: &str = "https://lab.relay.example";

    fn store_with_key() -> (FakeGatekeeperStore, SigningKey) {
        let store = FakeGatekeeperStore::default();
        let key = seed_active_signing_key(&store);
        (store, key)
    }

    fn verifier(store: FakeGatekeeperStore) -> TokenVerifier<FakeGatekeeperStore> {
        TokenVerifier::new(store, Arc::new(FakeRevocation::default()), ORIGIN.into())
    }

    fn mint(key: &SigningKey, issuer: &str, audience: &str) -> String {
        mint_access_token(
            key,
            &NewJwtArgs {
                client_id: "client",
                scopes: &["openid".to_owned()],
                ttl: Duration::minutes(5),
                issuer,
                audience: Some(audience),
                patient: None,
            },
        )
        .expect("mint")
    }

    /// A token whose `iss` and `aud` are this server's origin verifies, and the
    /// revocation check is consulted for its subject.
    #[test]
    fn verifies_a_token_for_this_server_and_consults_revocation() {
        let (store, key) = store_with_key();
        let revocation = Arc::new(FakeRevocation::default());
        let verifier = TokenVerifier::new(store, revocation.clone(), ORIGIN.into());
        let claims = verifier
            .verify(&mint(&key, ORIGIN, ORIGIN))
            .expect("verifies");
        assert_eq!(claims.subject, "client");
        assert_eq!(*revocation.asked.lock().unwrap(), vec!["client".to_owned()]);
    }

    /// A token another server minted is refused, even signed with a key this
    /// server holds, and so is one naming another server as only its issuer or
    /// only its audience.
    #[test]
    fn rejects_a_token_for_another_server() {
        let (store, key) = store_with_key();
        let verifier = verifier(store);
        for (issuer, audience) in [
            (OTHER_ORIGIN, OTHER_ORIGIN),
            (OTHER_ORIGIN, ORIGIN),
            (ORIGIN, OTHER_ORIGIN),
        ] {
            assert!(
                matches!(
                    verifier.verify(&mint(&key, issuer, audience)),
                    Err(VerifyError::TokenRejected)
                ),
                "iss {issuer}, aud {audience} must be rejected"
            );
        }
    }

    /// `aud` must be the bare origin: the FHIR base under it is refused.
    #[test]
    fn rejects_the_fhir_base_as_audience() {
        let (store, key) = store_with_key();
        let verifier = verifier(store);
        assert!(matches!(
            verifier.verify(&mint(&key, ORIGIN, &format!("{ORIGIN}/fhir-r4"))),
            Err(VerifyError::TokenRejected)
        ));
    }

    /// Revocation is the last gate: a valid token whose `jti` is denylisted is
    /// `Revoked`, and a revocation-store failure fails closed rather than
    /// admitting the token.
    #[test]
    fn revocation_is_the_last_gate_and_fails_closed() {
        let (store, key) = store_with_key();
        let token = mint(&key, ORIGIN, ORIGIN);
        let jti = verify_jwt(
            &token,
            &store.all_signing_keys().unwrap(),
            &VerifyOptions {
                expected_issuer: ORIGIN,
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
            ORIGIN.into(),
        );
        // Re-seed the key so the revoked verifier can check the signature.
        revoked.store.insert_signing_key(&key).unwrap();
        assert!(matches!(revoked.verify(&token), Err(VerifyError::Revoked)));

        let failing = TokenVerifier::new(
            store,
            Arc::new(FakeRevocation {
                fail: true,
                ..FakeRevocation::default()
            }),
            ORIGIN.into(),
        );
        assert!(matches!(
            failing.verify(&token),
            Err(VerifyError::RevocationStoreUnavailable(_))
        ));
    }
}
