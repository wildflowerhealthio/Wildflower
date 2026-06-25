//! The `<id>.<public_host>` subdomain shape — one source of truth shared by
//! the *producer* (the apps slice's internal-app launch redirect) and the
//! *consumer* (the host's forwarded-request subdomain dispatch).
//!
//! A launched internal app reachable through the relay lives at
//! `https://<id>.<public_host>/`. The launch handler emits that URL; the
//! host's subdomain-dispatch middleware matches the same shape on inbound
//! forwarded requests. Those two routines must agree exactly — if the join
//! ever changed on one side only, forwarded launches would fall through to
//! the API, unreachable from a remote browser, with no error. They used to
//! be two independent string routines in two different crates; this module
//! makes them one definition with a round-trip test pinning the agreement.
//!
//! Behind the `subdomain-url` feature: pure string code, no extra deps, so a
//! crate that only needs the shape doesn't pull anything new.

/// Build the public subdomain host label-stack: `<id>.<public_host>` — the
/// bare host (no scheme, no port, no path), i.e. the shape an inbound
/// forwarded `Forwarded` host carries.
#[must_use]
pub fn subdomain_host(id: &str, public_host: &str) -> String {
    format!("{id}.{public_host}")
}

/// Build the full public subdomain launch URL `https://<id>.<public_host>/`
/// — the `Location` a forwarded (remote) caller is redirected to. The host
/// part is exactly [`subdomain_host`], so [`match_subdomain`] is its inverse.
#[must_use]
pub fn subdomain_url(id: &str, public_host: &str) -> String {
    format!("https://{}/", subdomain_host(id, public_host))
}

/// Match an inbound host against `<id>.<public_host>` — the inverse of
/// [`subdomain_host`]. Returns `Some(id)` when `inbound_host` is exactly
/// `<id>.<public_host>` for some `id` accepted by `is_known_id`.
///
/// Case-insensitive on the host and **port-insensitive on both sides**: a
/// `:port` suffix is stripped from `inbound_host` *and* `public_host` before
/// comparison, so a deployment whose `public_host` carries a non-443 port
/// (e.g. `demo.example.com:8443`) still matches an inbound
/// `patient-browser.demo.example.com:8443`.
///
/// `is_known_id` is a callback rather than the catalogue directly so this
/// function stays pure-string and easy to unit-test.
#[must_use]
pub fn match_subdomain(
    inbound_host: &str,
    public_host: &str,
    is_known_id: impl Fn(&str) -> bool,
) -> Option<String> {
    let inbound_lower = strip_port(inbound_host).to_ascii_lowercase();
    let public_lower = strip_port(public_host).to_ascii_lowercase();
    let (leftmost, rest) = inbound_lower.split_once('.')?;
    if rest != public_lower {
        return None;
    }
    if !is_known_id(leftmost) {
        return None;
    }
    Some(leftmost.to_owned())
}

/// Strip an optional `:port` suffix. IPv6 has its own bracketed form
/// (`[::1]:8080`) which only contains a `:` inside the brackets, but a public
/// host is normally a DNS name, so a single rightmost `:` after the bracket
/// closes (or in a name with no `[`) is the port.
fn strip_port(host: &str) -> &str {
    match (host.rfind(']'), host.rfind(':')) {
        // IPv6 with port: `[…]:port` — strip after the bracket-closing `]`.
        (Some(bracket), Some(colon)) if colon > bracket => &host[..colon],
        // IPv6 without port: keep verbatim.
        (Some(_), _) => host,
        // DNS name with port.
        (None, Some(colon)) => &host[..colon],
        // DNS name without port.
        (None, None) => host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The contract this module exists to enforce: every host the producer
    /// emits, the matcher routes. Feeding `subdomain_host`'s output back
    /// through `match_subdomain` must recover the id — including a
    /// `public_host` that carries a port.
    #[test]
    fn producer_output_round_trips_through_the_matcher() {
        for (id, host) in [
            ("patient-browser", "demo.example.com"),
            ("labs", "demo.example.com"),
            ("patient-browser", "demo.example.com:8443"),
        ] {
            assert_eq!(
                match_subdomain(&subdomain_host(id, host), host, |candidate| candidate == id),
                Some(id.to_owned()),
                "{id}.{host} should route back to {id}",
            );
        }
    }

    /// `subdomain_url` is `https://<subdomain_host>/` — the same host shape
    /// the matcher accepts, wrapped in scheme + root path.
    #[test]
    fn subdomain_url_wraps_the_host_shape() {
        assert_eq!(
            subdomain_url("patient-browser", "demo.example.com"),
            "https://patient-browser.demo.example.com/",
        );
        assert_eq!(
            subdomain_host("patient-browser", "demo.example.com"),
            "patient-browser.demo.example.com",
        );
    }

    /// A `public_host` configured WITH a port matches an inbound host whether
    /// or not the inbound carries the same port — the port-symmetry fix.
    #[test]
    fn configured_port_matches_symmetrically() {
        let known = |id: &str| id == "patient-browser";
        // Both sides carry the port.
        assert_eq!(
            match_subdomain(
                "patient-browser.demo.example.com:8443",
                "demo.example.com:8443",
                known,
            ),
            Some("patient-browser".to_owned()),
        );
        // Configured host has a port, inbound does not.
        assert_eq!(
            match_subdomain(
                "patient-browser.demo.example.com",
                "demo.example.com:8443",
                known,
            ),
            Some("patient-browser".to_owned()),
        );
        // Inbound has a port, configured host does not (the prior behavior).
        assert_eq!(
            match_subdomain(
                "patient-browser.demo.example.com:8443",
                "demo.example.com",
                known,
            ),
            Some("patient-browser".to_owned()),
        );
    }

    #[test]
    fn match_subdomain_handles_edge_cases() {
        let known: HashSet<&str> = ["patient-browser", "labs"].into_iter().collect();
        let is_known = |id: &str| known.contains(id);

        // Happy path, case-insensitive on the whole host.
        assert_eq!(
            match_subdomain("Patient-Browser.DEMO.example.com", "demo.example.com", is_known),
            Some("patient-browser".to_owned()),
        );
        // No dot at all — no subdomain.
        assert_eq!(match_subdomain("apex", "demo.example.com", is_known), None);
        // Leftmost label not in the catalogue.
        assert_eq!(
            match_subdomain("admin.demo.example.com", "demo.example.com", is_known),
            None,
        );
        // Rest of host doesn't equal the configured public host.
        assert_eq!(
            match_subdomain("patient-browser.attacker.com", "demo.example.com", is_known),
            None,
        );
        // IPv6 in brackets — no DNS subdomain to extract.
        assert_eq!(match_subdomain("[::1]:8080", "demo.example.com", is_known), None);
    }
}
