//! [`SameDeviceSignIn`] — `GET /oauth/sign-in`: redeem a one-time same-device sign-in code the
//! base minted in-process for an Owner browser's session token, and say where the
//! browser goes next. It reads top to bottom as: check `next` against the
//! allow-list (before the code is touched), redeem the code for its
//! [`RedeemedSameDeviceSignInCode`] proof, mint under it.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use wildflowerhealthio_scopes::Grant;

use crate::domain::authority::{RedeemedSameDeviceSignInCode, TokenEntitlement};
use crate::domain::capabilities::writers::AccessTokenMinter;
use crate::domain::same_device_sign_in_codes::SameDeviceSignInCodes;
use crate::domain::sign_in_redirect::{SignInDestinations, SignInRedirect};
use crate::domain::token::TokenIssuanceError;
use crate::domain::GrantStore;

/// How long an Owner browser's session token lives: a working day, after which the
/// base signs the browser in again.
pub(crate) const OWNER_BROWSER_SESSION_TTL: Duration = Duration::hours(8);

/// What a sign-in issued: the Owner browser's session token, and where the browser
/// goes with it.
pub(crate) struct OwnerBrowserSession {
    /// The Owner's access token, which the browser holds as its session.
    pub(crate) access_token: String,
    /// Where the browser goes next.
    pub(crate) redirect: SignInRedirect,
}

/// Why a sign-in issued nothing.
#[derive(Debug)]
pub(crate) enum SameDeviceSignInError {
    /// The request was refused: the browser is told why, on a page.
    Refused(SignInRefusal),
    /// The token couldn't be minted (no signing key, a signing or store
    /// failure). The code is spent.
    Issuance(TokenIssuanceError),
}

/// A sign-in request the server refuses, rendered as a local page with no
/// redirect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignInRefusal {
    /// `next` is none of the places a sign-in may send a browser.
    RedirectNotAllowed,
    /// The code is unknown, already redeemed, or expired.
    CodeNotRedeemable,
}

/// Sign a browser in as the Owner. Generic over the store port so it's
/// unit-testable against the fake; the binding instantiates it over the
/// concrete `SqliteGrantStore`.
pub(crate) struct SameDeviceSignIn<S: GrantStore> {
    store: S,
    codes: Arc<SameDeviceSignInCodes>,
    destinations: Arc<SignInDestinations>,
    /// The server's bare origin, the token's `iss` and `aud`.
    server_origin: Arc<str>,
    /// The Owner's client: the host's first-party client.
    owner_client_id: Arc<str>,
    /// The Owner's grant: the host Owner's configured scopes.
    owner_grant: Grant,
}

impl<S: GrantStore> SameDeviceSignIn<S> {
    /// Build the sign-in over the handles lifted from the state.
    pub(crate) fn new(
        store: S,
        codes: Arc<SameDeviceSignInCodes>,
        destinations: Arc<SignInDestinations>,
        server_origin: Arc<str>,
        owner_client_id: Arc<str>,
        owner_grant: Grant,
    ) -> Self {
        SameDeviceSignIn {
            store,
            codes,
            destinations,
            server_origin,
            owner_client_id,
            owner_grant,
        }
    }

    /// Redeem `presented_code` at `now` for an Owner browser's session token that
    /// lives [`OWNER_BROWSER_SESSION_TTL`], to go on to `next`. A `next` that isn't
    /// allowed is refused before the code is touched, so the code stays
    /// redeemable.
    ///
    /// # Errors
    ///
    /// [`SameDeviceSignInError::Refused`] for a `next` that isn't allowed
    /// ([`SignInRefusal::RedirectNotAllowed`]) or a code that is unknown,
    /// spent or expired ([`SignInRefusal::CodeNotRedeemable`]);
    /// [`SameDeviceSignInError::Issuance`] when minting fails.
    pub(crate) fn sign_in(
        &self,
        presented_code: &str,
        next: &str,
        now: DateTime<Utc>,
    ) -> Result<OwnerBrowserSession, SameDeviceSignInError> {
        let redirect = self
            .destinations
            .allow(next)
            .ok_or(SameDeviceSignInError::Refused(
                SignInRefusal::RedirectNotAllowed,
            ))?;
        let redeemed_sign_in_code = RedeemedSameDeviceSignInCode::redeem(
            &self.codes,
            presented_code,
            &self.owner_client_id,
            &self.owner_grant,
            now,
        )
        .ok_or(SameDeviceSignInError::Refused(
            SignInRefusal::CodeNotRedeemable,
        ))?;
        let access_token =
            AccessTokenMinter::new(&self.store, &self.server_origin, OWNER_BROWSER_SESSION_TTL)
                .mint(TokenEntitlement::SameDeviceSignIn(&redeemed_sign_in_code))
                .map_err(SameDeviceSignInError::Issuance)?;
        Ok(OwnerBrowserSession {
            access_token,
            redirect,
        })
    }
}

#[cfg(test)]
mod tests {
    use url::Url;
    use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;

    use super::*;
    use crate::domain::same_device_sign_in_codes::SAME_DEVICE_SIGN_IN_CODE_TTL;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::{seed_active_signing_key, FakeGrantStore};
    use crate::domain::token::{verify_jwt, VerifyOptions};

    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    const OWNER_SCOPES: [&str; 2] = ["system/*.cruds", "wildflower/*.cruds"];

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
            )),
            SERVER_ORIGIN.into(),
            "host".into(),
            Grant::parse(OWNER_SCOPES),
        )
    }

    /// A sign-in over a store with a signing key, and one outstanding code,
    /// `code-1`, minted at `minted_at`; and the key.
    fn sign_in_with_a_code(
        minted_at: DateTime<Utc>,
    ) -> (SameDeviceSignIn<FakeGrantStore>, SigningKey) {
        let store = FakeGrantStore::default();
        let signing_key = seed_active_signing_key(&store);
        let codes = Arc::new(SameDeviceSignInCodes::new());
        codes.insert("code-1", minted_at);
        (sign_in_over(store, codes), signing_key)
    }

    #[test]
    fn a_code_signs_the_owner_in_for_eight_hours() {
        let now = Utc::now();
        let (sign_in, signing_key) = sign_in_with_a_code(now);
        let session = sign_in.sign_in("code-1", "/", now).expect("signed in");
        assert_eq!(session.redirect.location(), "/");
        let claims = verify_jwt(
            &session.access_token,
            &[signing_key],
            &VerifyOptions {
                expected_issuer: SERVER_ORIGIN,
                accepted_audiences: &[SERVER_ORIGIN.to_owned()],
            },
        )
        .expect("an Owner token this server accepts");
        assert_eq!(claims.subject, "host");
        assert_eq!(
            claims.scope.as_deref(),
            Some("system/*.cruds wildflower/*.cruds")
        );
        assert_eq!(
            claims
                .expires_at
                .zip(claims.issued_at)
                .map(|(exp, iat)| exp - iat),
            Some(OWNER_BROWSER_SESSION_TTL),
            "the token lives eight hours"
        );
    }

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
}
