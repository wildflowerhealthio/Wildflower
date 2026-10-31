//! [`TokenVerifier`] — the access-token verification policy both authN gates
//! run: signature against the stored keys, `iss` and `aud` against this
//! server's origin, and revocation, by the token itself, its subject or its
//! browser session, as the last gate. The middleware only
//! extracts the token and maps the outcome to a status.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::domain::access_token::{
    verify_access_token, AccessTokenVerifyError, AccessTokenVerifyOptions, VerifiedClaims,
};
use crate::domain::browser_session::StaleSessionCutoff;
use crate::domain::grant_store::{BrowserSessionsTx, SigningKeysTx};
use crate::domain::GrantStore;
use crate::ports::RevocationCheck;
use crate::BROWSER_SESSION_CLIENT_ID;

/// Verify presented access tokens. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct TokenVerifier<S: GrantStore> {
    /// The grant store, holding the signing keys a token must be signed with
    /// and the browser sessions a token's `sid` may name.
    store: S,
    /// The host's revocation check: the per-`jti` denylist and the per-subject
    /// epoch, kept outside the grant store.
    revocation: Arc<dyn RevocationCheck>,
    /// The server's bare origin: the one `iss` and the one `aud` accepted, so
    /// a token another server minted is refused by these alone.
    server_origin: Arc<str>,
    /// The cutoff before which a same-device session is stale: a browser
    /// session's own token needs its session live under it.
    stale_session_cutoff: Arc<StaleSessionCutoff>,
}

impl<S: GrantStore> TokenVerifier<S> {
    /// Build the verifier over the store, the revocation-check port, the
    /// server's origin, and the stale-session cutoff, all lifted from the
    /// state.
    pub(crate) fn new(
        store: S,
        revocation: Arc<dyn RevocationCheck>,
        server_origin: Arc<str>,
        stale_session_cutoff: Arc<StaleSessionCutoff>,
    ) -> Self {
        TokenVerifier {
            store,
            revocation,
            server_origin,
            stale_session_cutoff,
        }
    }

    /// Verify `token`: its `iss` and `aud` must both be this server's origin,
    /// so a token another server minted is refused by construction. See
    /// `docs/Origins/Explanation.md`.
    ///
    /// Revocation is the last gate: the token is cryptographically valid, but
    /// a logout / owner revoke / grant revoke may have denylisted its `jti` or
    /// bumped the subject's epoch since it was minted, or revoked the browser
    /// session its `sid` names. A `sid` that names no session row reads as
    /// revoked, so a token naming a session the server never had is refused
    /// too. A browser session's own token is also refused once the session
    /// is no longer [live](crate::domain::browser_session::BrowserSession::is_live_at),
    /// which can be before the token expires. Both authN gates, the browser-session cookie checks, and through
    /// [`InProcessTokenVerifier`](crate::InProcessTokenVerifier) the FHIR
    /// server, funnel through here, so it runs the *complete* check (per-`jti`
    /// denylist, per-subject epoch **and** browser session). A token with no
    /// `sid` has no session to check. Every store failure fails closed, never
    /// admitting the token, and the gates answer it with a `500`, not a `401`.
    ///
    /// # Errors
    ///
    /// [`AccessTokenVerifyError::TokenRejected`] for a bad, expired, wrong-issuer or
    /// wrong-audience token, or a browser session's own token once the
    /// session is no longer live;
    /// [`AccessTokenVerifyError::Revoked`] for a revoked one; the server-side
    /// variants when the key, revocation or browser-session store can't be
    /// read.
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
    /// has no row, or, for the session's own token, is no longer live.
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
            if claims.subject == BROWSER_SESSION_CLIENT_ID {
                ensure_own_session_live(tx, sid, &self.stale_session_cutoff, Utc::now())?;
            } else if tx
                .is_browser_session_revoked(sid)
                .map_err(AccessTokenVerifyError::BrowserSessionStoreUnavailable)?
            {
                return Err(AccessTokenVerifyError::Revoked);
            }
        }
        Ok(claims)
    }
}

/// Refuse a browser session's own token, the one its cookie holds, once the
/// session `sid` is no longer live at `now` under `stale_session_cutoff`:
/// `Revoked` when the session is revoked or has no row, `TokenRejected` when
/// it is otherwise not live. A session can end before its token does: the host
/// ends a same-device session by expiring it, and the cutoff makes one stale.
/// The tokens apps were issued under the session outlive its ending, and only
/// its revocation ends them.
fn ensure_own_session_live(
    tx: &mut impl BrowserSessionsTx,
    sid: &str,
    stale_session_cutoff: &StaleSessionCutoff,
    now: DateTime<Utc>,
) -> Result<(), AccessTokenVerifyError> {
    let session = tx
        .browser_session_by_sid(sid)
        .map_err(AccessTokenVerifyError::BrowserSessionStoreUnavailable)?;
    match session {
        None => Err(AccessTokenVerifyError::Revoked),
        Some(session) if session.revoked_at.is_some() => Err(AccessTokenVerifyError::Revoked),
        Some(session) if !session.is_live_at(now, stale_session_cutoff) => {
            Err(AccessTokenVerifyError::TokenRejected)
        }
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use std::collections::HashSet;
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
        /// The `jti`s answered as revoked.
        revoked_jtis: Vec<String>,
        /// Each subject the check was asked about, in call order.
        asked: Mutex<Vec<String>>,
        /// Whether every check fails, as an unreachable revocation store does.
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

    /// A fake store seeded with one active signing key, and that key.
    fn store_with_key() -> (FakeGrantStore, SigningKey) {
        let store = FakeGrantStore::default();
        let key = seed_active_signing_key(&store);
        (store, key)
    }

    /// A verifier for [`ORIGIN`] over `store`, with nothing revoked.
    fn verifier(store: FakeGrantStore) -> TokenVerifier<FakeGrantStore> {
        TokenVerifier::new(
            store,
            Arc::new(FakeRevocation::default()),
            ORIGIN.into(),
            Arc::new(StaleSessionCutoff::none()),
        )
    }

    /// A five-minute token for `client` signed with `key`, naming `issuer`
    /// and `audience`, under no browser session.
    fn mint(key: &SigningKey, issuer: &str, audience: &str) -> String {
        mint_under_session(key, issuer, audience, None)
    }

    /// A five-minute token for `client` signed with `key`, naming `issuer`
    /// and `audience`, under the browser session `sid` or none.
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
        let verifier = TokenVerifier::new(
            store,
            revocation.clone(),
            ORIGIN.into(),
            Arc::new(StaleSessionCutoff::none()),
        );
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
            Arc::new(StaleSessionCutoff::none()),
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
            Arc::new(StaleSessionCutoff::none()),
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

    /// A browser session's own token is refused once its session expires,
    /// before the token does, and once it is revoked; an app's token minted
    /// under the session outlives the session's expiry, not its revocation.
    #[test]
    fn a_session_s_own_token_ends_with_the_session_s_expiry() {
        let (store, key) = store_with_key();
        let now = Utc::now();
        let session = BrowserSession::new_same_device_session(vec![], Duration::hours(8), now);
        store.tx().insert_browser_session(&session).expect("insert");
        let session_s_own = mint_access_token(
            &key,
            &NewAccessTokenArgs {
                client_id: BROWSER_SESSION_CLIENT_ID,
                scopes: &["openid".to_owned()],
                ttl: Duration::hours(8),
                issuer: ORIGIN,
                audience: Some(ORIGIN),
                patient: None,
                sid: Some(&session.sid),
            },
        )
        .expect("mint");
        let app_s = mint_under_session(&key, ORIGIN, ORIGIN, Some(&session.sid));
        let verifier = verifier(store);
        assert!(verifier.verify(&session_s_own).is_ok());

        assert!(verifier
            .store
            .tx()
            .expire_browser_session(&session.sid, Utc::now())
            .expect("expire"));
        assert!(matches!(
            verifier.verify(&session_s_own),
            Err(AccessTokenVerifyError::TokenRejected)
        ));
        assert!(verifier.verify(&app_s).is_ok());

        assert!(verifier
            .store
            .tx()
            .revoke_browser_session(&session.sid, Utc::now())
            .expect("revoke"));
        assert!(matches!(
            verifier.verify(&session_s_own),
            Err(AccessTokenVerifyError::Revoked)
        ));
        assert!(matches!(
            verifier.verify(&app_s),
            Err(AccessTokenVerifyError::Revoked)
        ));
    }

    /// A same-device session's own token is refused once a cutoff after the
    /// session's start makes it stale, though its row stands; an app's token
    /// minted under it outlives that, as it does the session's expiry.
    #[test]
    fn a_session_s_own_token_ends_when_the_session_is_stale() {
        let (store, key) = store_with_key();
        let session =
            BrowserSession::new_same_device_session(vec![], Duration::hours(8), Utc::now());
        store.tx().insert_browser_session(&session).expect("insert");
        let session_s_own = mint_access_token(
            &key,
            &NewAccessTokenArgs {
                client_id: BROWSER_SESSION_CLIENT_ID,
                scopes: &["openid".to_owned()],
                ttl: Duration::hours(8),
                issuer: ORIGIN,
                audience: Some(ORIGIN),
                patient: None,
                sid: Some(&session.sid),
            },
        )
        .expect("mint");
        let app_s = mint_under_session(&key, ORIGIN, ORIGIN, Some(&session.sid));
        let cut_off = TokenVerifier::new(
            store,
            Arc::new(FakeRevocation::default()),
            ORIGIN.into(),
            Arc::new(StaleSessionCutoff::new(
                Utc::now() + Duration::seconds(1),
                HashSet::new(),
            )),
        );

        assert!(matches!(
            cut_off.verify(&session_s_own),
            Err(AccessTokenVerifyError::TokenRejected)
        ));
        assert!(cut_off.verify(&app_s).is_ok());
    }
}
