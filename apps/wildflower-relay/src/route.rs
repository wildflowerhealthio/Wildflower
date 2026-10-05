//! Hostname routing for the front: the relay's own site or a tunnel.
//!
//! The relay's local hostnames (its domain itself and `admin.<domain>`) are
//! served by the relay's own site, which terminates TLS in-process. Any
//! other public hostname `<tunnel name>.<domain>` names a stored tunnel,
//! whose visitors the front puts into rathole's visitor queue for the
//! service of that name (see [`crate::tunnels`]). The [`RouteTable`] starts
//! with the tunnels stored at startup, as rathole's services do, and
//! [`Router::insert`] and [`Router::remove`] follow each tunnel created or
//! deleted, so a deleted tunnel stops routing as soon as it is deleted.

use std::collections::BTreeSet;
use std::sync::{PoisonError, RwLock, RwLockWriteGuard};

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

/// The names of the routable tunnels.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RouteTable {
    tunnel_names: BTreeSet<String>,
}

impl RouteTable {
    /// Build a table from tunnel names.
    #[must_use]
    pub fn from_names(tunnel_names: impl IntoIterator<Item = String>) -> Self {
        Self {
            tunnel_names: tunnel_names.into_iter().collect(),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.tunnel_names.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tunnel_names.is_empty()
    }
}

/// The front's view of routing: the public domain suffix and the relay's
/// local hostnames (relay-only settings) plus the current [`RouteTable`],
/// which [`Router::insert`] and [`Router::remove`] change while connections
/// are being routed.
#[derive(Debug)]
pub struct Router {
    domain: String,
    local_hostnames: BTreeSet<String>,
    table: RwLock<RouteTable>,
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
            table: RwLock::new(table),
        }
    }

    #[must_use]
    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// Route the tunnel named `tunnel_name`, for lookups from now on.
    pub fn insert(&self, tunnel_name: String) {
        self.table_mut().tunnel_names.insert(tunnel_name);
    }

    /// Stop routing the tunnel named `tunnel_name`. Connections already
    /// piped are unaffected; only lookups from now on miss it.
    pub fn remove(&self, tunnel_name: &str) {
        self.table_mut().tunnel_names.remove(tunnel_name);
    }

    fn table_mut(&self) -> RwLockWriteGuard<'_, RouteTable> {
        // A poisoned lock only means a writer panicked mid-insert or -remove
        // of one name; the set inside is still whole.
        self.table.write().unwrap_or_else(PoisonError::into_inner)
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
        self.table
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .tunnel_names
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

    fn tunnel(tunnel_name: &str) -> Option<Destination> {
        Some(Destination::Tunnel(Route {
            tunnel_name: tunnel_name.to_owned(),
        }))
    }

    #[test]
    fn router_resolves_known_tunnels_and_follows_inserts_and_removes() {
        let router = Router::new(
            DOMAIN,
            [DOMAIN.to_owned()],
            RouteTable::from_names(["a".to_owned()]),
        );
        assert_eq!(router.resolve("A.relay.example.com"), tunnel("a"));
        assert_eq!(router.resolve("b.relay.example.com"), None);

        router.insert("b".to_owned());
        assert_eq!(router.resolve("b.relay.example.com"), tunnel("b"));
        router.remove("a");
        assert_eq!(router.resolve("a.relay.example.com"), None);
        assert_eq!(router.resolve("b.relay.example.com"), tunnel("b"));
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
            RouteTable::from_names(["admin".to_owned()]),
        );
        assert_eq!(
            router.resolve("admin.relay.example.com"),
            Some(Destination::Local("admin.relay.example.com".to_owned()))
        );
    }
}
