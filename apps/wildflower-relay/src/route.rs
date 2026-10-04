//! Hostname → tunnel routing for the front.
//!
//! A public hostname `<label>.<domain>` names the rathole service
//! `[server.services.<label>]` in the relay's TOML. That service's `bind_addr`
//! is a loopback address which rathole listens on only while the device's
//! tunnel is up, so the front connects there and lets a refused connection mean
//! "device offline". The table is rebuilt from the same TOML whenever it
//! changes (see [`crate::watch`]) and swapped in whole.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, PoisonError, RwLock};

/// One routable device: the label it answers to and the loopback address its
/// rathole service binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub label: String,
    pub addr: SocketAddr,
}

/// Label → loopback `bind_addr`, as read from one version of the rathole
/// config.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RouteTable {
    addrs: HashMap<String, SocketAddr>,
}

impl RouteTable {
    /// Build the table from a parsed rathole config. Services the front cannot
    /// route are skipped with a warning rather than failing the whole reload:
    /// the name must be a lowercase DNS label, the service must be TCP, and
    /// `bind_addr` must be a literal loopback `ip:port` so nothing but this
    /// front reaches the tunnel.
    #[must_use]
    pub fn from_config(config: &rathole::Config) -> Self {
        let Some(server) = &config.server else {
            return Self::default();
        };
        let addrs = server
            .services
            .iter()
            .filter_map(|(name, service)| {
                // rathole's `ServiceType` is not exported; its default is
                // `tcp`, which is also what an omitted `type` parses to.
                if service.service_type != Default::default() {
                    tracing::warn!(service = %name, "not routable: only `type = \"tcp\"` services are fronted");
                    return None;
                }
                if !is_dns_label(name) {
                    tracing::warn!(service = %name, "not routable: service name is not a lowercase DNS label");
                    return None;
                }
                match service.bind_addr.parse::<SocketAddr>() {
                    Ok(addr) if addr.ip().is_loopback() => Some((name.clone(), addr)),
                    _ => {
                        tracing::warn!(
                            service = %name,
                            bind_addr = %service.bind_addr,
                            "not routable: bind_addr must be a loopback ip:port"
                        );
                        None
                    }
                }
            })
            .collect();
        Self { addrs }
    }

    /// Build a table directly from `(label, bind_addr)` pairs.
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

/// The front's view of routing: the public domain suffix (a relay-only
/// setting) plus the current [`RouteTable`], which the config watcher swaps
/// while connections are being routed.
#[derive(Debug)]
pub struct Router {
    domain: String,
    table: RwLock<Arc<RouteTable>>,
}

impl Router {
    /// `domain` is the suffix every public hostname ends in, e.g.
    /// `relay.example.com`. It is case-folded and stripped of surrounding
    /// dots.
    #[must_use]
    pub fn new(domain: &str, table: RouteTable) -> Self {
        Self {
            domain: domain.trim_matches('.').to_ascii_lowercase(),
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

    /// Resolve a public hostname (SNI or HTTP `Host`, without port) to its
    /// route, or `None` if it is outside the domain or names no service.
    #[must_use]
    pub fn resolve(&self, host: &str) -> Option<Route> {
        let label = label_for_host(host, &self.domain)?;
        let addr = *self.table().addrs.get(&label)?;
        Some(Route { label, addr })
    }
}

/// Map `<label>.<domain>` to `label`, case-folded. Anything else (a host
/// outside the suffix, the bare domain, or more than one label in front of
/// it) is `None`. A single trailing dot (`host.` FQDN form) is accepted.
#[must_use]
pub fn label_for_host(host: &str, domain: &str) -> Option<String> {
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let domain = domain.trim_matches('.').to_ascii_lowercase();
    let label = host.strip_suffix(&domain)?.strip_suffix('.')?;
    is_dns_label(label).then(|| label.to_owned())
}

/// A lowercase LDH label: 1–63 of `[a-z0-9-]`, not starting or ending in `-`.
fn is_dns_label(label: &str) -> bool {
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
    fn label_for_host_accepts_one_label_under_the_domain() {
        assert_eq!(
            label_for_host("abc123.relay.example.com", DOMAIN).as_deref(),
            Some("abc123")
        );
        assert_eq!(
            label_for_host("abc-123.relay.example.com.", DOMAIN).as_deref(),
            Some("abc-123")
        );
    }

    #[test]
    fn label_for_host_case_folds_host_and_domain() {
        assert_eq!(
            label_for_host("ABC.Relay.Example.COM", DOMAIN).as_deref(),
            Some("abc")
        );
        assert_eq!(
            label_for_host("abc.relay.example.com", ".RELAY.example.com.").as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn label_for_host_rejects_names_outside_the_suffix() {
        for host in [
            "abc.example.com",
            "abc.relay.example.org",
            "abc.evilrelay.example.com",
            "abcrelay.example.com",
            "relay.example.com",
            ".relay.example.com",
            "",
        ] {
            assert_eq!(label_for_host(host, DOMAIN), None, "{host:?}");
        }
    }

    #[test]
    fn label_for_host_rejects_multi_label_and_malformed_labels() {
        for host in [
            "a.b.relay.example.com",
            "-abc.relay.example.com",
            "abc-.relay.example.com",
            "a_b.relay.example.com",
            "a b.relay.example.com",
            &format!("{}.relay.example.com", "a".repeat(64)),
        ] {
            assert_eq!(label_for_host(host, DOMAIN), None, "{host:?}");
        }
    }

    async fn table_from_toml(toml: &str) -> RouteTable {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, toml).expect("write config");
        let config = rathole::Config::from_file(&path)
            .await
            .expect("config must parse");
        RouteTable::from_config(&config)
    }

    fn addr(s: &str) -> SocketAddr {
        s.parse().expect("socket addr")
    }

    #[tokio::test]
    async fn from_config_keeps_only_loopback_tcp_services_with_label_names() {
        let table = table_from_toml(
            r#"
[server]
bind_addr = "0.0.0.0:2333"
default_token = "t"

[server.services.good]
bind_addr = "127.0.0.1:5201"

[server.services.good-v6]
type = "tcp"
bind_addr = "[::1]:5202"

[server.services.udp]
type = "udp"
bind_addr = "127.0.0.1:5203"

[server.services.public]
bind_addr = "0.0.0.0:5204"

[server.services.hostname]
bind_addr = "localhost:5205"

[server.services.Upper]
bind_addr = "127.0.0.1:5206"

[server.services."dotted.name"]
bind_addr = "127.0.0.1:5207"
"#,
        )
        .await;
        assert_eq!(
            table,
            RouteTable::from_addrs([
                ("good".to_owned(), addr("127.0.0.1:5201")),
                ("good-v6".to_owned(), addr("[::1]:5202")),
            ])
        );
    }

    #[tokio::test]
    async fn example_config_routes_its_device() {
        let table = table_from_toml(include_str!("../relay.example.toml")).await;
        assert_eq!(table.len(), 1);
        let router = Router::new(DOMAIN, table);
        assert_eq!(
            router.resolve("wildflower-device-1.relay.example.com"),
            Some(Route {
                label: "wildflower-device-1".to_owned(),
                addr: addr("127.0.0.1:5201"),
            })
        );
    }

    #[test]
    fn router_resolves_known_labels_and_sees_replacements() {
        let a = addr("127.0.0.1:1");
        let b = addr("127.0.0.1:2");
        let router = Router::new(DOMAIN, RouteTable::from_addrs([("a".to_owned(), a)]));
        assert_eq!(
            router.resolve("A.relay.example.com").map(|r| r.addr),
            Some(a)
        );
        assert_eq!(router.resolve("b.relay.example.com"), None);

        router.replace(RouteTable::from_addrs([
            ("a".to_owned(), a),
            ("b".to_owned(), b),
        ]));
        assert_eq!(
            router.resolve("b.relay.example.com").map(|r| r.addr),
            Some(b)
        );
    }
}
