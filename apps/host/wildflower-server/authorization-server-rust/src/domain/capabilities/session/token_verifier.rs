//! [`TokenVerifier`] — the access-token verification policy both authN gates
//! run: signature against the stored keys, `iss` and `aud` against this
//! server's origin, and revocation, by the token itself, its subject or its
//! browser session, as the last gate. The middleware only
//! extracts the token and maps the outcome to a status.

use std::sync::Arc;

use crate::domain::access_token::{
    verify_access_token, AccessTokenVerifyError, AccessTokenVerifyOptions, VerifiedClaims,
};
use crate::domain::grant_store::{BrowserSessionsTx, SigningKeysTx};
use crate::domain::GrantStore;
use crate::ports::RevocationCheck;

/// Verify presented access tokens. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct TokenVerifier<S: GrantStore> {
    store: S,
    revocation: Arc<dyn RevocationCheck>,
    /// The server's bare origin: the one `iss` and the one `aud` accepted.
    server_origin: Arc<str>,
}

impl<S: GrantStore> TokenVerifier<S> {
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

    /// Verify `token`: its `iss` and `aud` must both be this server's origin,
    /// so a token another server minted is refused by construction. See
    /// `docs/Origins/Explanation.md`.
    ///
    /// Revocation is the last gate: the token is cryptographically valid, but
    /// a logout / owner revoke / grant revoke may have denylisted its `jti` or
    /// bumped the subject's epoch since it was minted, or revoked the browser
    /// session its `sid` names. Both authN gates, and through
    /// [`InProcessTokenVerifier`](crate::InProcessTokenVerifier) the FHIR
    /// server, funnel through here, so it runs the *complete* check (per-`jti`
    /// denylist, per-subject epoch **and** browser session). A token with no
    /// `sid` has no session to check. A store-read failure fails closed, never
    /// admitting the token.
    ///
    /// # Errors
    ///
    /// [`AccessTokenVerifyError::TokenRejected`] for a bad, expired, wrong-issuer or
    /// wrong-audience token; [`AccessTokenVerifyError::Revoked`] for a revoked one; the
    /// server-side variants when the key, revocation or browser-session store
    /// can't be read.
    pub(crate) fn verify(&self, token: &str) -> Result<VerifiedClaims, AccessTokenVerifyError> {
        // A connection that can't be checked out at all fails like the key
        // read that is the scope's first statement.
        let claims = self
            .store
            .read(|tx| Ok(self.verify_signed_and_session_live(tx, token)))
            .map_err(AccessTokenVerifyError::KeyStoreUnavailable)??;
        let revoked = self
            .revocation
            .is_revoked(claims.jti.as_deref(), claims.issued_at, &claims.subject)
            .map_err(AccessTokenVerifyError::RevocationStoreUnavailable)?;
        if revoked {
            return Err(AccessTokenVerifyError::Revoked);
        }
        Ok(claims)
    }

    /// Verify `token`'s signature, `iss` and `aud` against the keys in `tx`,
    /// and refuse it when the browser session its `sid` names is revoked or
    /// has no row.
    fn verify_signed_and_session_live(
        &self,
        tx: &mut (impl SigningKeysTx + BrowserSessionsTx),
        token: &str,
    ) -> Result<VerifiedClaims, AccessTokenVerifyError> {
        let keys = tx
            .all_signing_keys()
            .map_err(AccessTokenVerifyError::KeyStoreUnavailable)?;
        let claims = verify_access_token(
            token,
            &keys,
            &AccessTokenVerifyOptions {
                expected_issuer: &self.server_origin,
                accepted_audiences: &[self.server_origin.to_string()],
            },
        )?;
        if let Some(sid) = claims.sid.as_deref() {
            if tx
                .is_browser_session_revoked(sid)
                .map_err(AccessTokenVerifyError::BrowserSessionStoreUnavailable)?
            {
                return Err(AccessTokenVerifyError::Revoked);
            }
        }
        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use std::sync::Mutex;

    use chrono::{DateTime, Duration, Utc};

    use super::*;
    use crate::domain::access_token::{mint_access_token, NewAccessTokenArgs};
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::{seed_active_signing_key, FakeGrantStore};

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

    fn store_with_key() -> (FakeGrantStore, SigningKey) {
        let store = FakeGrantStore::default();
        let key = seed_active_signing_key(&store);
        (store, key)
    }

    fn verifier(store: FakeGrantStore) -> TokenVerifier<FakeGrantStore> {
        TokenVerifier::new(store, Arc::new(FakeRevocation::default()), ORIGIN.into())
    }

    fn mint(key: &SigningKey, issuer: &str, audience: &str) -> String {
        mint_under_session(key, issuer, audience, None)
    }

    fn mint_under_session(
        key: &SigningKey,
        issuer: &str,
        audience: &str,
        sid: Option<&str>,
    ) -> String {
        mint_access_token(
            key,
            &NewAccessTokenArgs {
                client_id: "client",
                scopes: &["openid".to_owned()],
                ttl: Duration::minutes(5),
                issuer,
                audience: Some(audience),
                patient: None,
                sid,
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
                    Err(AccessTokenVerifyError::TokenRejected)
                ),
                "iss {issuer}, aud {audience} must be rejected"
            );
        }
    }

    /// `aud` must be the bare origin: a path under it is refused.
    #[test]
    fn rejects_a_path_under_the_origin_as_audience() {
        let (store, key) = store_with_key();
        let verifier = verifier(store);
        assert!(matches!(
            verifier.verify(&mint(&key, ORIGIN, &format!("{ORIGIN}/fhir-r4"))),
            Err(AccessTokenVerifyError::TokenRejected)
        ));
    }

    /// Revocation is the last gate: a valid token whose `jti` is denylisted is
    /// `Revoked`, and a revocation-store failure fails closed rather than
    /// admitting the token.
    #[test]
    fn revocation_is_the_last_gate_and_fails_closed() {
        let (store, key) = store_with_key();
        let token = mint(&key, ORIGIN, ORIGIN);
        let jti = verify_access_token(
            &token,
            &store.tx().all_signing_keys().unwrap(),
            &AccessTokenVerifyOptions {
                expected_issuer: ORIGIN,
                accepted_audiences: &[ORIGIN.to_owned()],
            },
        )
        .unwrap()
        .jti
        .expect("minted tokens carry a jti");

        let revoked = TokenVerifier::new(
            FakeGrantStore::default(),
            Arc::new(FakeRevocation {
                revoked_jtis: vec![jti],
                ..FakeRevocation::default()
            }),
            ORIGIN.into(),
        );
        // Re-seed the key so the revoked verifier can check the signature.
        revoked.store.tx().insert_signing_key(&key).unwrap();
        assert!(matches!(
            revoked.verify(&token),
            Err(AccessTokenVerifyError::Revoked)
        ));

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
            Err(AccessTokenVerifyError::RevocationStoreUnavailable(_))
        ));
    }

    /// A token minted under a browser session verifies while the session
    /// stands, and is `Revoked` once it is revoked or when its `sid` names no
    /// session; a token with no `sid` has no session to check.
    #[test]
    fn a_token_is_revoked_with_its_browser_session() {
        let (store, key) = store_with_key();
        let now = Utc::now();
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&session).expect("insert");
        let under_session = mint_under_session(&key, ORIGIN, ORIGIN, Some(&session.sid));
        let under_no_session = mint(&key, ORIGIN, ORIGIN);
        let under_a_missing_session = mint_under_session(&key, ORIGIN, ORIGIN, Some("no-such-sid"));
        let verifier = verifier(store);

        let claims = verifier.verify(&under_session).expect("verifies");
        assert_eq!(claims.sid.as_deref(), Some(session.sid.as_str()));
        assert!(matches!(
            verifier.verify(&under_a_missing_session),
            Err(AccessTokenVerifyError::Revoked)
        ));

        assert!(verifier
            .store
            .tx()
            .revoke_browser_session(&session.sid, now)
            .expect("revoke"));
        assert!(matches!(
            verifier.verify(&under_session),
            Err(AccessTokenVerifyError::Revoked)
        ));
        assert!(verifier.verify(&under_no_session).is_ok());
    }
}
