//! Session-cookie helpers for the web Owner-UI auth path.
//!
//! The web SPA authenticates by carrying the access token as a cookie rather
//! than a JS-attached `Authorization` header, so the token rides every request
//! — including the initial document navigation, before any JS runs (see issue
//! #218 and the cookie-auth epic #270). Two cookies are set together:
//!
//! - [`AUTH_COOKIE_NAME`] (`wf_auth`) — the **raw JWT**, `HttpOnly` so JS can't
//!   read it. This is the credential [`try_access_token_from_request`] extracts
//!   when no bearer header is present.
//! - [`AUTH_EXP_COOKIE_NAME`] (`wf_auth_exp`) — a non-`HttpOnly` companion
//!   carrying just the token's unix `exp`, so the SPA can derive "authed until
//!   `exp`" without ever holding the secret token.
//!
//! [`try_access_token_from_request`]:
//!   crate::http::middleware::require_auth::try_access_token_from_request
//!
//! Keeping the cookie a raw JWT (never an opaque session id) is the hard
//! invariant of #218: it lets the relay (a follow-up — #267 / #219) verify a
//! cookie with only the public key and never mint one. `SameSite=Lax` suffices
//! because the web path is same-origin (#218 `SameSite` note); `Path=/` so they
//! ride every route.
//!
//! `Secure` is set **only when the served origin is HTTPS**. The direct-loopback
//! web path is plain `http://127.0.0.1:<port>`, and WebKit/Safari drops a
//! `Secure` cookie set over `http` even on loopback — so an unconditional
//! `Secure` would leave Safari unable to ever store the session (an infinite
//! device-login loop). The typed [`cookie`] crate builds the `Set-Cookie` value
//! and parses the `Cookie` header, so the attribute set and the grammar are the
//! vetted crate's, not hand-rolled.

use axum::http::{header, HeaderMap, HeaderValue};
use cookie::time::Duration;
use cookie::{Cookie, SameSite};

/// Name of the `HttpOnly` cookie carrying the raw access-token JWT.
pub(crate) const AUTH_COOKIE_NAME: &str = "wf_auth";

/// Name of the non-`HttpOnly` companion cookie carrying the token's unix `exp`.
pub(crate) const AUTH_EXP_COOKIE_NAME: &str = "wf_auth_exp";

/// Build one session cookie with the #218 attribute set: `HttpOnly` (only for
/// the JWT cookie), `SameSite=Lax`, `Path=/`, `Max-Age=<max_age>`, and `Secure`
/// gated on `secure`. A `Max-Age` of `0` clears the cookie.
fn session_cookie(
    name: &str,
    value: &str,
    http_only: bool,
    max_age: i64,
    secure: bool,
) -> Cookie<'static> {
    let mut cookie = Cookie::new(name.to_owned(), value.to_owned());
    cookie.set_http_only(http_only);
    // `set_secure(false)` records `Some(false)`, which the crate renders as *no*
    // `Secure` attribute — exactly what the http-loopback path needs.
    cookie.set_secure(secure);
    cookie.set_same_site(SameSite::Lax);
    cookie.set_path("/");
    cookie.set_max_age(Duration::seconds(max_age));
    cookie
}

/// Append a `Set-Cookie` header carrying `cookie`. A JWT or decimal cookie
/// string is always valid header bytes; on the impossible failure the cookie is
/// skipped rather than panicking (this code path mints owner sessions).
fn append_cookie(headers: &mut HeaderMap, cookie: &Cookie<'_>) {
    if let Ok(value) = HeaderValue::from_str(&cookie.to_string()) {
        headers.append(header::SET_COOKIE, value);
    }
}

/// Append both session cookies (`wf_auth` + `wf_auth_exp`) for a freshly issued
/// token onto `headers`, as two distinct `Set-Cookie` entries. `secure` gates
/// the `Secure` attribute (set for an HTTPS served origin, omitted over http
/// loopback so Safari can store the session).
pub(crate) fn append_session_cookies(
    headers: &mut HeaderMap,
    jwt: &str,
    max_age: i64,
    exp_unix: i64,
    secure: bool,
) {
    append_cookie(
        headers,
        &session_cookie(AUTH_COOKIE_NAME, jwt, true, max_age, secure),
    );
    append_cookie(
        headers,
        &session_cookie(
            AUTH_EXP_COOKIE_NAME,
            &exp_unix.to_string(),
            false,
            max_age,
            secure,
        ),
    );
}

/// Append the clearing `Set-Cookie`s for both session cookies onto `headers` —
/// used when the owner session ends (`POST /access/logout`). `secure` must match
/// the set form's `Secure` so Safari accepts the clear over http loopback too.
pub(crate) fn append_clear_session_cookies(headers: &mut HeaderMap, secure: bool) {
    append_cookie(
        headers,
        &session_cookie(AUTH_COOKIE_NAME, "", true, 0, secure),
    );
    append_cookie(
        headers,
        &session_cookie(AUTH_EXP_COOKIE_NAME, "", false, 0, secure),
    );
}

/// Read the value of cookie `name` from the request `Cookie` header(s), or
/// `None` if absent. Borrows straight out of `headers` (no per-request
/// allocation on the auth hot path). Tolerates multiple `Cookie` headers and
/// surrounding whitespace via the crate's [`Cookie::split_parse`]; never panics
/// on malformed input. An empty value is returned as `Some("")` — callers that
/// treat a token as a secret should reject it.
pub(crate) fn cookie_value<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(Cookie::split_parse)
        .filter_map(Result::ok)
        .find(|c| c.name() == name)
        .and_then(|c| c.value_raw())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn cookie_header(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(value).expect("valid"));
        headers
    }

    /// Every `Set-Cookie` value emitted for a set — the two session cookies.
    fn set_cookie_strings(headers: &HeaderMap) -> Vec<String> {
        headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().expect("ascii").to_string())
            .collect()
    }

    #[test]
    fn secure_origin_carries_all_attributes_and_http_only() {
        let mut headers = HeaderMap::new();
        append_session_cookies(&mut headers, "eyJh.bbb.ccc", 3600, 1_750_000_000, true);
        let set = set_cookie_strings(&headers);
        assert_eq!(
            set[0],
            "wf_auth=eyJh.bbb.ccc; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=3600"
        );
        assert_eq!(
            set[1],
            "wf_auth_exp=1750000000; SameSite=Lax; Secure; Path=/; Max-Age=3600"
        );
        // The companion MUST stay readable to JS — never HttpOnly.
        assert!(!set[1].contains("HttpOnly"));
    }

    #[test]
    fn insecure_loopback_origin_omits_secure() {
        // The http-loopback web path: `Secure` must be absent so WebKit/Safari
        // stores the cookie (issue #218 / the bridge.rs loopback note).
        let mut headers = HeaderMap::new();
        append_session_cookies(&mut headers, "j.w.t", 3600, 1_750_000_000, false);
        for cookie in set_cookie_strings(&headers) {
            assert!(!cookie.contains("Secure"), "must omit Secure: {cookie}");
            assert!(cookie.contains("SameSite=Lax") && cookie.contains("Path=/"));
        }
    }

    #[test]
    fn clear_cookies_expire_immediately() {
        let mut headers = HeaderMap::new();
        append_clear_session_cookies(&mut headers, true);
        let set = set_cookie_strings(&headers);
        assert!(set[0].starts_with("wf_auth=;"));
        assert!(set[0].contains("Max-Age=0") && set[0].contains("HttpOnly"));
        assert!(set[1].starts_with("wf_auth_exp=;"));
        assert!(set[1].contains("Max-Age=0") && !set[1].contains("HttpOnly"));
    }

    #[test]
    fn append_session_cookies_emits_two_distinct_set_cookies() {
        let mut headers = HeaderMap::new();
        append_session_cookies(&mut headers, "j.w.t", 3600, 1_750_000_000, true);
        let set = set_cookie_strings(&headers);
        assert_eq!(set.len(), 2);
        assert!(set.iter().any(|c| c.starts_with("wf_auth=j.w.t;")));
        assert!(set.iter().any(|c| c.starts_with("wf_auth_exp=1750000000;")));
    }

    #[test]
    fn reads_named_cookie_among_others() {
        let headers = cookie_header("other=1; wf_auth=the.jwt.value; another=2");
        assert_eq!(cookie_value(&headers, "wf_auth"), Some("the.jwt.value"));
    }

    /// Cross-language contract: the web store (`gatekeeper-react`
    /// `client/auth-state-store.ts`) derives its auth signal from
    /// `AUTH_EXP_COOKIE_NAME`, but gatekeeper-rust owns the name it actually
    /// sets. A server-side rename that missed the TS side would silently leave
    /// the web store deriving `Unauthed` forever (#218). Pin the two literals
    /// together by reading the TS source; a rename on either side fails here.
    #[test]
    fn auth_exp_cookie_name_matches_typescript_web_store() {
        let ts_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../gatekeeper-react/src/client/auth-state-store.ts"
        );
        let ts_src = std::fs::read_to_string(ts_path)
            .expect("read gatekeeper-react client/auth-state-store.ts");
        // Extract the value from `const AUTH_EXP_COOKIE_NAME = '<value>'`.
        let ts_name = ts_src
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("const AUTH_EXP_COOKIE_NAME = ")?
                    .trim_end_matches(';')
                    .trim()
                    .strip_prefix(['\'', '"'])?
                    .strip_suffix(['\'', '"'])
            })
            .expect(
                "AUTH_EXP_COOKIE_NAME literal not found in auth-state-store.ts — did it rename?",
            );
        assert_eq!(
            ts_name, AUTH_EXP_COOKIE_NAME,
            "TS web store and gatekeeper-rust disagree on the wf_auth_exp cookie name"
        );
    }

    #[test]
    fn missing_cookie_is_none() {
        let headers = cookie_header("other=1; another=2");
        assert_eq!(cookie_value(&headers, "wf_auth"), None);
        assert_eq!(cookie_value(&HeaderMap::new(), "wf_auth"), None);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// A planted `wf_auth` value is recovered regardless of the cookies
        /// around it, and the reader never panics. Generators avoid the cookie
        /// delimiters (`;` `=` and whitespace) so the planted pairs stay
        /// well-formed — the parser's job is selection, not delimiter escaping.
        #[test]
        fn reads_planted_value_among_arbitrary_cookies(
            jwt in "[A-Za-z0-9_.-]{1,64}",
            prefix in proptest::collection::vec("[a-z]{1,8}=[a-z0-9]{1,8}", 0..4),
            suffix in proptest::collection::vec("[a-z]{1,8}=[a-z0-9]{1,8}", 0..4),
        ) {
            let mut parts = prefix.clone();
            parts.push(format!("{AUTH_COOKIE_NAME}={jwt}"));
            parts.extend(suffix.clone());
            let headers = cookie_header(&parts.join("; "));
            // The planted name shadows any random `wf_auth=...` a generator
            // might emit only if generators can't produce it — they can't
            // (names are `[a-z]{1,8}`, never `wf_auth`), so the value is exact.
            prop_assert_eq!(cookie_value(&headers, AUTH_COOKIE_NAME), Some(jwt.as_str()));
        }
    }
}
