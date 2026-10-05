//! Hostname routing for the front: the relay's own site or a tunnel.
//!
//! The relay's local hostnames (its domain itself and `admin.<domain>`) are
//! served by the relay's own site, which terminates TLS in-process. Any
//! other public hostname `<tunnel name>.<domain>` names a stored tunnel,
//! whose visitors the front puts into rathole's visitor queue for the
//! service of that name (see [`crate::tunnels`]). Which tunnels exist is
//! the tunnel store's cache, [`ServedTunnels`], so a deleted tunnel stops
//! routing as soon as it is deleted.

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::cached_store::ServedTunnels;

/// One routable tunnel: the rathole service its visitors are handed to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub tunnel_name: String,
}

/// Where a public hostname goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    /// One of the relay's local hostnames (case-folded, without a trailing
    /// dot): the relay terminates TLS and serves its own site.
    Local(String),
    /// A device's tunnel.
    Tunnel(Route),
}

/// The front's view of routing: the public domain suffix and the relay's
/// local hostnames (relay-only settings) plus the [`ServedTunnels`], which
/// change while connections are being routed.
#[derive(Debug)]
pub struct Router {
    domain: String,
    local_hostnames: BTreeSet<String>,
    tunnels: Arc<ServedTunnels>,
}

impl Router {
    /// `domain` is the suffix every tunnel's hostname ends in, e.g.
    /// `relay.example.com`; `local_hostnames` are the names the relay serves
    /// itself, e.g. [`crate::FrontSettings::local_hostnames`]. All are
    /// case-folded and stripped of surrounding dots.
    #[must_use]
    pub fn new(
        domain: &str,
        local_hostnames: impl IntoIterator<Item = String>,
        tunnels: Arc<ServedTunnels>,
    ) -> Self {
        Self {
            domain: normalize_hostname(domain),
            local_hostnames: local_hostnames
                .into_iter()
                .map(|hostname| normalize_hostname(&hostname))
                .collect(),
            tunnels,
        }
    }

    #[must_use]
    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// Resolve a public hostname (SNI or HTTP `Host`, without port) to where
    /// it goes, or `None` if it is outside the domain or names no served
    /// tunnel. A
    /// local hostname is [`Destination::Local`] even if a tunnel of the same
    /// name exists, so no tunnel can take over the relay's own site.
    #[must_use]
    pub fn resolve(&self, host: &str) -> Option<Destination> {
        let hostname = fold_host(host);
        if self.local_hostnames.contains(&hostname) {
            return Some(Destination::Local(hostname));
        }
        let tunnel_name = tunnel_name_for_host(&hostname, &self.domain)?;
        self.tunnels
            .contains(&tunnel_name)
            .then_some(Destination::Tunnel(Route { tunnel_name }))
    }
}

/// Case-fold a configured hostname and strip surrounding dots.
fn normalize_hostname(hostname: &str) -> String {
    hostname.trim_matches('.').to_ascii_lowercase()
}

/// Case-fold a requested host and strip a single trailing dot (`host.` FQDN
/// form).
fn fold_host(host: &str) -> String {
    host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase()
}

/// Map `<tunnel name>.<domain>` to the tunnel name, case-folded. The name is
/// exactly one DNS label; anything else (a host outside the suffix, the bare
/// domain, or more than one label in front of it) is `None`. A single
/// trailing dot (`host.` FQDN form) is accepted.
#[must_use]
pub fn tunnel_name_for_host(host: &str, domain: &str) -> Option<String> {
    let host = fold_host(host);
    let domain = normalize_hostname(domain);
    let name = host.strip_suffix(&domain)?.strip_suffix('.')?;
    is_dns_label(name).then(|| name.to_owned())
}

/// A lowercase LDH label: 1–63 of `[a-z0-9-]`, not starting or ending in `-`.
pub(crate) fn is_dns_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::stored_tunnel;

    const DOMAIN: &str = "relay.example.com";

    #[test]
    fn tunnel_name_for_host_accepts_one_name_under_the_domain() {
        assert_eq!(
            tunnel_name_for_host("abc123.relay.example.com", DOMAIN).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            tunnel_name_for_host("abc-123.relay.example.com.", DOMAIN).as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn tunnel_name_for_host_case_folds_host_and_domain() {
        assert_eq!(
            tunnel_name_for_host("ABC.Relay.Example.COM", DOMAIN).as_deref(),
            Some("abc")
        );
        assert_eq!(
            tunnel_name_for_host("abc.relay.example.com", ".RELAY.example.com.").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn tunnel_name_for_host_rejects_names_outside_the_suffix() {
        for host in [
            "abc.example.com",
            "abc.relay.example.org",
            "abc.evilrelay.example.com",
            "abcrelay.example.com",
            "relay.example.com",
            ".relay.example.com",
            "",
        ] {
            assert_eq!(tunnel_name_for_host(host, DOMAIN), None, "{host:?}");
        }
    }

    #[test]
    fn tunnel_name_for_host_rejects_multi_label_hosts_and_malformed_names() {
        for host in [
            "a.b.relay.example.com",
            "-abc.relay.example.com",
            "abc-.relay.example.com",
            "a_b.relay.example.com",
            "a b.relay.example.com",
            &format!("{}.relay.example.com", "a".repeat(64)),
        ] {
            assert_eq!(tunnel_name_for_host(host, DOMAIN), None, "{host:?}");
        }
    }

    fn served(names: &[&str]) -> Arc<ServedTunnels> {
        let tunnels: Vec<_> = names
            .iter()
            .map(|name| stored_tunnel(name).tunnel)
            .collect();
        Arc::new(ServedTunnels::new(&tunnels))
    }

    fn tunnel(tunnel_name: &str) -> Option<Destination> {
        Some(Destination::Tunnel(Route {
            tunnel_name: tunnel_name.to_owned(),
        }))
    }

    #[test]
    fn router_resolves_served_tunnels_as_they_are_inserted_and_removed() {
        let tunnels = served(&["a"]);
        let router = Router::new(DOMAIN, [DOMAIN.to_owned()], Arc::clone(&tunnels));
        assert_eq!(router.resolve("A.relay.example.com"), tunnel("a"));
        assert_eq!(router.resolve("b.relay.example.com"), None);

        tunnels.insert(&stored_tunnel("b").tunnel);
        assert_eq!(router.resolve("b.relay.example.com"), tunnel("b"));
        tunnels.remove("a");
        assert_eq!(router.resolve("a.relay.example.com"), None);
        assert_eq!(router.resolve("b.relay.example.com"), tunnel("b"));
    }

    #[test]
    fn router_resolves_local_hostnames_case_folded() {
        let router = Router::new(DOMAIN, [".Relay.Example.com.".to_owned()], served(&[]));
        for host in [
            "relay.example.com",
            "RELAY.example.com",
            "relay.example.com.",
        ] {
            assert_eq!(
                router.resolve(host),
                Some(Destination::Local(DOMAIN.to_owned())),
                "{host:?}"
            );
        }
        for host in ["example.com", ".relay.example.com", "relay.example.com.."] {
            assert_eq!(router.resolve(host), None, "{host:?}");
        }
    }

    #[test]
    fn local_hostnames_win_over_a_tunnel_of_the_same_name() {
        let router = Router::new(
            DOMAIN,
            [DOMAIN.to_owned(), "admin.relay.example.com".to_owned()],
            served(&["admin"]),
        );
        assert_eq!(
            router.resolve("admin.relay.example.com"),
            Some(Destination::Local("admin.relay.example.com".to_owned()))
        );
    }
}
