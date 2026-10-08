//! The PROXY protocol v2 header the relay writes ahead of a visitor's
//! connection, to carry the visitor's address past rathole, which hands the
//! connection over with no address of its own. See
//! <https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt>, section 2.2.

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};

use anyhow::ensure;
use ppp::v2::{Addresses, Command, Header, PROTOCOL_PREFIX};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

/// The bytes of a v2 header ahead of its addresses: the 12-byte signature, the
/// version and command, the address family and protocol, and the big-endian
/// length of everything after these 16 bytes.
const FIXED_LENGTH: usize = 16;

/// Read the PROXY protocol v2 header off the front of `stream` when it starts
/// with one, and return the stream with the visitor's address the header
/// names. A stream that doesn't start with the header is returned with every
/// byte it sent still to be read.
///
/// # Errors
///
/// Returns an error if the connection closes before sending anything, if
/// reading fails, or if the stream starts with the whole v2 signature but not a
/// well-formed header.
///
/// # Remarks
///
/// Only the whole 12-byte signature commits the stream to a header: bytes are
/// read until they either leave the signature or complete it, however they
/// are split across reads. A stream that leaves it, or closes partway through,
/// has those bytes put back for HTTP (see [`Rewound`]). So a request after a
/// stray empty line, which a server should ignore (RFC 9112 §2.2), is served,
/// and no request is mistaken for a header: the signature holds a NUL, which
/// no request line does. The header is then read whole and parsed by `ppp`.
///
/// Nothing here bounds how long the sender takes; the caller runs it under a
/// timeout.
pub(super) async fn read_client_address<S: AsyncRead + Unpin>(
    mut stream: S,
) -> anyhow::Result<(Rewound<S>, Option<SocketAddr>)> {
    let mut first_bytes = [0; PROTOCOL_PREFIX.len()];
    let mut read = 0;
    while read < first_bytes.len() && PROTOCOL_PREFIX.starts_with(&first_bytes[..read]) {
        let just_read = stream.read(&mut first_bytes[read..]).await?;
        if just_read == 0 {
            break;
        }
        read += just_read;
    }
    ensure!(read > 0, "the connection closed before sending anything");
    if first_bytes[..read] != *PROTOCOL_PREFIX {
        return Ok((Rewound::new(first_bytes[..read].to_vec(), stream), None));
    }

    let mut header = first_bytes.to_vec();
    header.resize(FIXED_LENGTH, 0);
    stream
        .read_exact(&mut header[PROTOCOL_PREFIX.len()..])
        .await?;
    let address_length = u16::from_be_bytes([header[FIXED_LENGTH - 2], header[FIXED_LENGTH - 1]]);
    header.resize(FIXED_LENGTH + usize::from(address_length), 0);
    stream.read_exact(&mut header[FIXED_LENGTH..]).await?;
    let header = Header::try_from(header.as_slice())?;
    Ok((Rewound::new(Vec::new(), stream), client_address(&header)))
}

/// A stream with the bytes [`read_client_address`] read off its front and
/// found no header in put back: they are read again before the rest of the
/// stream. Writes go straight to the stream.
pub(crate) struct Rewound<S> {
    /// The bytes put back, read again from `position` on.
    put_back: Vec<u8>,
    /// How many of `put_back` have been read again.
    position: usize,
    stream: S,
}

impl<S> Rewound<S> {
    fn new(put_back: Vec<u8>, stream: S) -> Self {
        Self {
            put_back,
            position: 0,
            stream,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Rewound<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let put_back = &this.put_back[this.position..];
        if put_back.is_empty() {
            return Pin::new(&mut this.stream).poll_read(cx, buf);
        }
        let length = put_back.len().min(buf.remaining());
        buf.put_slice(&put_back[..length]);
        this.position += length;
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Rewound<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

/// The source address a parsed `header` names. A `LOCAL` header (the relay's
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
pub(in crate::http) mod tests {
    use super::*;
    use ppp::v2::{Builder, Protocol, Version};
    use proptest::prelude::*;
    use tokio::io::AsyncWriteExt;

    /// A v2 `PROXY` header from the visitor at `source`, as the relay writes
    /// it.
    pub(in crate::http) fn proxy_header(source: &str) -> Vec<u8> {
        rathole_settings_rust::proxy_header::proxy_header(
            source.parse().expect("source address"),
            "198.51.100.1:443".parse().expect("relay address"),
        )
        .expect("header")
    }

    /// Send `bytes` and close the sending half, then read the header off the
    /// server end. Returns what the reader made of it and the bytes it left.
    async fn read_after_sending(bytes: &[u8]) -> (anyhow::Result<Option<SocketAddr>>, Vec<u8>) {
        let (mut visitor, server_end) = tokio::io::duplex(1024);
        visitor.write_all(bytes).await.expect("write");
        visitor.shutdown().await.expect("shutdown");
        read_off(server_end).await
    }

    /// Read the header off `server_end`. Returns what the reader made of it
    /// and the bytes it left.
    async fn read_off(
        server_end: tokio::io::DuplexStream,
    ) -> (anyhow::Result<Option<SocketAddr>>, Vec<u8>) {
        match read_client_address(server_end).await {
            Ok((mut stream, client_address)) => {
                let mut unread = Vec::new();
                stream
                    .read_to_end(&mut unread)
                    .await
                    .expect("read the rest");
                (Ok(client_address), unread)
            }
            Err(error) => (Err(error), Vec::new()),
        }
    }

    /// A blocking runtime for a property test case.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    #[tokio::test]
    async fn a_proxy_header_is_read_and_stripped() {
        for source in ["192.0.2.1:4711", "[2001:db8::1]:4711"] {
            let mut bytes = proxy_header(source);
            bytes.extend_from_slice(b"GET / HTTP/1.1\r\n\r\n");

            let (client_address, unread) = read_after_sending(&bytes).await;

            assert_eq!(
                client_address.expect("a well-formed header"),
                Some(source.parse().unwrap())
            );
            assert_eq!(unread, b"GET / HTTP/1.1\r\n\r\n", "{source}");
        }
    }

    #[tokio::test]
    async fn a_stream_without_a_header_is_left_intact() {
        let (client_address, unread) = read_after_sending(b"GET / HTTP/1.1\r\n\r\n").await;

        assert_eq!(client_address.expect("no header is not an error"), None);
        assert_eq!(unread, b"GET / HTTP/1.1\r\n\r\n");
    }

    /// A request after a stray empty line, or a stream that closes partway
    /// through the signature, is passed through: only the whole signature
    /// makes a header.
    #[tokio::test]
    async fn a_stream_leaving_the_signature_partway_is_left_intact() {
        let header = proxy_header("192.0.2.1:4711");
        for bytes in [
            &b"\r\nGET / HTTP/1.1\r\n\r\n"[..],
            &b"\r\n\r\nGET / HTTP/1.1\r\n\r\n"[..],
            &header[..5],
        ] {
            let (client_address, unread) = read_after_sending(bytes).await;

            assert_eq!(
                client_address.expect("no header is not an error"),
                None,
                "{bytes:?}"
            );
            assert_eq!(unread, bytes);
        }
    }

    /// A signature split across reads, down to its first byte alone, is
    /// still read as one.
    #[tokio::test]
    async fn a_signature_split_across_reads_is_read() {
        let mut bytes = proxy_header("192.0.2.1:4711");
        bytes.extend_from_slice(b"GET / HTTP/1.1\r\n\r\n");
        let (mut visitor, server_end) = tokio::io::duplex(1024);
        let reading = tokio::spawn(read_off(server_end));
        for fragment in [&bytes[..1], &bytes[1..2], &bytes[2..7], &bytes[7..]] {
            visitor.write_all(fragment).await.expect("write");
            tokio::task::yield_now().await;
        }
        visitor.shutdown().await.expect("shutdown");

        let (client_address, unread) = reading.await.expect("the reader doesn't panic");

        assert_eq!(
            client_address.expect("a well-formed header"),
            Some("192.0.2.1:4711".parse().unwrap())
        );
        assert_eq!(unread, b"GET / HTTP/1.1\r\n\r\n");
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

        let (client_address, unread) = read_after_sending(&header).await;

        assert_eq!(client_address.expect("a well-formed header"), None);
        assert!(unread.is_empty());
    }

    #[tokio::test]
    async fn a_truncated_or_malformed_header_is_an_error() {
        let header = proxy_header("192.0.2.1:4711");
        let mut wrong_version = header.clone();
        wrong_version[PROTOCOL_PREFIX.len()] = 0x11;
        for bytes in [
            &header[..PROTOCOL_PREFIX.len()],
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
        /// without panicking. A stream opening with the whole signature is a
        /// header: one that parses names the address `ppp` reads from it,
        /// and anything else is an error the caller closes the connection on.
        /// A stream that leaves the signature, or closes, before its end is
        /// passed through.
        #[test]
        fn any_bytes_after_a_signature_prefix_are_read_without_panicking(
            signature_length in 1..=PROTOCOL_PREFIX.len(),
            after_signature in proptest::collection::vec(any::<u8>(), 0..64),
        ) {
            let mut bytes = PROTOCOL_PREFIX[..signature_length].to_vec();
            bytes.extend_from_slice(&after_signature);
            let (client_address_read, unread) = runtime().block_on(read_after_sending(&bytes));
            match client_address_read {
                Ok(client_address_read) if bytes.starts_with(PROTOCOL_PREFIX) => {
                    let header = Header::try_from(bytes.as_slice()).expect("it parsed once");
                    prop_assert_eq!(client_address(&header), client_address_read);
                }
                Ok(client_address_read) => {
                    prop_assert_eq!(client_address_read, None);
                    prop_assert_eq!(unread, bytes);
                }
                Err(_) => {}
            }
        }

        /// A stream that doesn't open with the signature is passed through
        /// with every byte intact.
        #[test]
        fn a_stream_not_opening_with_the_signature_is_passed_through(
            first in any::<u8>()
                .prop_filter("not the signature's first byte", |b| *b != PROTOCOL_PREFIX[0]),
            rest in proptest::collection::vec(any::<u8>(), 0..64),
        ) {
            let mut bytes = vec![first];
            bytes.extend_from_slice(&rest);
            let (client_address_read, unread) = runtime().block_on(read_after_sending(&bytes));
            prop_assert_eq!(client_address_read.ok(), Some(None));
            prop_assert_eq!(unread, bytes);
        }
    }
}
