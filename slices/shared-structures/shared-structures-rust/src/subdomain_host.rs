//! The `<id>.<public_host>` subdomain shape — one source of truth shared by the
//! *producer* (the apps slice's internal-app launch redirect, which emits
//! `https://<id>.<public_host>/`) and the *consumer* (the host's
//! forwarded-request subdomain dispatch), with a round-trip test pinning that
//! they agree. See `docs/Origins/Explanation.md` for why the two must not drift.
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
/// part is exactly [`subdomain_host`], so [`try_split_subdomain`] is its inverse.
#[must_use]
pub fn subdomain_url(id: &str, public_host: &str) -> String {
    format!("https://{}/", subdomain_host(id, public_host))
}

/// Split an inbound host into its leftmost subdomain label when the remainder
/// equals `public_host` — the inverse of [`subdomain_host`]. Returns
/// `Some(label)` when `inbound_host` is exactly `<label>.<public_host>`, else
/// `None`. The shape is checked but the label is *not* validated against any
/// catalogue: callers filter it themselves, e.g.
/// `try_split_subdomain(host, public).filter(|id| is_known(id))`.
///
/// Case-insensitive on the host and **port-insensitive on both sides**: a
/// `:port` suffix is stripped from `inbound_host` *and* `public_host` before
/// comparison, so a deployment whose `public_host` carries a non-443 port
/// (e.g. `demo.example.com:8443`) still splits an inbound
/// `patient-browser.demo.example.com:8443`.
#[must_use]
pub fn try_split_subdomain(inbound_host: &str, public_host: &str) -> Option<String> {
    let inbound_lower = strip_port(inbound_host).to_ascii_lowercase();
    let public_lower = strip_port(public_host).to_ascii_lowercase();
    let (leftmost, rest) = inbound_lower.split_once('.')?;
    (rest == public_lower).then(|| leftmost.to_owned())
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
    /// emits, the consumer splits back. Feeding `subdomain_host`'s output back
    /// through `try_split_subdomain` must recover the id — including a
    /// `public_host` that carries a port.
    #[test]
    fn producer_output_round_trips_through_the_split() {
        for (id, host) in [
            ("patient-browser", "demo.example.com"),
            ("labs", "demo.example.com"),
            ("patient-browser", "demo.example.com:8443"),
        ] {
            assert_eq!(
                try_split_subdomain(&subdomain_host(id, host), host),
                Some(id.to_owned()),
                "{id}.{host} should split back to {id}",
            );
        }
    }

    /// `subdomain_url` is `https://<subdomain_host>/` — the same host shape
    /// the split accepts, wrapped in scheme + root path.
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

    /// A `public_host` configured WITH a port splits an inbound host whether or
    /// not the inbound carries the same port — the port-symmetry fix.
    #[test]
    fn configured_port_splits_symmetrically() {
        // Both sides carry the port.
        assert_eq!(
            try_split_subdomain(
                "patient-browser.demo.example.com:8443",
                "demo.example.com:8443"
            ),
            Some("patient-browser".to_owned()),
        );
        // Configured host has a port, inbound does not.
        assert_eq!(
            try_split_subdomain("patient-browser.demo.example.com", "demo.example.com:8443"),
            Some("patient-browser".to_owned()),
        );
        // Inbound has a port, configured host does not (the prior behavior).
        assert_eq!(
            try_split_subdomain("patient-browser.demo.example.com:8443", "demo.example.com"),
            Some("patient-browser".to_owned()),
        );
    }

    #[test]
    fn try_split_subdomain_handles_edge_cases() {
        // Happy path, case-insensitive on the whole host.
        assert_eq!(
            try_split_subdomain("Patient-Browser.DEMO.example.com", "demo.example.com"),
            Some("patient-browser".to_owned()),
        );
        // The split is shape-only — an unknown label still splits; the caller's
        // filter is what rejects it.
        assert_eq!(
            try_split_subdomain("admin.demo.example.com", "demo.example.com"),
            Some("admin".to_owned()),
        );
        let known: HashSet<&str> = ["patient-browser", "labs"].into_iter().collect();
        assert_eq!(
            try_split_subdomain("admin.demo.example.com", "demo.example.com")
                .filter(|id| known.contains(id.as_str())),
            None,
            "the caller's is-known filter is the authority on a valid-shape label",
        );
        // No dot at all — no subdomain.
        assert_eq!(try_split_subdomain("apex", "demo.example.com"), None);
        // Rest of host doesn't equal the configured public host.
        assert_eq!(
            try_split_subdomain("patient-browser.attacker.com", "demo.example.com"),
            None,
        );
        // IPv6 in brackets — no DNS subdomain to extract.
        assert_eq!(try_split_subdomain("[::1]:8080", "demo.example.com"), None);
    }
}
