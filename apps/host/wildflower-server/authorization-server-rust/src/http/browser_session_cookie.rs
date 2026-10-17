//! The cookie a browser holds its browser session in once the server has
//! signed it in (the Owner's, at `/oauth/sign-in`): `__Host-browser_session`,
//! whose value is the browser's access token itself, naming its browser
//! session as its `sid`. A restart doesn't sign the browser out; revoking the
//! token's `jti`, the browser-session client's subject, or the browser
//! session, does.
//!
//! The authorization server sets it, and says whether the session it holds has
//! ended. The host's cookie→bearer layer (`wildflower-server-rust`'s
//! `session_cookie_bearer`) reads it back on requests from the server's own
//! pages: it presents a live session's token as the request's bearer, so the
//! bearer gates check it like any other token, and clears an ended one.
//! `/oauth/authorize` reads it too, on the navigation a client starts, to send
//! a browser signed in as the Owner to the consent card rather than the wait
//! page, and to issue the request's code under that browser session.
//!
//! A browser can hold the FHIR web UI's `hfs_session` beside it, and the layer
//! presents `hfs_session`'s token when both ride a request. A page that acts
//! as the Owner (the consent card, and the wait page's check for it) sends
//! [`SESSION_HEADER`] set to [`BROWSER_SESSION_HEADER_VALUE`] on its
//! requests, and the layer presents the browser session's token, or no
//! session's, instead.

use std::sync::Arc;

use axum::http::{header, HeaderMap};
use cookie::Cookie;
use wildflowerhealthio_scope_capabilities::GrantedScopes as _;

use crate::domain::capabilities::access::consents::consent_decider_scopes;
use crate::domain::capabilities::oauth::OWNER_SESSION_TTL;
use crate::domain::capabilities::session::TokenVerifier;
use crate::domain::token::{VerifiedClaims, VerifyError};
use crate::domain::GrantStore;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::{FromState, LiveTokenVerifier};
use crate::BROWSER_SESSION_CLIENT_ID;

/// The browser session cookie. The `__Host-` prefix holds a browser to
/// accepting it only `Secure`, with `Path=/` and no `Domain`, so it is this
/// server's alone, set over `https`, and no sibling subdomain can set or
/// shadow it.
pub const BROWSER_SESSION_COOKIE: &str = "__Host-browser_session";

/// The request header a page on the server's own origin names the session it
/// acts as in, for a browser holding more than one session cookie. Only
/// [`BROWSER_SESSION_HEADER_VALUE`] means anything; a request without
/// it, or with any other value, gets the layer's default.
pub const SESSION_HEADER: &str = "wildflower-session";

/// [`SESSION_HEADER`]'s value for the browser session: the request acts in
/// the session this browser is signed in with, or as no session if none is.
pub const BROWSER_SESSION_HEADER_VALUE: &str = "browser";

/// The `Set-Cookie` value that hands a browser `session_token` as its
/// browser session: `HttpOnly`, so no script reads it; `SameSite=Lax`,
/// so another site's subrequests don't carry it; and it lasts exactly as long
/// as the token.
pub(crate) fn browser_session_set_cookie(session_token: &str) -> String {
    browser_session_cookie(session_token, OWNER_SESSION_TTL.num_seconds())
}

/// The `Set-Cookie` value that clears a browser's browser session: the
/// same name and attributes, empty, with `Max-Age=0`. The cookie is
/// `HttpOnly`, so only the server can clear it.
#[must_use]
pub fn browser_session_clearing_set_cookie() -> String {
    browser_session_cookie("", 0)
}

/// The browser session cookie set to `value` for `max_age_seconds`.
fn browser_session_cookie(value: &str, max_age_seconds: i64) -> String {
    format!(
        "{BROWSER_SESSION_COOKIE}={value}; Secure; HttpOnly; SameSite=Lax; Path=/; \
         Max-Age={max_age_seconds}"
    )
}

/// Whether the session a browser session cookie holds has ended: the gates
/// would refuse `session_token` as a bad, expired or revoked token (by its
/// `jti`, its subject or its browser session), checked by the same
/// [`TokenVerifier`] the gates run, or it is no browser session's token at
/// all.
///
/// # Errors
///
/// The server-side [`VerifyError`]s, when a key, revocation or browser-session
/// store can't be read, so the session can't be checked.
pub fn browser_session_has_ended(
    state: &Arc<AuthorizationServerState>,
    session_token: &str,
) -> Result<bool, VerifyError> {
    Ok(standing_session_claims(&LiveTokenVerifier::from_state(state), session_token)?.is_none())
}

/// The verified claims of the browser session `headers` carry, when the
/// browser that sent them is signed in: its cookie holds a browser session's
/// token the gates would accept. Its `sid` names the browser session. `None`
/// when there is no cookie or its session has ended (see
/// [`browser_session_has_ended`]).
///
/// # Errors
///
/// The server-side [`VerifyError`]s, when a key, revocation or browser-session
/// store can't be read, so the session can't be checked.
pub(crate) fn carried_browser_session(
    token_verifier: &LiveTokenVerifier,
    headers: &HeaderMap,
) -> Result<Option<VerifiedClaims>, VerifyError> {
    let Some(session_token) = browser_session_token(headers) else {
        return Ok(None);
    };
    standing_session_claims(token_verifier, &session_token)
}

/// Whether the browser session `claims` describe can decide consents: its
/// grant covers what deciding one requires ([`consent_decider_scopes`]). A
/// request such a browser starts is sent to the consent card and decided
/// there, so the start spends nothing of the authorization start limit.
pub(crate) fn can_decide_consents(claims: &VerifiedClaims) -> bool {
    let granted = claims.granted();
    consent_decider_scopes()
        .iter()
        .all(|required| granted.covers(required))
}

/// The verified claims of `session_token`, or `None` when it holds no
/// standing browser session: `token_verifier` refuses it for good (bad,
/// expired or revoked), or it is some other token, not issued to the
/// browser-session client under a browser session (its `sid`).
///
/// # Errors
///
/// The server-side [`VerifyError`]s, when a store can't be read.
fn standing_session_claims<S: GrantStore>(
    token_verifier: &TokenVerifier<S>,
    session_token: &str,
) -> Result<Option<VerifiedClaims>, VerifyError> {
    match token_verifier.verify(session_token) {
        Ok(claims) if claims.subject == BROWSER_SESSION_CLIENT_ID && claims.sid.is_some() => {
            Ok(Some(claims))
        }
        Ok(_) | Err(VerifyError::TokenRejected | VerifyError::Revoked) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The browser session cookie's value among `headers`' `Cookie`s, if
/// the browser sent it.
fn browser_session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|cookie_header| cookie_header.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(Result::ok)
        .find(|cookie| cookie.name() == BROWSER_SESSION_COOKIE)
        .map(|cookie| cookie.value().to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::{header, HeaderMap, HeaderValue};
    use chrono::{DateTime, Duration, Utc};

    use super::{
        browser_session_clearing_set_cookie, browser_session_set_cookie, browser_session_token,
        standing_session_claims,
    };
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::capabilities::session::TokenVerifier;
    use crate::domain::signing_key::SigningKey;
    use crate::domain::test_fake::{seed_active_signing_key, FakeGrantStore};
    use crate::domain::token::{mint_access_token, NewJwtArgs};
    use crate::domain::GrantStore as _;
    use crate::ports::RevocationCheck;
    use crate::BROWSER_SESSION_CLIENT_ID;

    const ORIGIN: &str = "https://ruth.relay.example";

    /// A revocation check that revokes nothing.
    struct NothingRevoked;

    impl RevocationCheck for NothingRevoked {
        fn is_revoked(
            &self,
            _jti: Option<&str>,
            _issued_at: Option<DateTime<Utc>>,
            _subject: &str,
        ) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// A token for this server, issued to `client_id` under `sid`.
    fn mint(key: &SigningKey, client_id: &str, sid: Option<&str>) -> String {
        mint_access_token(
            key,
            &NewJwtArgs {
                client_id,
                scopes: &["system/*.cruds".to_owned()],
                ttl: Duration::minutes(5),
                issuer: ORIGIN,
                audience: Some(ORIGIN),
                patient: None,
                sid,
            },
        )
        .expect("mint")
    }

    /// Only a token issued to the browser-session client under a standing
    /// browser session is one: another client's token the gates would accept,
    /// even under that session, and a browser-session client's token with no
    /// session, hold no browser session.
    #[test]
    fn only_a_browser_session_token_holds_a_browser_session() {
        let store = FakeGrantStore::default();
        let key = seed_active_signing_key(&store);
        let session = BrowserSession::new_owner(vec![], Duration::hours(8), Utc::now());
        store.insert_browser_session(&session).expect("insert");
        let verifier = TokenVerifier::new(store, Arc::new(NothingRevoked), ORIGIN.into());

        let browser_session_token = mint(&key, BROWSER_SESSION_CLIENT_ID, Some(&session.sid));
        let claims = standing_session_claims(&verifier, &browser_session_token)
            .expect("checked")
            .expect("a browser session");
        assert_eq!(claims.sid.as_deref(), Some(session.sid.as_str()));
        for (token, case) in [
            (mint(&key, "another-client", None), "another client's token"),
            (
                mint(&key, "another-client", Some(&session.sid)),
                "another client's token under the session",
            ),
            (
                mint(&key, BROWSER_SESSION_CLIENT_ID, None),
                "a browser-session client token without a sid",
            ),
        ] {
            assert!(
                standing_session_claims(&verifier, &token)
                    .expect("checked")
                    .is_none(),
                "{case} holds no browser session"
            );
        }
    }

    fn cookie_headers(cookie_headers: &[&'static str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for cookie_header in cookie_headers {
            headers.append(header::COOKIE, HeaderValue::from_static(cookie_header));
        }
        headers
    }

    #[test]
    fn the_session_token_is_read_from_among_the_browser_s_cookies() {
        for (cookies, expected) in [
            (&["__Host-browser_session=a.b.c"][..], Some("a.b.c")),
            (
                &["hfs_session=s-1; __Host-browser_session=a.b.c; theme=dark"][..],
                Some("a.b.c"),
            ),
            (
                &["hfs_session=s-1", "__Host-browser_session=a.b.c"][..],
                Some("a.b.c"),
            ),
            // A name that only starts like the cookie's is another cookie.
            (&["__Host-browser_session_x=a.b.c"][..], None),
            (&["hfs_session=s-1"][..], None),
            (&[][..], None),
        ] {
            assert_eq!(
                browser_session_token(&cookie_headers(cookies)).as_deref(),
                expected,
                "{cookies:?}"
            );
        }
    }

    #[test]
    fn the_cookie_has_exactly_the_browser_session_attributes() {
        assert_eq!(
            browser_session_set_cookie("header.payload.signature"),
            "__Host-browser_session=header.payload.signature; Secure; HttpOnly; \
             SameSite=Lax; Path=/; Max-Age=28800"
        );
    }

    #[test]
    fn the_clearing_cookie_has_the_same_attributes_and_no_age() {
        assert_eq!(
            browser_session_clearing_set_cookie(),
            "__Host-browser_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        );
    }
}
