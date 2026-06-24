//! Forwarding-header provenance — `request_provenance` and the rendered
//! `served_origin_for`.
//!
//! Two callers today derive identity from the same `Forwarded` header (RFC
//! 7239) the trusted front sets on relayed requests:
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
//! ## The contract
//!
//! The trusted front (nginx) appends its hop to any inbound `Forwarded` chain
//! and tacks the public `host`/`proto` onto that trailing element:
//!
//! ```nginx
//! proxy_set_header Forwarded "$proxy_add_forwarded;host=$http_host;proto=$scheme";
//! ```
//!
//! `$proxy_add_forwarded` expands to the (nginx-validated) inbound chain plus a
//! fresh `for=<remote_addr>` element for this hop, and the `;host=…;proto=…`
//! lands on that element. So the host and scheme we trust are always in the
//! **last** forwarded-element — any client-supplied elements sit to its left.
//! We read `host` and `proto` from that last element and ignore the rest (`for`
//! / `by` included; trust is gated at the loopback socket, not derived from the
//! header). A missing or invalid `proto` defaults to `https`.
//!
//! ## Validation
//!
//! `host` is the client's `Host` header (nginx `$http_host` — the raw value, so
//! it may carry a `:port` and isn't normalized), making it attacker-influenced;
//! and it lands directly in a `Location` the browser follows. As
//! defense-in-depth this module:
//!
//! - rejects an empty `host`,
//! - rejects any non-ASCII, control, whitespace, `/`, `\`, `@`, `?`, or `#`
//!   character (CR/LF, NUL, path separators, the userinfo `@`, query/fragment
//!   delimiters, …) — those have no business in a host[:port] shape and would
//!   let a rendered `Location` resolve to a different authority than it looks
//!   like (e.g. `trusted.example.com@evil.example.com` navigates to `evil`),
//! - accepts `proto` only as `http`/`https` (case-insensitive) and otherwise
//!   reverts to the `https` default — keeps `javascript:`/`file:` out of the
//!   rendered `Location`.
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
    /// Direct loopback caller — no usable `Forwarded` `host` (header absent, no
    /// `host` parameter, or it failed the validity guard).
    Loopback,
    /// Relayed by the trusted front. `origin` is the rendered
    /// `{scheme}://{host}` the client actually used.
    Forwarded { origin: String },
}

/// Single read of the `Forwarded` header — both "is this forwarded?" and
/// "what's the forwarded origin?" derive from this. A missing or malformed
/// `host` reads as [`RequestProvenance::Loopback`].
pub fn request_provenance(headers: &HeaderMap) -> RequestProvenance {
    let Some(element) = try_get_header_str(headers, "forwarded").and_then(last_forwarded_element)
    else {
        return RequestProvenance::Loopback;
    };
    let Some(host) = forwarded_param(element, "host").and_then(safe_host) else {
        return RequestProvenance::Loopback;
    };
    let scheme = forwarded_param(element, "proto")
        .and_then(safe_scheme)
        .unwrap_or("https");
    RequestProvenance::Forwarded {
        origin: format!("{scheme}://{host}"),
    }
}

/// The origin a given request expects its answer to come from. Forwarded
/// requests resolve to `{proto}://{host}` from the `Forwarded` header; loopback
/// requests (and forwarded requests whose header fails validation) fall back to
/// `loopback_origin`.
pub fn served_origin_for(headers: &HeaderMap, loopback_origin: &str) -> String {
    match request_provenance(headers) {
        RequestProvenance::Forwarded { origin } => origin,
        RequestProvenance::Loopback => loopback_origin.to_owned(),
    }
}

/// Whether the request was forwarded by the trusted front, as a bool. Gates on
/// the same `Forwarded` `host` + [`safe_host`] check that [`request_provenance`]
/// keys `Forwarded` on, so the two can't disagree on what counts as forwarded —
/// but skips rendering the origin string a bool doesn't need.
pub fn is_forwarded(headers: &HeaderMap) -> bool {
    try_get_header_str(headers, "forwarded")
        .and_then(last_forwarded_element)
        .and_then(|element| forwarded_param(element, "host"))
        .and_then(safe_host)
        .is_some()
}

fn try_get_header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// The forwarded-element set by the proxy directly in front of us: the last
/// comma-separated element of the `Forwarded` header. Each proxy appends its
/// own element (RFC 7239 §4; nginx's `$proxy_add_forwarded` does exactly this),
/// so the rightmost element is the closest, most-trusted hop — the one carrying
/// the `host`/`proto` our front set. Any client-supplied elements sit to its
/// left and are ignored. Returns `None` for an empty header or a trailing comma.
fn last_forwarded_element(value: &str) -> Option<&str> {
    let element = value.rsplit(',').next()?.trim();
    (!element.is_empty()).then_some(element)
}

/// The value of a `Forwarded` `name=value` pair within one element, matching
/// the parameter name case-insensitively (RFC 7239 names are case-insensitive)
/// and stripping optional surrounding double-quotes (a `host:port` or IPv6
/// `host` is quoted per the grammar). First match wins.
fn forwarded_param<'a>(element: &'a str, name: &str) -> Option<&'a str> {
    element.split(';').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case(name)
            .then(|| unquote(value.trim()))
    })
}

/// Strip one layer of surrounding double-quotes from a `Forwarded` value when
/// present. Quoted-pair escapes (`\"`) aren't unescaped — a host/scheme value
/// carrying one is malformed and `safe_host` / `safe_scheme` reject it — so this
/// stays an allocation-free slice.
fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value)
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

    /// One `Forwarded` header from a `name=value` element — the shape nginx
    /// emits via `proxy_set_header Forwarded "..."`.
    fn forwarded(element: &str) -> HeaderMap {
        headers(&[("forwarded", element)])
    }

    #[test]
    fn forwarded_origin_uses_the_forwarded_scheme_and_host() {
        // nginx's exact `for=$remote_addr;proto=$scheme;host=$host` order.
        let h = forwarded("for=192.0.2.1;proto=http;host=emr.example.com");
        assert_eq!(served_origin_for(&h, LOOPBACK), "http://emr.example.com");
    }

    #[test]
    fn forwarded_origin_defaults_to_https_without_a_proto_param() {
        let h = forwarded("for=192.0.2.1;host=emr.example.com");
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://emr.example.com");
    }

    #[test]
    fn no_forwarded_header_falls_back_to_the_loopback_origin() {
        assert_eq!(served_origin_for(&HeaderMap::new(), LOOPBACK), LOOPBACK);
    }

    #[test]
    fn forwarded_header_without_a_host_param_reads_as_loopback() {
        // `for`/`proto` present but no `host` — nothing to render.
        let h = forwarded("for=192.0.2.1;proto=https");
        assert_eq!(request_provenance(&h), RequestProvenance::Loopback);
        assert_eq!(served_origin_for(&h, LOOPBACK), LOOPBACK);
        assert!(!is_forwarded(&h));
    }

    #[test]
    fn request_provenance_keys_on_a_valid_forwarded_host() {
        assert_eq!(
            request_provenance(&HeaderMap::new()),
            RequestProvenance::Loopback,
        );
        let h = forwarded("proto=https;host=demo.example.com");
        assert_eq!(
            request_provenance(&h),
            RequestProvenance::Forwarded {
                origin: "https://demo.example.com".to_owned(),
            },
        );
    }

    #[test]
    fn param_names_are_case_insensitive() {
        // RFC 7239 parameter names are case-insensitive.
        let h = forwarded("Proto=https;Host=demo.example.com");
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://demo.example.com");
    }

    #[test]
    fn reads_the_last_element_of_a_proxy_chain() {
        // `$proxy_add_forwarded` appends our hop as the last element, so the
        // trusted `host`/`proto` are rightmost; a client-supplied element ahead
        // of it (here a spoofed host) must not win.
        let h = forwarded(
            "for=203.0.113.9;host=spoof.example.com, for=192.0.2.1;host=real.example.com;proto=https",
        );
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://real.example.com");
    }

    #[test]
    fn is_forwarded_agrees_with_request_provenance() {
        // `is_forwarded` doesn't route through `request_provenance` (it skips
        // rendering the origin), so pin the invariant that the two still agree
        // on every input — valid, absent, host-less, empty host, chains, and a
        // rejected delimiter.
        let cases: [&[(&str, &str)]; 7] = [
            &[],
            &[("forwarded", "proto=https;host=demo.example.com")],
            &[("forwarded", "for=192.0.2.1;host=demo.example.com")],
            &[("forwarded", "for=192.0.2.1;proto=https")],
            &[("forwarded", "proto=https;host=")],
            &[("forwarded", "host=a.example.com, host=b.example.com")],
            &[("forwarded", "host=trusted.example.com@evil.example.com")],
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
    fn empty_forwarded_host_reads_as_loopback() {
        // An empty `host` would render `Location: https://` (no authority) and
        // is rejected by the validator, so provenance reads loopback.
        let h = forwarded("proto=https;host=");
        assert_eq!(request_provenance(&h), RequestProvenance::Loopback);
        assert_eq!(served_origin_for(&h, LOOPBACK), LOOPBACK);
        assert!(!is_forwarded(&h));
    }

    #[test]
    fn forwarded_host_with_control_or_whitespace_reads_as_loopback() {
        // Embedded space / tab / path segment have no business in a host[:port]
        // shape; the validator rejects each so the rendered `Location` can't
        // carry them. (CR/LF/NUL never reach us — hyper rejects them at the
        // HTTP layer.)
        for bad in [
            "host=demo.example.com evil",
            "host=demo.example.com\tevil",
            "host=demo.example.com/evil",
        ] {
            let h = forwarded(bad);
            assert_eq!(
                request_provenance(&h),
                RequestProvenance::Loopback,
                "expected loopback fallback for {bad:?}",
            );
        }
    }

    #[test]
    fn forwarded_host_with_url_delimiters_reads_as_loopback() {
        // `@` (userinfo), `\` (folded to `/` by the WHATWG URL parser for
        // http/https), and `?` / `#` (query / fragment) each let a rendered
        // `Location` resolve to a different authority than it looks like — e.g.
        // `https://trusted.example.com@evil.example.com` navigates to
        // `evil.example.com`. The validator rejects them, so the value falls
        // back to loopback rather than into the redirect target.
        for bad in [
            "host=trusted.example.com@evil.example.com",
            "host=demo.example.com\\evil.example.com",
            "host=demo.example.com?goto=evil",
            "host=demo.example.com#evil",
        ] {
            let h = forwarded(bad);
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
        let h = forwarded("proto=javascript;host=demo.example.com");
        assert_eq!(served_origin_for(&h, LOOPBACK), "https://demo.example.com");
    }

    #[test]
    fn ipv6_and_port_hosts_pass_validation() {
        // `$http_host` carries the raw Host, so legitimate shapes must pass:
        // host:port, and IPv6-in-brackets both unquoted (as nginx emits it) and
        // quoted (the RFC-compliant form, which we unquote).
        let with_port = forwarded("for=192.0.2.1;host=demo.example.com:8443;proto=https");
        assert_eq!(
            served_origin_for(&with_port, LOOPBACK),
            "https://demo.example.com:8443",
        );
        let ipv6_unquoted = forwarded("host=[::1]:8080");
        assert_eq!(
            served_origin_for(&ipv6_unquoted, LOOPBACK),
            "https://[::1]:8080"
        );
        let ipv6_quoted = forwarded("host=\"[::1]:8080\"");
        assert_eq!(
            served_origin_for(&ipv6_quoted, LOOPBACK),
            "https://[::1]:8080"
        );
    }
}
