//! [`parse_public_addr`]: the `host:port` a device's rathole client dials,
//! checked the same way by the relay (`WILDFLOWER_RELAY_PUBLIC_CONTROL_ADDR`)
//! and by a device taking it from `GET /rathole` or from the user.

use std::net::Ipv6Addr;

use crate::is_dns_name;

/// Validate a `host:port` for clients to dial and normalise it: a DNS host
/// case-folded, an IPv6 host in its shortest form and the port without a
/// sign or leading zeros, so two spellings of one address compare equal. The
/// host is lowercase DNS labels (which covers an IPv4 address) or a bracketed
/// IPv6 address; the port is 1–65535.
///
/// # Errors
///
/// [`InvalidPublicAddr`] saying which part is wrong.
pub fn parse_public_addr(raw: &str) -> Result<String, InvalidPublicAddr> {
    let addr = raw.to_ascii_lowercase();
    let (host, port) = addr
        .rsplit_once(':')
        .ok_or(InvalidPublicAddr::NotHostPort)?;
    let port = port
        .parse::<u16>()
        .ok()
        .filter(|&port| port != 0)
        .ok_or_else(|| InvalidPublicAddr::Port {
            port: port.to_owned(),
        })?;
    let normalised_host = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(ipv6) => ipv6
            .parse::<Ipv6Addr>()
            .ok()
            .map(|ipv6| format!("[{ipv6}]")),
        None => is_dns_name(host).then(|| host.to_owned()),
    }
    .ok_or_else(|| InvalidPublicAddr::Host {
        host: host.to_owned(),
    })?;
    Ok(format!("{normalised_host}:{port}"))
}

/// Why a string isn't a `host:port` a rathole client can dial. The host and
/// port are as case-folded, not yet normalised.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidPublicAddr {
    /// There is no `:`.
    #[error("expected `host:port`")]
    NotHostPort,
    /// The port isn't 1–65535.
    #[error("port {port:?} is not 1–65535")]
    Port { port: String },
    /// The host isn't a DNS name or a bracketed IPv6 address.
    #[error("host {host:?} is not a DNS name or IP address")]
    Host { host: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_normalises_a_dns_or_ip_host_and_port() {
        for (raw, parsed) in [
            ("Relay.Example.com:2333", "relay.example.com:2333"),
            ("10.0.0.1:2333", "10.0.0.1:2333"),
            ("[::1]:2333", "[::1]:2333"),
            ("localhost:65535", "localhost:65535"),
            ("relay.example.com:02333", "relay.example.com:2333"),
            ("relay.example.com:+2333", "relay.example.com:2333"),
            ("[0:0:0:0:0:0:0:1]:2333", "[::1]:2333"),
            ("[2001:DB8::1]:2333", "[2001:db8::1]:2333"),
        ] {
            assert_eq!(parse_public_addr(raw).unwrap(), parsed, "{raw:?}");
        }
    }

    #[test]
    fn refuses_anything_else_saying_why() {
        for (raw, error) in [
            ("relay.example.com", InvalidPublicAddr::NotHostPort),
            (
                "relay.example.com:0",
                InvalidPublicAddr::Port {
                    port: "0".to_owned(),
                },
            ),
            (
                "relay.example.com:http",
                InvalidPublicAddr::Port {
                    port: "http".to_owned(),
                },
            ),
            (
                ":2333",
                InvalidPublicAddr::Host {
                    host: String::new(),
                },
            ),
            (
                "relay example.com:2333",
                InvalidPublicAddr::Host {
                    host: "relay example.com".to_owned(),
                },
            ),
            (
                "a:b:2333",
                InvalidPublicAddr::Host {
                    host: "a:b".to_owned(),
                },
            ),
            (
                "[bad:2333",
                InvalidPublicAddr::Host {
                    host: "[bad".to_owned(),
                },
            ),
            (
                "::1:2333",
                InvalidPublicAddr::Host {
                    host: "::1".to_owned(),
                },
            ),
        ] {
            assert_eq!(parse_public_addr(raw), Err(error), "{raw:?}");
        }
    }
}
