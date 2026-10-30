//! [`SameDeviceSignIn`] — `GET /oauth/sign-in`: redeem a one-time same-device sign-in code the
//! base minted in-process for a same-device session's token, and say where the
//! browser goes next. It reads top to bottom as: check `next` against the
//! allow-list and check the browser-session client isn't disabled (both before
//! the code is touched), redeem the code for its
//! [`RedeemedSameDeviceSignInCode`] proof, store the same-device session it
//! starts, mint under it.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::access_token::AccessTokenIssuanceError;
use crate::domain::authority::{RedeemedSameDeviceSignInCode, TokenEntitlement};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{AccessTokenMinter, BrowserSessionWriter};
use crate::domain::grant_store::ClientsTx;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::sign_in_redirect::{SignInDestinations, SignInRedirect};
use crate::domain::GrantStore;
use crate::BROWSER_SESSION_CLIENT_ID;

/// How long a same-device session's token lives: a working day, after which the
/// base signs the browser in again.
pub(crate) const SAME_DEVICE_SESSION_TTL: Duration = Duration::hours(8);

/// What a successful sign-in yields: the browser session's token, and where
/// the browser goes next.
pub(crate) struct SignedIn {
    /// The session's token, which the browser holds as its
    /// `__Host-browser_session` cookie.
    pub(crate) session_token: String,
    /// Where the browser goes next.
    pub(crate) redirect: SignInRedirect,
}

/// Why a sign-in issued nothing.
#[derive(Debug)]
pub(crate) enum SameDeviceSignInError {
    /// The request was refused: the browser is told why, on a page.
    Refused(SignInRefusal),
    /// The store couldn't be read or written, or the browser-session client's
    /// row is missing though it is seeded at boot.
    Store(AuthorizationServerError),
    /// The same-device session couldn't be stored. The code is spent.
    SessionNotStored(AuthorizationServerError),
    /// The token couldn't be minted (no signing key, a signing or store
    /// failure). The session was rolled back with it; the code, held in
    /// memory, is spent.
    Issuance(AccessTokenIssuanceError),
}

/// A sign-in request the server refuses, rendered as a local page with no
/// redirect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignInRefusal {
    /// `next` is none of the places a sign-in may send a browser.
    RedirectNotAllowed,
    /// The code is unknown, already redeemed, expired, or withdrawn as the
    /// view it was opened in closed.
    CodeNotRedeemable,
    /// The browser-session client, which every browser session's token is
    /// issued to, is disabled.
    BrowserSessionClientDisabled,
}

/// Sign a browser in as the Owner. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct SameDeviceSignIn<S: GrantStore> {
    /// The store the session is stored in and the browser-session client is
    /// checked in.
    store: S,
    /// The outstanding one-time sign-in codes the base minted, held in
    /// memory; redeeming one spends it.
    codes: Arc<SameDeviceSignInCodes>,
    /// Where a sign-in may send a browser on to; `next` must be one of them.
    destinations: Arc<SignInDestinations>,
    /// The server's bare origin, the token's `iss` and `aud`.
    server_origin: Arc<str>,
    /// The Owner's grant, [`OWNER_SCOPES`](crate::OWNER_SCOPES).
    owner_grant: Grant,
}

impl<S: GrantStore> SameDeviceSignIn<S> {
    /// Build the sign-in over the handles lifted from the state.
    pub(crate) fn new(
        store: S,
        codes: Arc<SameDeviceSignInCodes>,
        destinations: Arc<SignInDestinations>,
        server_origin: Arc<str>,
        owner_grant: Grant,
    ) -> Self {
        SameDeviceSignIn {
            store,
            codes,
            destinations,
            server_origin,
            owner_grant,
        }
    }

    /// Redeem `presented_code` at `now` for a same-device session and its
    /// token, both lasting [`SAME_DEVICE_SESSION_TTL`], to go on to `next`.
    /// A `next` that isn't allowed, or a disabled browser-session client, is
    /// refused before the code is touched, so the code stays redeemable. The
    /// session is stored and its token signed in one write scope, which
    /// also has the codes remember the session by the code before it
    /// commits, so the base can end it once the view it opened closes, and
    /// no session lands that its code doesn't find. A code the base withdrew
    /// before then, as its view closed, signs nobody in: the scope rolls
    /// back, and the token is never handed out. A failure after this call
    /// takes the code spends it: the code leaves memory even when the scope
    /// rolls back, so signing in again takes a new code. A failure before
    /// then leaves the code as it stood, so a second presentation of a code
    /// mid-sign-in can't clear its withdrawal.
    ///
    /// # Errors
    ///
    /// [`SameDeviceSignInError::Refused`] for a `next` that isn't allowed
    /// ([`SignInRefusal::RedirectNotAllowed`]), a disabled browser-session client
    /// ([`SignInRefusal::BrowserSessionClientDisabled`]), or a code that is
    /// unknown, spent, expired or withdrawn
    /// ([`SignInRefusal::CodeNotRedeemable`]);
    /// [`SameDeviceSignInError::Store`] when the browser-session client can't be
    /// read; [`SameDeviceSignInError::SessionNotStored`] when the session
    /// can't be stored; [`SameDeviceSignInError::Issuance`] when minting fails.
    pub(crate) fn sign_in(
        &self,
        presented_code: &str,
        next: &str,
        now: DateTime<Utc>,
    ) -> Result<SignedIn, SameDeviceSignInError> {
        let redirect = self
            .destinations
            .allow(next)
            .ok_or(SameDeviceSignInError::Refused(
                SignInRefusal::RedirectNotAllowed,
            ))?;
        let mut code_taken = false;
        let stored = self.store.write(|tx| {
            if is_browser_session_client_disabled(tx)? {
                return Err(SameDeviceSignInError::Refused(
                    SignInRefusal::BrowserSessionClientDisabled,
                ));
            }
            let redeemed_sign_in_code = RedeemedSameDeviceSignInCode::redeem(
                &self.codes,
                presented_code,
                &self.owner_grant,
                SAME_DEVICE_SESSION_TTL,
                now,
            )
            .ok_or(SameDeviceSignInError::Refused(
                SignInRefusal::CodeNotRedeemable,
            ))?;
            code_taken = true;
            BrowserSessionWriter::within(tx)
                .start_same_device_session(&redeemed_sign_in_code)
                .map_err(SameDeviceSignInError::SessionNotStored)?;
            let session_token = AccessTokenMinter::with_active_key(
                tx,
                &self.server_origin,
                SAME_DEVICE_SESSION_TTL,
            )
            .and_then(|minter| {
                minter.mint(TokenEntitlement::SameDeviceSignIn(&redeemed_sign_in_code))
            })
            .map_err(SameDeviceSignInError::Issuance)?;
            if !self
                .codes
                .session_stored(presented_code, redeemed_sign_in_code.session())
            {
                return Err(SameDeviceSignInError::Refused(
                    SignInRefusal::CodeNotRedeemable,
                ));
            }
            Ok(session_token)
        });
        let session_token = match stored {
            Ok(session_token) => session_token,
            Err(error) => {
                if code_taken {
                    self.codes.session_not_stored(presented_code);
                }
                return Err(error);
            }
        };
        Ok(SignedIn {
            session_token,
            redirect,
        })
    }
}

/// Whether the browser-session client is disabled. It is an essential
/// client, which the Owner can't disable, so only a row disabled out of
/// band (direct SQL) is. Its row is seeded at boot, so a missing one is an
/// error, not an enabled client.
fn is_browser_session_client_disabled(
    tx: &mut impl ClientsTx,
) -> Result<bool, AuthorizationServerError> {
    let browser_session_client = tx.client_by_id(BROWSER_SESSION_CLIENT_ID)?.ok_or_else(|| {
        AuthorizationServerError::ClientNotFound {
            client_id: BROWSER_SESSION_CLIENT_ID.to_owned(),
        }
    })?;
    Ok(browser_session_client.disabled_at.is_some())
}

impl From<AuthorizationServerError> for SameDeviceSignInError {
    fn from(error: AuthorizationServerError) -> Self {
        SameDeviceSignInError::Store(error)
    }
}

#[cfg(test)]
mod tests {
    use crate::domain::grant_store::*;
    use url::Url;
    use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;

    use super::*;
    use crate::domain::access_token::{verify_access_token, AccessTokenVerifyOptions};
    use crate::domain::browser_session::{BrowserSession, RunStart};
    use crate::domain::same_device_sign_in_codes::SAME_DEVICE_SIGN_IN_CODE_TTL;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::{client, seed_active_signing_key, FakeGrantStore};

    /// The server's origin: the session token's `iss` and `aud`.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    /// The Owner's grant in these tests, which a same-device session holds,
    /// and the browser-session client is allowed.
    const OWNER_SCOPES: [&str; 2] = ["system/*.cruds", "wildflower/*.cruds"];

    /// A sign-in over `store` and the outstanding `codes`, allowing `next`s
    /// on this server and the site's launcher and authorization app.
    fn sign_in_over(
        store: FakeGrantStore,
        codes: Arc<SameDeviceSignInCodes>,
    ) -> SameDeviceSignIn<FakeGrantStore> {
        SameDeviceSignIn::new(
            store,
            codes,
            Arc::new(SignInDestinations::new(
                Url::parse(SERVER_ORIGIN).expect("server origin"),
                LauncherBase::parse("https://site.example/launcher/").expect("launcher"),
                AuthorizationAppBase::parse("https://site.example/authorization/")
                    .expect("authorization app"),
                Url::parse("https://site.example/launcher/").expect("launcher URL"),
                Url::parse("https://site.example/authorization/").expect("authorization URL"),
            )),
            SERVER_ORIGIN.into(),
            Grant::parse(OWNER_SCOPES),
        )
    }

    /// A sign-in over a store with a signing key and the seeded browser-session
    /// client, and one outstanding code, `code-1`, minted at `minted_at`; and
    /// the key.
    fn sign_in_with_a_code(
        minted_at: DateTime<Utc>,
    ) -> (SameDeviceSignIn<FakeGrantStore>, SigningKey) {
        let store = FakeGrantStore::default();
        let signing_key = seed_active_signing_key(&store);
        store
            .tx()
            .upsert_client(&client(BROWSER_SESSION_CLIENT_ID, &OWNER_SCOPES))
            .expect("seed the browser-session client");
        let codes = Arc::new(SameDeviceSignInCodes::new());
        codes.insert("code-1", minted_at);
        (sign_in_over(store, codes), signing_key)
    }

    /// A store that withdraws `code-1` from `codes` at the end of each write
    /// scope, before it commits: the view the code was opened in closing
    /// as its session is about to land.
    struct WithdrawingStore {
        store: FakeGrantStore,
        codes: Arc<SameDeviceSignInCodes>,
    }

    impl GrantStore for WithdrawingStore {
        type Tx<'a> = <FakeGrantStore as GrantStore>::Tx<'a>;

        fn read<T, E: From<AuthorizationServerError>>(
            &self,
            f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
        ) -> Result<T, E> {
            self.store.read(f)
        }

        fn write<T, E: From<AuthorizationServerError>>(
            &self,
            f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
        ) -> Result<T, E> {
            self.store.write(|tx| {
                let written = f(tx);
                self.codes.withdraw("code-1");
                written
            })
        }
    }

    /// A code signs the browser in: it goes on to `next`, holding a token
    /// this server accepts, issued to the browser-session client with the
    /// Owner's scopes and living [`SAME_DEVICE_SESSION_TTL`].
    #[test]
    fn a_code_signs_the_owner_in_for_eight_hours() {
        let now = Utc::now();
        let (sign_in, signing_key) = sign_in_with_a_code(now);
        let signed_in = sign_in.sign_in("code-1", "/", now).expect("signed in");
        assert_eq!(signed_in.redirect.location(), "/");
        let claims = verify_access_token(
            &signed_in.session_token,
            &[signing_key],
            &AccessTokenVerifyOptions {
                expected_issuer: SERVER_ORIGIN,
                accepted_audiences: &[SERVER_ORIGIN.to_owned()],
            },
        )
        .expect("an Owner token this server accepts");
        assert_eq!(claims.subject, BROWSER_SESSION_CLIENT_ID);
        assert_eq!(
            claims.scope.as_deref(),
            Some("system/*.cruds wildflower/*.cruds")
        );
        assert_eq!(
            claims
                .expires_at
                .zip(claims.issued_at)
                .map(|(exp, iat)| exp - iat),
            Some(SAME_DEVICE_SESSION_TTL),
            "the token lives eight hours"
        );
    }

    /// A sign-in remembers its session by the code, so the code finds the
    /// session's `sid`, as stored.
    #[test]
    fn a_sign_in_remembers_its_session_by_the_code() {
        let now = Utc::now();
        let (sign_in, _signing_key) = sign_in_with_a_code(now);
        sign_in.sign_in("code-1", "/", now).expect("signed in");
        let sid = sign_in
            .codes
            .signed_in_sid("code-1")
            .expect("the code's session");
        assert!(sign_in
            .store
            .tx()
            .browser_session_by_sid(&sid)
            .expect("read")
            .is_some_and(|session| session.is_live_at(now, &RunStart::before_any_session())));
    }

    /// A code withdrawn once its session is remembered by it, before the
    /// scope commits, still finds the session, so no session lands that the
    /// base can't end by its code.
    #[test]
    fn a_code_withdrawn_before_its_scope_commits_finds_its_session() {
        let now = Utc::now();
        let (sign_in, _signing_key) = sign_in_with_a_code(now);
        // Withdrawn at the end of the write scope, before it commits: the
        // view closed mid-sign-in.
        let withdrawing = WithdrawingStore {
            store: sign_in.store.clone(),
            codes: Arc::clone(&sign_in.codes),
        };
        let sign_in = SameDeviceSignIn::new(
            withdrawing,
            Arc::clone(&sign_in.codes),
            Arc::clone(&sign_in.destinations),
            Arc::clone(&sign_in.server_origin),
            sign_in.owner_grant.clone(),
        );
        sign_in.sign_in("code-1", "/", now).expect("signed in");
        let sessions = sign_in
            .store
            .store
            .tx()
            .live_browser_sessions(now)
            .expect("read");
        assert_eq!(
            sessions
                .iter()
                .map(|session| Some(session.sid.clone()))
                .collect::<Vec<_>>(),
            [sign_in.codes.signed_in_sid("code-1")],
            "the one session stands, found by its code"
        );
    }

    /// A second presentation of a code whose first is still signing in is
    /// refused, and leaves the first's sign-in as it stood: withdrawn
    /// meanwhile, the first still signs nobody in.
    #[test]
    fn a_second_presentation_mid_sign_in_keeps_the_withdrawal() {
        let now = Utc::now();
        let (sign_in, _signing_key) = sign_in_with_a_code(now);
        // The first presentation has redeemed the code and is storing its
        // session when the view closes.
        assert!(sign_in.codes.take("code-1", now));
        sign_in.codes.withdraw("code-1");
        assert!(matches!(
            sign_in.sign_in("code-1", "/", now),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::CodeNotRedeemable
            ))
        ));
        let first_session = BrowserSession::new_same_device_session(
            sign_in.owner_grant.render(),
            SAME_DEVICE_SESSION_TTL,
            now,
        );
        assert!(
            !sign_in.codes.session_stored("code-1", &first_session),
            "the first sign-in finds its code withdrawn"
        );
    }

    /// A redeemed code is spent: presenting it again is
    /// [`SignInRefusal::CodeNotRedeemable`].
    #[test]
    fn a_code_signs_in_once() {
        let now = Utc::now();
        let (sign_in, _store) = sign_in_with_a_code(now);
        assert!(sign_in.sign_in("code-1", "/", now).is_ok());
        assert!(matches!(
            sign_in.sign_in("code-1", "/", now),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::CodeNotRedeemable
            ))
        ));
    }

    /// A code nobody minted, and a code at its TTL, are both
    /// [`SignInRefusal::CodeNotRedeemable`].
    #[test]
    fn an_expired_or_unknown_code_signs_nobody_in() {
        let minted_at = Utc::now();
        let (sign_in, _store) = sign_in_with_a_code(minted_at);
        assert!(matches!(
            sign_in.sign_in("no-such-code", "/", minted_at),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::CodeNotRedeemable
            ))
        ));
        assert!(matches!(
            sign_in.sign_in("code-1", "/", minted_at + SAME_DEVICE_SIGN_IN_CODE_TTL),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::CodeNotRedeemable
            ))
        ));
    }

    /// A `next` off the allowed places is refused before the code is touched,
    /// so the same code then signs in with an allowed `next`.
    #[test]
    fn a_refused_next_leaves_the_code_redeemable() {
        let now = Utc::now();
        let (sign_in, _store) = sign_in_with_a_code(now);
        assert!(matches!(
            sign_in.sign_in("code-1", "https://evil.example/", now),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::RedirectNotAllowed
            ))
        ));
        assert!(sign_in.sign_in("code-1", "/", now).is_ok());
    }

    /// While the browser-session client is disabled, a sign-in is refused
    /// without spending the code; once it is enabled again, the code signs in.
    #[test]
    fn a_disabled_browser_session_client_signs_nobody_in_and_leaves_the_code_redeemable() {
        let now = Utc::now();
        let (sign_in, _store) = sign_in_with_a_code(now);
        let set_browser_session_client_disabled_at = |disabled_at| {
            assert!(sign_in
                .store
                .tx()
                .set_client_disabled(BROWSER_SESSION_CLIENT_ID, disabled_at)
                .expect("set disabled_at"));
        };
        set_browser_session_client_disabled_at(Some(now));
        assert!(matches!(
            sign_in.sign_in("code-1", "/", now),
            Err(SameDeviceSignInError::Refused(
                SignInRefusal::BrowserSessionClientDisabled
            ))
        ));
        set_browser_session_client_disabled_at(None);
        assert!(sign_in.sign_in("code-1", "/", now).is_ok());
    }

    /// With no browser-session client row (it is seeded at boot), a sign-in
    /// is a store error, not a sign-in for an enabled client.
    #[test]
    fn a_missing_browser_session_client_is_a_store_error() {
        let now = Utc::now();
        let store = FakeGrantStore::default();
        seed_active_signing_key(&store);
        let codes = Arc::new(SameDeviceSignInCodes::new());
        codes.insert("code-1", now);
        assert!(matches!(
            sign_in_over(store, codes).sign_in("code-1", "/", now),
            Err(SameDeviceSignInError::Store(
                AuthorizationServerError::ClientNotFound { .. }
            ))
        ));
    }
}
