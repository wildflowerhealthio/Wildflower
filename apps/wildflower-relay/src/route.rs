//! Hostname routing for the front: the relay's own site or a tunnel.
//!
//! The relay's local hostnames (its domain itself) are served by the relay's
//! own site, which terminates TLS in-process. Any other public hostname
//! `<tunnel name>.<domain>` names a tunnel from `WILDFLOWER_RELAY_TUNNELS`.
//! Its loopback address is where rathole listens for that device, and only
//! while the device's tunnel is up, so the front connects there and lets a
//! refused connection mean "device offline". The [`RouteTable`] is built from
//! the same tunnel list that the rathole TOML is rendered from, and
//! [`Router::replace`] swaps in a new one whole.

use std::collections::{BTreeSet, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, PoisonError, RwLock};

use rathole_settings_rust::is_dns_label;

/// One routable tunnel: its name and the loopback address rathole binds for
/// it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub tunnel_name: String,
    pub addr: SocketAddr,
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

/// Tunnel name → loopback address rathole binds for that tunnel.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RouteTable {
    addrs: HashMap<String, SocketAddr>,
}

impl RouteTable {
    /// Build a table from `(tunnel name, loopback addr)` pairs, e.g.
    /// [`crate::ControlSettings::tunnel_addrs`].
    #[must_use]
    pub fn from_addrs(addrs: impl IntoIterator<Item = (String, SocketAddr)>) -> Self {
        Self {
            addrs: addrs.into_iter().collect(),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.addrs.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.addrs.is_empty()
    }
}

/// The front's view of routing: the public domain suffix and the relay's
/// local hostnames (relay-only settings) plus the current [`RouteTable`],
/// which [`Router::replace`] can swap while connections are being routed.
#[derive(Debug)]
pub struct Router {
    domain: String,
    local_hostnames: BTreeSet<String>,
    table: RwLock<Arc<RouteTable>>,
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
        table: RouteTable,
    ) -> Self {
        Self {
            domain: normalize_hostname(domain),
            local_hostnames: local_hostnames
                .into_iter()
                .map(|hostname| normalize_hostname(&hostname))
                .collect(),
            table: RwLock::new(Arc::new(table)),
        }
    }

    #[must_use]
    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// Swap in a new table. Connections already piped are unaffected; only
    /// lookups after the swap see it.
    pub fn replace(&self, table: RouteTable) {
        // A poisoned lock only means a writer panicked mid-swap of an `Arc`;
        // the value inside is still a whole table.
        *self.table.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(table);
    }

    fn table(&self) -> Arc<RouteTable> {
        Arc::clone(&self.table.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Resolve a public hostname (SNI or HTTP `Host`, without port) to where
    /// it goes, or `None` if it is outside the domain or names no tunnel. A
    /// local hostname is [`Destination::Local`] even if a tunnel of the same
    /// name exists, so no tunnel can take over the relay's own site.
    #[must_use]
    pub fn resolve(&self, host: &str) -> Option<Destination> {
        let hostname = fold_host(host);
        if self.local_hostnames.contains(&hostname) {
            return Some(Destination::Local(hostname));
        }
        let tunnel_name = tunnel_name_for_host(&hostname, &self.domain)?;
        let addr = *self.table().addrs.get(&tunnel_name)?;
        Some(Destination::Tunnel(Route { tunnel_name, addr }))
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

#[cfg(test)]
mod tests {
    use super::*;

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

    fn addr(s: &str) -> SocketAddr {
        s.parse().expect("socket addr")
    }

    fn tunnel_addr(destination: Option<Destination>) -> Option<SocketAddr> {
        match destination? {
            Destination::Tunnel(route) => Some(route.addr),
            Destination::Local(_) => None,
        }
    }

    #[test]
    fn router_resolves_known_tunnels_and_sees_replacements() {
        let a = addr("127.0.0.1:1");
        let b = addr("127.0.0.1:2");
        let router = Router::new(
            DOMAIN,
            [DOMAIN.to_owned()],
            RouteTable::from_addrs([("a".to_owned(), a)]),
        );
        assert_eq!(tunnel_addr(router.resolve("A.relay.example.com")), Some(a));
        assert_eq!(router.resolve("b.relay.example.com"), None);

        router.replace(RouteTable::from_addrs([
            ("a".to_owned(), a),
            ("b".to_owned(), b),
        ]));
        assert_eq!(tunnel_addr(router.resolve("b.relay.example.com")), Some(b));
    }

    #[test]
    fn router_resolves_local_hostnames_case_folded() {
        let router = Router::new(
            DOMAIN,
            [".Relay.Example.com.".to_owned()],
            RouteTable::default(),
        );
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
            RouteTable::from_addrs([("admin".to_owned(), addr("127.0.0.1:1"))]),
        );
        assert_eq!(
            router.resolve("admin.relay.example.com"),
            Some(Destination::Local("admin.relay.example.com".to_owned()))
        );
    }
}
