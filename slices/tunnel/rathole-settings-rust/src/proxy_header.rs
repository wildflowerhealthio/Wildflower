//! The PROXY protocol v2 header the relay's front sends to the device ahead of
//! the visitor's bytes. It carries the visitor's address, which the device would
//! otherwise never see: to the device every connection comes from its own
//! rathole client. The device's tests build their headers here too, so they
//! read what the relay writes.

use std::io;
use std::net::SocketAddr;

use ppp::v2::{Builder, Command, Protocol, Version};

/// PROXY v2 `PROXY`/`STREAM` header for a visitor at `source` reaching the
/// relay at `destination`. IPv4-mapped IPv6 addresses (from a dual-stack
/// listener) are unmapped first; if the families still differ the IPv4 side
/// is mapped so both are IPv6, which the header requires.
pub fn proxy_header(source: SocketAddr, destination: SocketAddr) -> io::Result<Vec<u8>> {
    let mut source = unmapped(source);
    let mut destination = unmapped(destination);
    if source.is_ipv4() != destination.is_ipv4() {
        source = as_ipv6(source);
        destination = as_ipv6(destination);
    }
    Builder::with_addresses(
        Version::Two | Command::Proxy,
        Protocol::Stream,
        (source, destination),
    )
    .build()
}

/// `::ffff:a.b.c.d` becomes `a.b.c.d`; anything else is unchanged.
fn unmapped(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

/// `a.b.c.d` becomes `::ffff:a.b.c.d`; IPv6 is unchanged.
fn as_ipv6(addr: SocketAddr) -> SocketAddr {
    match addr {
        SocketAddr::V4(v4) => SocketAddr::new(v4.ip().to_ipv6_mapped().into(), v4.port()),
        SocketAddr::V6(_) => addr,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_header_unmaps_and_aligns_address_families() {
        let parse = |header: &[u8]| {
            let parsed = ppp::v2::Header::try_from(header).expect("valid header");
            (parsed.command, parsed.addresses)
        };
        let v4 = proxy_header(
            "198.51.100.7:50000".parse().unwrap(),
            "10.0.0.2:443".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(
            parse(&v4),
            (
                Command::Proxy,
                ppp::v2::IPv4::new([198, 51, 100, 7], [10, 0, 0, 2], 50000, 443).into()
            )
        );

        let mapped = proxy_header(
            "[::ffff:198.51.100.7]:50000".parse().unwrap(),
            "[::ffff:10.0.0.2]:443".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(mapped, v4);

        let mixed = proxy_header(
            "[2001:db8::1]:50000".parse().unwrap(),
            "10.0.0.2:443".parse().unwrap(),
        )
        .unwrap();
        assert!(matches!(parse(&mixed).1, ppp::v2::Addresses::IPv6(_)));
    }
}
