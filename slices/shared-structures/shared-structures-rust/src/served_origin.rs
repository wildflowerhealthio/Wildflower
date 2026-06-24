//! Forwarding-header provenance — `request_provenance` and the rendered
//! `served_origin_for`.
//!
//! Two callers today derive identity from the same header pair the trusted
//! front sets on relayed requests:
//!
//! - **gatekeeper-rust** — token issuer URLs / discovery doc resolve through
//!   [`served_origin_for`] so a minted token references the URL the caller
//!   really reached, not the loopback API origin.
//! - **apps-rust** — `POST /apps/{id}` reads provenance to decide *both* how to
//!   dispatch (a host popup helps only the local caller, so a remote forwarded
//!   request gets a 302 instead of the sink) *and* what to render into the
//!   redirect's `Location` (the same forwarded origin). Both decisions read
//!   from the same provenance so the empty-host edge can't make them disagree.
//!
//! ## Validation
//!
//! `x-public-origin` lands directly in a `Location` the browser follows, so a
//! relay that forwards a client-supplied value without normalizing it would let
//! a remote caller pick the redirect target. As defense-in-depth this module:
//!
//! - rejects an empty `x-public-origin`,
//! - rejects any non-ASCII, control, whitespace, `/`, `\`, `@`, `?`, or `#`
//!   character (CR/LF, NUL, path separators, the userinfo `@`, query/fragment
//!   delimiters, …) — those have no business in a host[:port] shape and would
//!   let a rendered `Location` resolve to a different authority than it looks
//!   like (e.g. `trusted.example.com@evil.example.com` navigates to `evil`),
//! - accepts `x-forwarded-proto` only as `http`/`https` (case-insensitive) and
//!   otherwise reverts to the `https` default — keeps `javascript:`/`file:`
//!   out of the rendered `Location`.
//!
//! A header that fails validation reads as *unforwarded* (the request falls
//! back to loopback). The validator is intentionally permissive on legitimate
//! host shapes — letters/digits/`.`/`-`/`:`/`[`/`]` are allowed — the goal is
//! a bounded character set, not a full RFC 3986 parse.

use axum::http::HeaderMap;

/// Whether a request was forwarded by the trusted front or arrived directly
/// over loopback. Two callers (which-origin + how-to-dispatch) read from one
/// shape so they can't disagree on the same headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestProvenance {
    /// Direct loopback caller — `x-public-origin` absent (or it failed the
    /// validity guard).
    Loopback,
    /// Relayed by the trusted front. `origin` is the rendered
    /// `{scheme}://{host}` the client actually used.
    Forwarded { origin: String },
}

/// Single read of the forwarding headers — both "is this forwarded?" and
/// "what's the forwarded origin?" derive from this. A malformed
/// `x-public-origin` reads as [`RequestProvenance::Loopback`].
pub fn request_provenance(headers: &HeaderMap) -> RequestProvenance {
    let Some(host) = try_get_header_str(headers, "x-public-origin").and_then(safe_host) else {
        return RequestProvenance::Loopback;
    };
    let scheme = try_get_header_str(headers, "x-forwarded-proto")
        .and_then(safe_scheme)
        .unwrap_or("https");
    RequestProvenance::Forwarded {
        origin: format!("{scheme}://{host}"),
    }
}

/// The origin a given request expects its answer to come from. Forwarded
/// requests resolve to `{x-forwarded-proto}://{x-public-origin}`; loopback
/// requests (and forwarded requests whose headers fail validation) fall back
/// to `loopback_origin`.
pub fn served_origin_for(headers: &HeaderMap, loopback_origin: &str) -> String {
    match request_provenance(headers) {
        RequestProvenance::Forwarded { origin } => origin,
        RequestProvenance::Loopback => loopback_origin.to_owned(),
    }
}

/// Whether the request was forwarded by the trusted front, as a bool. Gates on
/// the same `x-public-origin` + [`safe_host`] check that [`request_provenance`]
/// keys `Forwarded` on, so the two can't disagree on what counts as forwarded —
/// but skips rendering the origin string a bool doesn't need.
pub fn is_forwarded(headers: &HeaderMap) -> bool {
    try_get_header_str(headers, "x-public-origin")
        .and_then(safe_host)
        .is_some()
}

fn try_get_header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// Accept a host[:port] shape: non-empty ASCII, no whitespace, no control
/// chars, and none of the URL-structural delimiters that would let the value
/// resolve to a different authority than it appears to — `/` and `\` (path
/// separators; the WHATWG URL parser folds `\` to `/` for http/https), `@`
/// (userinfo delimiter, so `trusted.example.com@evil.example.com` navigates to
/// `evil.example.com`), and `?` / `#` (query / fragment). Bounded character set
/// rather than a full RFC 3986 parse — legitimate host characters (letters,
/// digits, `.`, `-`, `:` for ports, `[`/`]` for IPv6) pass through. Returns
/// `None` for anything we wouldn't safely echo into a `Location` header.
fn safe_host(value: &str) -> Option<&str> {
    if value.is_empty() {
        return None;
    }
    if value.chars().any(|c| {
        !c.is_ascii()
            || c.is_ascii_control()
            || c.is_ascii_whitespace()
            || matches!(c, '/' | '\\' | '@' | '?' | '#')
    }) {
        return None;
    }
    Some(value)
}

/// Accept only `http`/`https` (case-insensitive) and return the normalized
/// lowercase scheme. Any other value (or a junk header) returns `None` so the
/// caller falls back to the `https` default — keeps `javascript:`/`file:`/etc.
/// out of the rendered `Location`.
fn safe_scheme(value: &str) -> Option<&'static str> {
    if value.eq_ignore_ascii_case("http") {
        Some("http")
    } else if value.eq_ignore_ascii_case("https") {
        Some("https")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};

    const LOOPBACK: &str = "http://127.0.0.1:5173";

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn forwarded_origin_uses_the_forwarded_scheme_and_host() {
        let headers = headers(&[
            ("x-public-origin", "emr.example.com"),
            ("x-forwarded-proto", "http"),
        ]);
        assert_eq!(
            served_origin_for(&headers, LOOPBACK),
            "http://emr.example.com"
        );
    }

    #[test]
    fn forwarded_origin_defaults_to_https_without_a_proto_header() {
        let headers = headers(&[("x-public-origin", "emr.example.com")]);
        assert_eq!(
            served_origin_for(&headers, LOOPBACK),
            "https://emr.example.com"
        );
    }

    #[test]
    fn no_forwarding_headers_falls_back_to_the_loopback_origin() {
        assert_eq!(served_origin_for(&HeaderMap::new(), LOOPBACK), LOOPBACK);
    }

    #[test]
    fn request_provenance_keys_on_a_valid_public_origin() {
        assert_eq!(
            request_provenance(&HeaderMap::new()),
            RequestProvenance::Loopback,
        );
        let h = headers(&[
            ("x-public-origin", "demo.example.com"),
            ("x-forwarded-proto", "https"),
        ]);
        assert_eq!(
            request_provenance(&h),
            RequestProvenance::Forwarded {
                origin: "https://demo.example.com".to_owned(),
            },
        );
    }

    #[test]
    fn is_forwarded_agrees_with_request_provenance() {
        // `is_forwarded` no longer routes through `request_provenance` (it skips
        // rendering the origin), so pin the invariant that the two still agree
        // on every input — valid, absent, empty, and each rejected delimiter.
        let cases: [&[(&str, &str)]; 6] = [
            &[],
            &[("x-public-origin", "demo.example.com")],
            &[
                ("x-public-origin", "demo.example.com"),
                ("x-forwarded-proto", "http"),
            ],
            &[("x-public-origin", "")],
            &[("x-public-origin", "trusted.example.com@evil.example.com")],
            &[("x-public-origin", "demo.example.com/evil")],
        ];
        for pairs in cases {
            let h = headers(pairs);
            assert_eq!(
                is_forwarded(&h),
                matches!(request_provenance(&h), RequestProvenance::Forwarded { .. }),
                "is_forwarded disagreed with request_provenance for {pairs:?}",
            );
        }
    }

    #[test]
    fn empty_public_origin_reads_as_loopback() {
        // An empty value would render `Location: https://` (no authority) and
        // is rejected by the validator. Without the guard, `is_forwarded`
        // (keying on presence) and `served_origin_for` (keying on value)
        // could disagree on the same header.
        let h = headers(&[("x-public-origin", "")]);
        assert_eq!(request_provenance(&h), RequestProvenance::Loopback);
        assert_eq!(served_origin_for(&h, LOOPBACK), LOOPBACK);
        assert!(!is_forwarded(&h));
    }

    #[test]
    fn public_origin_with_control_or_whitespace_reads_as_loopback() {
        // CR/LF and NUL never reach us — hyper's `HeaderValue` parser already
        // rejects them at the HTTP layer (`HeaderValue::from_str` errors on
        // anything outside `b' '..=b'~'` plus HTAB). The cases below are
        // bytes the HTTP layer *does* let through but a host[:port] shape
        // must not: an embedded space, a tab, a path segment. The validator
        // rejects each so the rendered `Location` can't carry them.
        for bad in [
            "demo.example.com ",
            "demo.example.com\t",
            "demo.example.com/evil",
        ] {
            let h = headers(&[("x-public-origin", bad)]);
            assert_eq!(
                request_provenance(&h),
                RequestProvenance::Loopback,
                "expected loopback fallback for {bad:?}",
            );
        }
    }

    #[test]
    fn public_origin_with_url_delimiters_reads_as_loopback() {
        // `@` (userinfo), `\` (folded to `/` by the WHATWG URL parser for
        // http/https), and `?` / `#` (query / fragment) each let a rendered
        // `Location` resolve to a different authority than it looks like — e.g.
        // `https://trusted.example.com@evil.example.com` navigates to
        // `evil.example.com`. The validator rejects them, so the value falls
        // back to loopback rather than into the redirect target.
        for bad in [
            "trusted.example.com@evil.example.com",
            "demo.example.com\\evil.example.com",
            "demo.example.com?goto=evil",
            "demo.example.com#evil",
        ] {
            let h = headers(&[("x-public-origin", bad)]);
            assert_eq!(
                request_provenance(&h),
                RequestProvenance::Loopback,
                "expected loopback fallback for {bad:?}",
            );
            assert_eq!(served_origin_for(&h, LOOPBACK), LOOPBACK);
            assert!(!is_forwarded(&h));
        }
    }

    #[test]
    fn unknown_forwarded_proto_falls_back_to_https() {
        // `javascript:`/`file:` etc. must not land in a `Location` the browser
        // follows — an unknown scheme reverts to the safe https default.
        let h = headers(&[
            ("x-public-origin", "demo.example.com"),
            ("x-forwarded-proto", "javascript"),
        ]);
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://demo.example.com",);
    }

    #[test]
    fn ipv6_host_with_brackets_passes_validation() {
        // Legitimate host shapes (IPv6 in brackets, host:port) must pass.
        let h = headers(&[("x-public-origin", "[::1]:8080")]);
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://[::1]:8080");
        let h2 = headers(&[("x-public-origin", "demo.example.com:8443")]);
        assert_eq!(
            served_origin_for(&h2, LOOPBACK),
            "https://demo.example.com:8443",
        );
    }
}
