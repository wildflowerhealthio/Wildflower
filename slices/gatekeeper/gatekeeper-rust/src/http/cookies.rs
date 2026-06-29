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
//! because the web path is same-origin (#218 `SameSite` note); `Secure` keeps
//! the cookies off plain HTTP; `Path=/` so they ride every route.

use axum::http::{header, HeaderMap, HeaderValue};

/// Name of the `HttpOnly` cookie carrying the raw access-token JWT.
pub(crate) const AUTH_COOKIE_NAME: &str = "wf_auth";

/// Name of the non-`HttpOnly` companion cookie carrying the token's unix `exp`.
pub(crate) const AUTH_EXP_COOKIE_NAME: &str = "wf_auth_exp";

/// Build one `Set-Cookie` value. Attribute order mirrors the #218 spec:
/// `<name>=<value>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<n>`.
/// `HttpOnly` is omitted for the companion flag cookie so the SPA can read it.
fn build_cookie(name: &str, value: &str, http_only: bool, max_age: i64) -> String {
    let http_only = if http_only { "HttpOnly; " } else { "" };
    format!("{name}={value}; {http_only}Secure; SameSite=Lax; Path=/; Max-Age={max_age}")
}

/// `Set-Cookie` value for the `HttpOnly` JWT cookie, living `max_age` seconds.
pub(crate) fn auth_set_cookie(jwt: &str, max_age: i64) -> String {
    build_cookie(AUTH_COOKIE_NAME, jwt, true, max_age)
}

/// `Set-Cookie` value for the readable companion cookie carrying the absolute
/// unix `exp`, expiring with the same `max_age` as its JWT sibling.
pub(crate) fn exp_set_cookie(exp_unix: i64, max_age: i64) -> String {
    build_cookie(AUTH_EXP_COOKIE_NAME, &exp_unix.to_string(), false, max_age)
}

/// `Set-Cookie` value that clears the JWT cookie (`Max-Age=0`). The attributes
/// match the set form so the browser matches and deletes the same cookie.
pub(crate) fn auth_clear_cookie() -> String {
    build_cookie(AUTH_COOKIE_NAME, "", true, 0)
}

/// `Set-Cookie` value that clears the companion cookie (`Max-Age=0`).
pub(crate) fn exp_clear_cookie() -> String {
    build_cookie(AUTH_EXP_COOKIE_NAME, "", false, 0)
}

/// Append a `Set-Cookie` header carrying `value`. A JWT or decimal cookie
/// string is always valid header bytes; on the impossible failure the cookie is
/// skipped rather than panicking (this code path mints owner sessions).
fn append_cookie(headers: &mut HeaderMap, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.append(header::SET_COOKIE, value);
    }
}

/// Append both session cookies (`wf_auth` + `wf_auth_exp`) for a freshly issued
/// token onto `headers`, as two distinct `Set-Cookie` entries.
pub(crate) fn append_session_cookies(
    headers: &mut HeaderMap,
    jwt: &str,
    max_age: i64,
    exp_unix: i64,
) {
    append_cookie(headers, &auth_set_cookie(jwt, max_age));
    append_cookie(headers, &exp_set_cookie(exp_unix, max_age));
}

/// Append the clearing `Set-Cookie`s for both session cookies onto `headers` —
/// used when the owner session ends (`POST /access/logout`).
pub(crate) fn append_clear_session_cookies(headers: &mut HeaderMap) {
    append_cookie(headers, &auth_clear_cookie());
    append_cookie(headers, &exp_clear_cookie());
}

/// Read the value of cookie `name` from the request `Cookie` header(s), or
/// `None` if absent. Tolerates multiple `Cookie` headers and surrounding
/// whitespace; never panics on malformed input. An empty value is returned as
/// `Some("")` — callers that treat a token as a secret should reject it.
pub(crate) fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .filter_map(|pair| pair.split_once('='))
        .find_map(|(k, v)| (k.trim() == name).then(|| v.trim().to_string()))
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

    #[test]
    fn auth_cookie_carries_all_attributes_and_is_http_only() {
        let cookie = auth_set_cookie("eyJh.bbb.ccc", 3600);
        assert_eq!(
            cookie,
            "wf_auth=eyJh.bbb.ccc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600"
        );
    }

    #[test]
    fn exp_companion_cookie_is_readable_and_carries_the_exp() {
        let cookie = exp_set_cookie(1_750_000_000, 3600);
        assert_eq!(
            cookie,
            "wf_auth_exp=1750000000; Secure; SameSite=Lax; Path=/; Max-Age=3600"
        );
        // The companion MUST stay readable to JS — never HttpOnly.
        assert!(!cookie.contains("HttpOnly"));
    }

    #[test]
    fn clear_cookies_expire_immediately() {
        assert!(auth_clear_cookie().contains("Max-Age=0"));
        assert!(auth_clear_cookie().contains("HttpOnly"));
        assert!(exp_clear_cookie().contains("Max-Age=0"));
        assert!(!exp_clear_cookie().contains("HttpOnly"));
    }

    #[test]
    fn append_session_cookies_emits_two_distinct_set_cookies() {
        let mut headers = HeaderMap::new();
        append_session_cookies(&mut headers, "j.w.t", 3600, 1_750_000_000);
        let set: Vec<_> = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().expect("ascii").to_string())
            .collect();
        assert_eq!(set.len(), 2);
        assert!(set.iter().any(|c| c.starts_with("wf_auth=j.w.t;")));
        assert!(set.iter().any(|c| c.starts_with("wf_auth_exp=1750000000;")));
    }

    #[test]
    fn reads_named_cookie_among_others() {
        let headers = cookie_header("other=1; wf_auth=the.jwt.value; another=2");
        assert_eq!(
            cookie_value(&headers, "wf_auth"),
            Some("the.jwt.value".into())
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
            prop_assert_eq!(cookie_value(&headers, AUTH_COOKIE_NAME), Some(jwt));
        }
    }
}
