//! The PROXY protocol v2 header a relay front prepends to a tunnel connection
//! to carry the visitor's address past rathole, whose own peer is always the
//! in-process client on loopback. See
//! <https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt>, section 2.2.

use std::net::SocketAddr;

use anyhow::ensure;
use ppp::v2::{Addresses, Command, Header, PROTOCOL_PREFIX};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// The bytes of a v2 header ahead of its addresses: the 12-byte signature, the
/// version and command, the address family and protocol, and the big-endian
/// length of everything after these 16 bytes.
const FIXED_LENGTH: usize = 16;

/// Read the PROXY protocol v2 header off the front of `stream` when it starts
/// with one, and return the visitor's address the header names. A stream that
/// doesn't start with the header is left with every byte unread.
///
/// # Errors
///
/// Returns an error if the connection closes before sending anything, if
/// reading fails, or if the stream starts with the v2 signature (or as much of
/// it as has arrived) but not a well-formed header.
///
/// # Remarks
///
/// The first bytes are peeked, not read, so a stream with no header (a stock
/// rathole server sends none) reaches HTTP intact. Bytes that begin the
/// signature commit the stream to a header; no HTTP request starts with them,
/// since a client must not preface a request with an empty line (RFC 9112
/// §2.2). The header is then read whole and parsed by `ppp`.
///
/// Nothing here bounds how long the sender takes; the caller runs it under a
/// timeout.
pub(super) async fn read_client_address(
    stream: &mut TcpStream,
) -> anyhow::Result<Option<SocketAddr>> {
    let mut signature = [0; PROTOCOL_PREFIX.len()];
    let peeked = stream.peek(&mut signature).await?;
    ensure!(peeked > 0, "the connection closed before sending anything");
    if !PROTOCOL_PREFIX.starts_with(&signature[..peeked]) {
        return Ok(None);
    }

    let mut header = vec![0; FIXED_LENGTH];
    stream.read_exact(&mut header).await?;
    let address_length = u16::from_be_bytes([header[FIXED_LENGTH - 2], header[FIXED_LENGTH - 1]]);
    header.resize(FIXED_LENGTH + usize::from(address_length), 0);
    stream.read_exact(&mut header[FIXED_LENGTH..]).await?;
    let header = Header::try_from(header.as_slice())?;
    Ok(client_address(&header))
}

/// The source address a parsed `header` names. A `LOCAL` header (the front's
/// own connection, such as a health check) and a header for a Unix or
/// unspecified address name no visitor.
fn client_address(header: &Header<'_>) -> Option<SocketAddr> {
    if header.command == Command::Local {
        return None;
    }
    match header.addresses {
        Addresses::IPv4(ipv4) => Some(SocketAddr::from((ipv4.source_address, ipv4.source_port))),
        Addresses::IPv6(ipv6) => Some(SocketAddr::from((ipv6.source_address, ipv6.source_port))),
        Addresses::Unspecified | Addresses::Unix(_) => None,
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use ppp::v2::{Builder, Protocol, Version};
    use proptest::prelude::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    /// A connected loopback pair: the client end and the server end.
    pub(in crate::live_bindings) async fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let client = TcpStream::connect(listener.local_addr().expect("address"))
            .await
            .expect("connect");
        let (server, _) = listener.accept().await.expect("accept");
        (client, server)
    }

    /// A v2 `PROXY` header from `source` to a relay address of its family.
    pub(in crate::live_bindings) fn proxy_header(source: &str) -> Vec<u8> {
        let source: SocketAddr = source.parse().expect("source address");
        let destination: SocketAddr = match source {
            SocketAddr::V4(_) => "198.51.100.1:443",
            SocketAddr::V6(_) => "[2001:db8::443]:443",
        }
        .parse()
        .expect("destination address");
        Builder::with_addresses(
            Version::Two | Command::Proxy,
            Protocol::Stream,
            (source, destination),
        )
        .build()
        .expect("header")
    }

    /// Send `bytes` and close the sending half, then read the header off the
    /// server end. Returns what the reader made of it and the bytes it left.
    async fn read_after_sending(bytes: &[u8]) -> (anyhow::Result<Option<SocketAddr>>, Vec<u8>) {
        let (mut client, mut server) = connected_pair().await;
        client.write_all(bytes).await.expect("write");
        client.shutdown().await.expect("shutdown");
        let client_address = read_client_address(&mut server).await;
        let mut rest = Vec::new();
        if client_address.is_ok() {
            server.read_to_end(&mut rest).await.expect("read the rest");
        }
        (client_address, rest)
    }

    #[tokio::test]
    async fn a_proxy_header_is_read_and_stripped() {
        for source in ["192.0.2.1:4711", "[2001:db8::1]:4711"] {
            let mut bytes = proxy_header(source);
            bytes.extend_from_slice(b"GET / HTTP/1.1\r\n\r\n");

            let (client_address, rest) = read_after_sending(&bytes).await;

            assert_eq!(
                client_address.expect("a well-formed header"),
                Some(source.parse().unwrap())
            );
            assert_eq!(rest, b"GET / HTTP/1.1\r\n\r\n", "{source}");
        }
    }

    #[tokio::test]
    async fn a_stream_without_a_header_is_left_intact() {
        let (client_address, rest) = read_after_sending(b"GET / HTTP/1.1\r\n\r\n").await;

        assert_eq!(client_address.expect("no header is not an error"), None);
        assert_eq!(rest, b"GET / HTTP/1.1\r\n\r\n");
    }

    #[tokio::test]
    async fn a_local_header_names_no_visitor() {
        let header = Builder::with_addresses(
            Version::Two | Command::Local,
            Protocol::Unspecified,
            Addresses::Unspecified,
        )
        .build()
        .expect("header");

        let (client_address, rest) = read_after_sending(&header).await;

        assert_eq!(client_address.expect("a well-formed header"), None);
        assert!(rest.is_empty());
    }

    #[tokio::test]
    async fn a_truncated_or_malformed_header_is_an_error() {
        let header = proxy_header("192.0.2.1:4711");
        let mut wrong_version = header.clone();
        wrong_version[12] = 0x11;
        for bytes in [
            &header[..5],
            &header[..FIXED_LENGTH],
            &header[..header.len() - 1],
            &wrong_version[..],
        ] {
            let (client_address, _) = read_after_sending(bytes).await;
            assert!(client_address.is_err(), "{bytes:?}");
        }
        let (client_address, _) = read_after_sending(b"").await;
        assert!(client_address.is_err(), "an empty connection");
    }

    proptest! {
        /// Whatever follows some or all of the signature, the reader answers
        /// without panicking: a header that parses names the address `ppp`
        /// reads from it, and anything else is either passed through or an
        /// error the caller closes the connection on.
        #[test]
        fn any_bytes_after_a_signature_prefix_are_read_without_panicking(
            signature_length in 1..=PROTOCOL_PREFIX.len(),
            after_signature in proptest::collection::vec(any::<u8>(), 0..64),
        ) {
            let mut bytes = PROTOCOL_PREFIX[..signature_length].to_vec();
            bytes.extend_from_slice(&after_signature);
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let (read_address, _) = runtime.block_on(read_after_sending(&bytes));
            if let Ok(Some(read_address)) = read_address {
                let header = Header::try_from(bytes.as_slice()).expect("it parsed once");
                prop_assert_eq!(client_address(&header), Some(read_address));
            }
        }

        /// A stream that doesn't open with the signature is passed through
        /// with every byte intact.
        #[test]
        fn a_stream_not_opening_with_the_signature_is_passed_through(
            first in any::<u8>().prop_filter("not the signature's first byte", |b| *b != b'\r'),
            rest in proptest::collection::vec(any::<u8>(), 0..64),
        ) {
            let mut bytes = vec![first];
            bytes.extend_from_slice(&rest);
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            let (read_address, unread) = runtime.block_on(read_after_sending(&bytes));
            prop_assert_eq!(read_address.ok(), Some(None));
            prop_assert_eq!(unread, bytes);
        }
    }
}
