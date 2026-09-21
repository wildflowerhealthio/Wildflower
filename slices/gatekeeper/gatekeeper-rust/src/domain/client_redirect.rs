//! Pure builders for the OAuth authorization-code **client callback URLs** — the
//! `redirect_uri` the user-agent is sent back to once the flow resolves, with the
//! success (`code` + `state`) or failure (`error` + `state`) query appended (RFC
//! 6749 §4.1.2 / §4.1.2.1) — plus the **allowlist resolution** that decides
//! whether a presented `redirect_uri` is one the client registered
//! ([`redirect_is_allowlisted`]).
//!
//! Pure `Url` string-building with no axum, store, or HTTP coupling, so both the
//! `/oauth` route surface and the Owner consent `action`
//! can hand back the *same* callback URL without either reaching into the other —
//! the consent action returns the URL it builds here, and the handler just renders
//! it. The resolution half lives here for the same reason: `/authorize` and the
//! consent read path must reach the same verdict about the same URI, so they
//! share one implementation (see
//! [`client_registration`](crate::domain::client_registration)).

use url::Url;

use crate::domain::client::{Client, RegisteredRedirectUri};
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::ports::SelfHostedRedirectTopology;

/// Build the URL that closes the authorization-code flow by redirecting the
/// user-agent back to the client's already-parsed `redirect_uri` with `code`
/// and `state` appended.
pub(crate) fn build_client_redirect_url(
    redirect_uri: &Url,
    code: &str,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", client_state);
    url.to_string()
}

/// Build the URL that closes the authorization-code flow with a failure by
/// redirecting the user-agent back to the client's already-parsed
/// `redirect_uri` with `error` and `state` appended (RFC 6749 §4.1.2.1).
pub(crate) fn build_client_error_redirect_url(
    redirect_uri: &Url,
    error: OAuthErrorCode,
    client_state: &str,
) -> String {
    let mut url = redirect_uri.clone();
    url.query_pairs_mut()
        .append_pair("error", error.as_ref())
        .append_pair("state", client_state);
    url.to_string()
}

/// Whether `parsed_redirect` matches any entry on `client`'s redirect allowlist,
/// each entry first resolved for **this request's provenance** via
/// [`resolve_registered_redirect`]. This is the one allowlist verdict: both
/// `/authorize` and the consent read path call it, so a prompt can never disagree
/// with the endpoint that parked it.
pub(crate) fn redirect_is_allowlisted(
    client: &Client,
    parsed_redirect: &Url,
    served: Option<&Url>,
    topology: Option<&SelfHostedRedirectTopology>,
) -> bool {
    client.redirect_uris.iter().any(|entry| {
        resolve_registered_redirect(entry, served, topology)
            .is_some_and(|resolved| resolved == *parsed_redirect)
    })
}

/// The concrete redirect URL a registered allowlist entry authorizes for this
/// request, or `None` when it can't be resolved (an app-relative entry on a
/// non-self-hosted client, or with an unparseable served origin). Both sides go
/// through the same URL normalizer, so the caller compares by `==`.
pub(crate) fn resolve_registered_redirect(
    entry: &RegisteredRedirectUri,
    served: Option<&Url>,
    topology: Option<&SelfHostedRedirectTopology>,
) -> Option<Url> {
    match entry {
        RegisteredRedirectUri::Absolute(url) => Some(url.clone()),
        RegisteredRedirectUri::AppRelative(path) => {
            let base = self_hosted_app_origin(served?, topology?)?;
            let resolved = base.join(path).ok()?;
            // An app-relative entry may only pick a path *under its own origin*.
            // `Url::join` on an http(s) base folds `\`→`/` and strips tab/newline,
            // so a tampered `/\evil.example` (which the parse-time `//` screen does
            // not catch) would otherwise resolve to `http://evil.example/`. This
            // origin-equality check is the authoritative same-origin guard; the
            // parse-time rejection only screens the most obvious form.
            (resolved.origin() == base.origin()).then_some(resolved)
        }
    }
}

/// The self-hosted app's own origin for the request's provenance, derived from
/// the request's served origin + the app's topology — so an app-relative entry
/// resolves to the *same-provenance* origin only:
/// - a **loopback** served origin (the on-device API) → same scheme + host, the
///   app's loopback port (`http://127.0.0.1:<port>`);
/// - any other served origin (the tunnel apex) → the app's subdomain under that
///   host, carrying the apex's own scheme and port (`https://<subdomain>.<apex>`
///   for the usual https:443 tunnel).
fn self_hosted_app_origin(served: &Url, topology: &SelfHostedRedirectTopology) -> Option<Url> {
    let host = served.host_str()?;
    if host_is_loopback(host) {
        let mut origin = served.clone();
        origin.set_port(Some(topology.port)).ok()?;
        Some(origin)
    } else {
        // Prepend the app's subdomain to the served apex, preserving the served
        // scheme AND port (`host_str` drops the port, so a non-443 apex would
        // otherwise resolve to the wrong origin). `set_host` also validates the
        // interpolated subdomain rather than trusting it into a URL string.
        let mut origin = served.clone();
        origin
            .set_host(Some(&format!("{}.{}", topology.subdomain, host)))
            .ok()?;
        Some(origin)
    }
}

/// Whether `host` (a URL host string) is a loopback address (`127.0.0.0/8`,
/// `::1`) or `localhost` — the provenance split for [`self_hosted_app_origin`].
fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // `host_str` brackets an IPv6 literal (`[::1]`); strip them so it parses.
    let unbracketed = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    unbracketed
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_redirect_appends_code_and_state() {
        let redirect = Url::parse("https://client.example/cb").unwrap();
        let url = build_client_redirect_url(&redirect, "the-code", "the-state");
        assert_eq!(
            url,
            "https://client.example/cb?code=the-code&state=the-state"
        );
    }

    #[test]
    fn success_redirect_preserves_existing_query() {
        let redirect = Url::parse("https://client.example/cb?keep=1").unwrap();
        let url = build_client_redirect_url(&redirect, "c", "s");
        assert_eq!(url, "https://client.example/cb?keep=1&code=c&state=s");
    }

    #[test]
    fn error_redirect_appends_error_and_state() {
        let redirect = Url::parse("https://client.example/cb").unwrap();
        let url =
            build_client_error_redirect_url(&redirect, OAuthErrorCode::AccessDenied, "the-state");
        assert_eq!(
            url,
            "https://client.example/cb?error=access_denied&state=the-state"
        );
    }
}

#[cfg(test)]
mod redirect_resolution_tests {
    use super::*;

    fn topology() -> SelfHostedRedirectTopology {
        SelfHostedRedirectTopology {
            port: 8090,
            subdomain: "medication".to_owned(),
        }
    }

    fn served(origin: &str) -> Url {
        Url::parse(origin).expect("served origin")
    }

    fn relative() -> RegisteredRedirectUri {
        RegisteredRedirectUri::AppRelative("/".to_owned())
    }

    /// A loopback served origin (the on-device API) resolves an app-relative
    /// entry to the app's own loopback origin — same scheme + host, the app port.
    #[test]
    fn relative_resolves_to_the_loopback_app_origin_on_device() {
        let resolved = resolve_registered_redirect(
            &relative(),
            Some(&served("http://127.0.0.1:8080")),
            Some(&topology()),
        );
        assert_eq!(
            resolved,
            Some(Url::parse("http://127.0.0.1:8090/").unwrap())
        );
    }

    /// A forwarded served origin (the tunnel apex) resolves the same entry to the
    /// app's subdomain under that apex, over https.
    #[test]
    fn relative_resolves_to_the_subdomain_origin_when_forwarded() {
        let resolved = resolve_registered_redirect(
            &relative(),
            Some(&served("https://ruth.wildflowerhealth.io")),
            Some(&topology()),
        );
        assert_eq!(
            resolved,
            Some(Url::parse("https://medication.ruth.wildflowerhealth.io/").unwrap())
        );
    }

    /// Provenance is matched: a loopback flow resolves only the loopback origin
    /// and a forwarded flow only the subdomain origin, so a redirect from the
    /// other provenance can't match.
    #[test]
    fn relative_matches_only_the_same_provenance_origin() {
        let loopback = resolve_registered_redirect(
            &relative(),
            Some(&served("http://127.0.0.1:8080")),
            Some(&topology()),
        )
        .unwrap();
        let forwarded = resolve_registered_redirect(
            &relative(),
            Some(&served("https://ruth.wildflowerhealth.io")),
            Some(&topology()),
        )
        .unwrap();
        assert_ne!(loopback, forwarded);
        assert_eq!(loopback.scheme(), "http");
        assert_eq!(forwarded.scheme(), "https");
    }

    /// Without topology (a non-self-hosted client) an app-relative entry resolves
    /// to nothing, so it can never match a request.
    #[test]
    fn relative_resolves_to_nothing_without_topology() {
        assert_eq!(
            resolve_registered_redirect(&relative(), Some(&served("http://127.0.0.1:8080")), None),
            None
        );
    }

    /// An unparseable served origin also resolves an app-relative entry to
    /// nothing (rather than trusting a bogus base).
    #[test]
    fn relative_resolves_to_nothing_without_a_served_origin() {
        assert_eq!(
            resolve_registered_redirect(&relative(), None, Some(&topology())),
            None
        );
    }

    /// A tampered app-relative entry that would swap the origin resolves to
    /// nothing. `Url::join` on an http(s) base folds `\`→`/` and strips
    /// tab/newline, so each of these joins to a foreign authority — the
    /// resolution-time origin-equality guard (not the parse-time `//` screen)
    /// rejects them. This is the same tampered-row threat the `//` parse test
    /// treats as in scope.
    #[test]
    fn relative_that_would_swap_origin_resolves_to_nothing() {
        for tampered in [
            "/\\evil.example",   // backslash → folded to `//`
            "/\\\\evil.example", // `\\` → authority
            "/\t/evil.example",  // tab stripped, then `//`
            "/\n/evil.example",  // newline stripped, then `//`
        ] {
            let entry = RegisteredRedirectUri::AppRelative(tampered.to_owned());
            assert_eq!(
                resolve_registered_redirect(
                    &entry,
                    Some(&served("https://ruth.wildflowerhealth.io")),
                    Some(&topology()),
                ),
                None,
                "tampered `{tampered}` must not resolve across the origin"
            );
            assert_eq!(
                resolve_registered_redirect(
                    &entry,
                    Some(&served("http://127.0.0.1:8080")),
                    Some(&topology()),
                ),
                None,
                "tampered `{tampered}` must not resolve across the loopback origin"
            );
        }
    }

    /// A same-origin path with a `\` that `Url::join` folds to `/` still resolves
    /// (the guard is on the *origin*, not the path), so a legitimate nested path
    /// keeps working.
    #[test]
    fn relative_same_origin_path_with_backslash_still_resolves() {
        let entry = RegisteredRedirectUri::AppRelative("/a\\b".to_owned());
        assert_eq!(
            resolve_registered_redirect(
                &entry,
                Some(&served("http://127.0.0.1:8080")),
                Some(&topology()),
            ),
            Some(Url::parse("http://127.0.0.1:8090/a/b").unwrap()),
        );
    }

    /// A tunnel apex served on a non-default port carries that port onto the
    /// resolved subdomain origin (`host_str` alone would drop it, leaving an
    /// implicit :443 that no real redirect could match).
    #[test]
    fn forwarded_apex_preserves_a_non_default_port() {
        let resolved = resolve_registered_redirect(
            &relative(),
            Some(&served("https://ruth.wildflowerhealth.io:8443")),
            Some(&topology()),
        );
        assert_eq!(
            resolved,
            Some(Url::parse("https://medication.ruth.wildflowerhealth.io:8443/").unwrap())
        );
    }

    /// An absolute entry resolves to itself regardless of served origin/topology.
    #[test]
    fn absolute_resolves_to_itself() {
        let url = Url::parse("https://app.example/cb").unwrap();
        let resolved =
            resolve_registered_redirect(&RegisteredRedirectUri::Absolute(url.clone()), None, None);
        assert_eq!(resolved, Some(url));
    }

    #[test]
    fn host_is_loopback_classifies_hosts() {
        assert!(host_is_loopback("127.0.0.1"));
        assert!(host_is_loopback("127.5.5.5"));
        assert!(host_is_loopback("localhost"));
        assert!(host_is_loopback("LocalHost"));
        assert!(host_is_loopback("[::1]"));
        assert!(!host_is_loopback("ruth.wildflowerhealth.io"));
        assert!(!host_is_loopback("192.168.1.9"));
    }
}
