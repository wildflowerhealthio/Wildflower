//! Forwarding-header provenance — `request_provenance` and the typed
//! [`served_base_url_for`], the single source of truth for a request's served
//! base URL (loopback vs. the forwarded public base URL). Consumers —
//! gatekeeper's token/discovery URLs and apps-rust's launch redirect — resolve
//! through it so they can't drift. See `docs/Origins/Explanation.md` for the
//! model; this module owns the parsing contract and validation below.
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
//! it may carry a `:port` and isn't normalized), making it attacker-influenced,
//! and it lands directly in a `Location` the browser follows. As
//! defense-in-depth, [`safe_host`] / [`safe_scheme`] reject the characters and
//! schemes that could redirect to a different authority.
//!
//! A `Forwarded` header that fails validation is **not** treated as unforwarded.
//! Only the *absence* of the header reads as loopback: the trusted front sets a
//! `Forwarded` header on every relayed request, so a header present in any form
//! means the request came through the front, and a malformed one is *rejected*
//! ([`request_provenance`] returns `None`, the caller `500`s) rather than
//! collapsed to loopback. Collapsing a malformed forwarded request to loopback
//! would let a tunnel-relayed remote caller be mistaken for a direct-local one —
//! e.g. handed the host owner token (`is_forwarded` gates that trust). See
//! `docs/Origins/Explanation.md`.

use axum::http::HeaderMap;
use url::Url;

/// Whether a request was forwarded by the trusted front or arrived directly
/// over loopback. Two callers (which-origin + how-to-dispatch) read from one
/// shape so they can't disagree on the same headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestProvenance {
    /// Direct loopback caller — **no `Forwarded` header at all**. A header that
    /// is present but unresolvable (missing/invalid `host`) is *not* Loopback; it
    /// is rejected as `None`, so a relayed caller can never be mistaken for a
    /// local one. See [`request_provenance`].
    Loopback,
    /// Relayed by the trusted front. `base_url` is the `{scheme}://{host}` the
    /// client actually used, parsed into a [`Url`] (root path).
    Forwarded { base_url: Url },
}

/// Single read of the `Forwarded` header — both "is this forwarded?" and
/// "what's the forwarded base URL?" derive from this.
///
/// The **absence** of the `Forwarded` header is the only genuine-loopback
/// signal: the trusted front sets a non-empty `Forwarded` on every relayed
/// request, and a direct-local caller sets none. So:
///
/// - header **absent** → `Some(`[`RequestProvenance::Loopback`]`)`
/// - header present, resolvable → `Some(`[`RequestProvenance::Forwarded`]`)`
/// - header present, but the `host` is missing, fails [`safe_host`], or won't
///   parse as a URL authority → `None`
///
/// The last case returns `None`, **not** `Loopback`: a malformed header still
/// came through the front, so collapsing it to loopback would hand a relayed
/// caller local trust (see the module docs). A missing/invalid `proto` defaults
/// to `https` — only the `host` is load-bearing for the forwarded/loopback split.
pub fn request_provenance(headers: &HeaderMap) -> Option<RequestProvenance> {
    let Some(forwarded) = headers.get("forwarded") else {
        return Some(RequestProvenance::Loopback);
    };
    // Header present ⇒ forwarded. Resolve a base URL from the last element.
    forwarded
        .to_str()
        .ok()
        .and_then(last_forwarded_element)
        .and_then(|element| {
            let host = forwarded_param(element, "host").and_then(safe_host)?;
            let scheme = forwarded_param(element, "proto").and_then(safe_scheme)?;
            Url::parse(&format!("{scheme}://{host}")).ok()
        })
        .map(|base_url| RequestProvenance::Forwarded { base_url })
}

/// The base URL a given request expects its answer to come from. Forwarded
/// requests resolve to the `{proto}://{host}` from the `Forwarded` header;
/// loopback requests (**no** `Forwarded` header) fall back to
/// `loopback_base_url`. A forwarded request whose header fails validation
/// returns `None` (the caller `500`s), never a loopback fallback — see
/// [`request_provenance`].
pub fn served_base_url_for(headers: &HeaderMap, loopback_base_url: &Url) -> Option<Url> {
    match request_provenance(headers)? {
        RequestProvenance::Forwarded { base_url } => Some(base_url),
        RequestProvenance::Loopback => Some(loopback_base_url.clone()),
    }
}

/// Whether the request was forwarded by the trusted front, as a bool — `true`
/// iff a `Forwarded` header is **present** (in any form).
///
/// SECURITY: keys on presence alone, *not* on [`safe_host`], so a malformed
/// `Host` can't flip a relayed caller to direct-local and let it inherit the
/// `!is_forwarded`-gated local-owner trust (e.g. the desktop host's owner-token
/// injection). `true` exactly when [`request_provenance`] is not `Some(Loopback)`.
pub fn is_forwarded(headers: &HeaderMap) -> bool {
    headers.contains_key("forwarded")
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

    fn loopback() -> Url {
        url("http://127.0.0.1:5173")
    }

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

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
        assert_eq!(
            served_base_url_for(&h, &loopback()),
            Some(url("http://emr.example.com")),
        );
    }

    #[test]
    fn forwarded_origin_fails_without_a_proto_param() {
        let h = forwarded("for=192.0.2.1;host=emr.example.com");
        assert_eq!(served_base_url_for(&h, &loopback()), None,);
    }

    #[test]
    fn no_forwarded_header_falls_back_to_the_loopback_base_url() {
        assert_eq!(
            served_base_url_for(&HeaderMap::new(), &loopback()),
            Some(loopback()),
        );
    }

    #[test]
    fn forwarded_header_without_a_host_param_is_rejected_not_loopback() {
        // Present header, no `host` param → forwarded but unresolvable → `None`.
        let h = forwarded("for=192.0.2.1;proto=https");
        assert_eq!(request_provenance(&h), None);
        assert_eq!(served_base_url_for(&h, &loopback()), None);
        assert!(is_forwarded(&h));
    }

    #[test]
    fn request_provenance_keys_on_a_valid_forwarded_host() {
        assert_eq!(
            request_provenance(&HeaderMap::new()),
            Some(RequestProvenance::Loopback),
        );
        let h = forwarded("proto=https;host=demo.example.com");
        assert_eq!(
            request_provenance(&h),
            Some(RequestProvenance::Forwarded {
                base_url: url("https://demo.example.com"),
            }),
        );
    }

    #[test]
    fn param_names_are_case_insensitive() {
        // RFC 7239 parameter names are case-insensitive.
        let h = forwarded("Proto=https;Host=demo.example.com");
        assert_eq!(
            served_base_url_for(&h, &loopback()),
            Some(url("https://demo.example.com")),
        );
    }

    #[test]
    fn reads_the_last_element_of_a_proxy_chain() {
        // `$proxy_add_forwarded` appends our hop as the last element, so the
        // trusted `host`/`proto` are rightmost; a client-supplied element ahead
        // of it (here a spoofed host) must not win.
        let h = forwarded(
            "for=203.0.113.9;host=spoof.example.com, for=192.0.2.1;host=real.example.com;proto=https",
        );
        assert_eq!(
            served_base_url_for(&h, &loopback()),
            Some(url("https://real.example.com")),
        );
    }

    #[test]
    fn forwarded_host_that_passes_validation_but_fails_url_parse_reads_as_none() {
        // `:8080` clears `safe_host` but isn't a valid URL authority, so
        // `Url::parse` rejects it → `None`; the header is present, so `is_forwarded`.
        let h = forwarded("host=:8080");
        assert_eq!(request_provenance(&h), None);
        assert_eq!(served_base_url_for(&h, &loopback()), None);
        assert!(is_forwarded(&h));
    }

    #[test]
    fn is_forwarded_agrees_with_request_provenance() {
        // `is_forwarded` skips the resolve, so pin that it still agrees with
        // `request_provenance` (`true` iff not `Some(Loopback)`) across every
        // shape — valid, absent, host-less, empty, chains, delimiters, unparseable.
        let cases: [&[(&str, &str)]; 8] = [
            &[],
            &[("forwarded", "proto=https;host=demo.example.com")],
            &[("forwarded", "for=192.0.2.1;host=demo.example.com")],
            &[("forwarded", "for=192.0.2.1;proto=https")],
            &[("forwarded", "proto=https;host=")],
            &[("forwarded", "host=a.example.com, host=b.example.com")],
            &[("forwarded", "host=trusted.example.com@evil.example.com")],
            &[("forwarded", "host=:8080")],
        ];
        for pairs in cases {
            let h = headers(pairs);
            assert_eq!(
                is_forwarded(&h),
                !matches!(request_provenance(&h), Some(RequestProvenance::Loopback)),
                "is_forwarded disagreed with request_provenance for {pairs:?}",
            );
        }
    }

    #[test]
    fn empty_forwarded_host_is_rejected_not_loopback() {
        // Empty `host` would render `Location: https://` (no authority) → rejected.
        let h = forwarded("proto=https;host=");
        assert_eq!(request_provenance(&h), None);
        assert_eq!(served_base_url_for(&h, &loopback()), None);
        assert!(is_forwarded(&h));
    }

    #[test]
    fn forwarded_host_with_control_or_whitespace_is_rejected_not_loopback() {
        // Space / tab / path segment don't belong in a host[:port]; the validator
        // rejects each. (CR/LF/NUL never reach us — hyper rejects them first.)
        for bad in [
            "host=demo.example.com evil",
            "host=demo.example.com\tevil",
            "host=demo.example.com/evil",
        ] {
            let h = forwarded(bad);
            assert_eq!(
                request_provenance(&h),
                None,
                "expected rejection (not loopback) for {bad:?}",
            );
            assert!(
                is_forwarded(&h),
                "still forwarded (header present) for {bad:?}"
            );
        }
    }

    #[test]
    fn forwarded_host_with_url_delimiters_is_rejected_not_loopback() {
        // `@` (userinfo), `\` (folded to `/` by the WHATWG URL parser), and
        // `?`/`#` each let a `Location` resolve to a different authority than it
        // looks like — `https://trusted.example.com@evil.example.com` navigates to
        // `evil.example.com`. The validator rejects them.
        for bad in [
            "host=trusted.example.com@evil.example.com",
            "host=demo.example.com\\evil.example.com",
            "host=demo.example.com?goto=evil",
            "host=demo.example.com#evil",
        ] {
            let h = forwarded(bad);
            assert_eq!(
                request_provenance(&h),
                None,
                "expected rejection (not loopback) for {bad:?}",
            );
            assert_eq!(served_base_url_for(&h, &loopback()), None);
            assert!(
                is_forwarded(&h),
                "still forwarded (header present) for {bad:?}"
            );
        }
    }

    #[test]
    fn is_forwarded_stays_true_for_a_present_but_malformed_forwarded_header() {
        // SECURITY REGRESSION GUARD: a malformed `Host` must not flip `is_forwarded`
        // to `false`, or a tunnel-relayed caller (which arrives over loopback) would
        // inherit the `!is_forwarded`-gated owner trust. See the `is_forwarded` doc.
        for malformed in [
            "host=",                                     // empty host
            "for=192.0.2.1;proto=https",                 // no host param
            "host=demo.example.com evil",                // whitespace
            "host=trusted.example.com@evil.example.com", // userinfo smuggling
            "host=demo.example.com/evil",                // path delimiter
            "host=:8080",                                // unparseable authority
            "junk-with-no-recognized-params",            // not even a host key
        ] {
            let h = forwarded(malformed);
            assert!(
                is_forwarded(&h),
                "a present `Forwarded` header must read as forwarded: {malformed:?}",
            );
            // And the resolver rejects it rather than mistaking it for loopback.
            assert_ne!(
                request_provenance(&h),
                Some(RequestProvenance::Loopback),
                "a present `Forwarded` header must never read as Loopback: {malformed:?}",
            );
        }
        // Only the *absence* of the header is loopback.
        assert!(!is_forwarded(&HeaderMap::new()));
        assert_eq!(
            request_provenance(&HeaderMap::new()),
            Some(RequestProvenance::Loopback),
        );
    }

    #[test]
    fn unknown_forwarded_proto_fails_to_parse() {
        // `javascript:`/`file:` etc. must not land in a `Location` the browser
        // follows — an unknown scheme reverts to the safe https default.
        let h = forwarded("proto=javascript;host=demo.example.com;proto=https");
        assert_eq!(served_base_url_for(&h, &loopback()), None,);
    }

    #[test]
    fn ipv6_and_port_hosts_pass_validation() {
        // `$http_host` carries the raw Host, so legitimate shapes must pass:
        // host:port, and IPv6-in-brackets both unquoted (as nginx emits it) and
        // quoted (the RFC-compliant form, which we unquote).
        let with_port = forwarded("for=192.0.2.1;host=demo.example.com:8443;proto=https");
        assert_eq!(
            served_base_url_for(&with_port, &loopback()),
            Some(url("https://demo.example.com:8443")),
        );
        let ipv6_unquoted = forwarded("host=[::1]:8080;proto=http");
        assert_eq!(
            served_base_url_for(&ipv6_unquoted, &loopback()),
            Some(url("http://[::1]:8080")),
        );
        let ipv6_quoted = forwarded("host=\"[::1]:8080\";proto=http");
        assert_eq!(
            served_base_url_for(&ipv6_quoted, &loopback()),
            Some(url("http://[::1]:8080")),
        );
    }
}
