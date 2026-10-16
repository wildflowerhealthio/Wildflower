//! The cookie an Owner browser holds its session in once it has signed in at
//! `/oauth/sign-in`: `__Host-owner_browser_session`, whose value is the Owner
//! browser's access token itself, naming its browser session as its `sid`. A
//! restart doesn't sign the browser out; revoking the token's `jti`, the
//! Owner-browser client's subject, or the browser session, does.
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
//! [`SESSION_HEADER`] set to [`OWNER_BROWSER_SESSION_HEADER_VALUE`] on its
//! requests, and the layer presents the Owner browser session's token, or no
//! session's, instead.

use std::sync::Arc;

use axum::http::{header, HeaderMap};
use cookie::Cookie;

use crate::domain::capabilities::oauth::OWNER_BROWSER_SESSION_TTL;
use crate::domain::token::{VerifiedClaims, VerifyError};
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::{FromState, LiveTokenVerifier};

/// The Owner browser session cookie. The `__Host-` prefix holds a browser to
/// accepting it only `Secure`, with `Path=/` and no `Domain`, so it is this
/// server's alone, set over `https`, and no sibling subdomain can set or
/// shadow it.
pub const OWNER_BROWSER_SESSION_COOKIE: &str = "__Host-owner_browser_session";

/// The request header a page on the server's own origin names the session it
/// acts as in, for a browser holding more than one session cookie. Only
/// [`OWNER_BROWSER_SESSION_HEADER_VALUE`] means anything; a request without
/// it, or with any other value, gets the layer's default.
pub const SESSION_HEADER: &str = "wildflower-session";

/// [`SESSION_HEADER`]'s value for the Owner browser session: the request acts
/// as the Owner signed in on this browser, or as no session if none is.
pub const OWNER_BROWSER_SESSION_HEADER_VALUE: &str = "owner-browser";

/// The `Set-Cookie` value that hands a browser `owner_browser_token` as its
/// Owner browser session: `HttpOnly`, so no script reads it; `SameSite=Lax`,
/// so another site's subrequests don't carry it; and it lasts exactly as long
/// as the token.
pub(crate) fn owner_browser_session_set_cookie(owner_browser_token: &str) -> String {
    owner_browser_session_cookie(owner_browser_token, OWNER_BROWSER_SESSION_TTL.num_seconds())
}

/// The `Set-Cookie` value that clears a browser's Owner browser session: the
/// same name and attributes, empty, with `Max-Age=0`. The cookie is
/// `HttpOnly`, so only the server can clear it.
#[must_use]
pub fn owner_browser_session_clearing_set_cookie() -> String {
    owner_browser_session_cookie("", 0)
}

/// The Owner browser session cookie set to `value` for `max_age_seconds`.
fn owner_browser_session_cookie(value: &str, max_age_seconds: i64) -> String {
    format!(
        "{OWNER_BROWSER_SESSION_COOKIE}={value}; Secure; HttpOnly; SameSite=Lax; Path=/; \
         Max-Age={max_age_seconds}"
    )
}

/// Whether the session an Owner browser cookie holds has ended: the gates
/// would refuse `owner_browser_token` as a bad, expired or revoked token (by
/// its `jti`, its subject or its browser session), checked by the same
/// [`TokenVerifier`](crate::domain::capabilities::session::TokenVerifier) the
/// gates run. A store that can't be read says nothing about the token, so it
/// hasn't ended; the gate then fails closed on it the same way.
#[must_use]
pub fn owner_browser_session_has_ended(
    state: &Arc<AuthorizationServerState>,
    owner_browser_token: &str,
) -> bool {
    has_ended(&LiveTokenVerifier::from_state(state), owner_browser_token)
}

/// The verified claims of the Owner browser session `headers` carry, when the
/// browser that sent them is signed in as the Owner: its cookie holds a token
/// the gates would accept. Its `sid` names the browser session. A store that
/// can't be read verifies nothing, so the browser is treated as not signed in.
pub(crate) fn carried_owner_browser_session(
    token_verifier: &LiveTokenVerifier,
    headers: &HeaderMap,
) -> Option<VerifiedClaims> {
    owner_browser_session_token(headers)
        .and_then(|owner_browser_token| token_verifier.verify(&owner_browser_token).ok())
}

/// The Owner browser session cookie's value among `headers`' `Cookie`s, if
/// the browser sent it.
fn owner_browser_session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|cookie_header| cookie_header.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(Result::ok)
        .find(|cookie| cookie.name() == OWNER_BROWSER_SESSION_COOKIE)
        .map(|cookie| cookie.value().to_owned())
}

/// Whether `token_verifier` would refuse `owner_browser_token` for good: bad,
/// expired or revoked. An unreadable store says nothing about the token.
fn has_ended(token_verifier: &LiveTokenVerifier, owner_browser_token: &str) -> bool {
    match token_verifier.verify(owner_browser_token) {
        Ok(_) => false,
        Err(VerifyError::TokenRejected | VerifyError::Revoked) => true,
        Err(
            VerifyError::NoSigningKeysConfigured
            | VerifyError::KeyStoreUnavailable(_)
            | VerifyError::SigningKeyUnreadable(_)
            | VerifyError::RevocationStoreUnavailable(_)
            | VerifyError::BrowserSessionStoreUnavailable(_),
        ) => false,
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{header, HeaderMap, HeaderValue};

    use super::{
        owner_browser_session_clearing_set_cookie, owner_browser_session_set_cookie,
        owner_browser_session_token,
    };

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
            (&["__Host-owner_browser_session=a.b.c"][..], Some("a.b.c")),
            (
                &["hfs_session=s-1; __Host-owner_browser_session=a.b.c; theme=dark"][..],
                Some("a.b.c"),
            ),
            (
                &["hfs_session=s-1", "__Host-owner_browser_session=a.b.c"][..],
                Some("a.b.c"),
            ),
            // A name that only starts like the cookie's is another cookie.
            (&["__Host-owner_browser_session_x=a.b.c"][..], None),
            (&["hfs_session=s-1"][..], None),
            (&[][..], None),
        ] {
            assert_eq!(
                owner_browser_session_token(&cookie_headers(cookies)).as_deref(),
                expected,
                "{cookies:?}"
            );
        }
    }

    #[test]
    fn the_cookie_has_exactly_the_owner_browser_session_attributes() {
        assert_eq!(
            owner_browser_session_set_cookie("header.payload.signature"),
            "__Host-owner_browser_session=header.payload.signature; Secure; HttpOnly; \
             SameSite=Lax; Path=/; Max-Age=28800"
        );
    }

    #[test]
    fn the_clearing_cookie_has_the_same_attributes_and_no_age() {
        assert_eq!(
            owner_browser_session_clearing_set_cookie(),
            "__Host-owner_browser_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        );
    }
}
