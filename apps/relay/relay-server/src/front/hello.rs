//! Reading the TLS ClientHello and taking its server name.
//!
//! The ClientHello is the first thing a TLS client sends, in the clear, and
//! names the host it wants. [`read_client_hello`] reads the socket a chunk
//! at a time and stops as soon as a whole ClientHello has arrived (or the
//! bytes clearly are not one). It never reads the rest of the connection:
//! that is copied to the device untouched once the hello has been replayed.
//!
//! The parsing itself is rustls's [`Acceptor`], which reads a ClientHello
//! and nothing else. No certificate, key or crypto provider is involved.
//! rustls drops an IP literal sent as the server name, so for a hello
//! without one, [`sni_ip_literal`] reads it from the bytes itself, for the
//! connection log.

use std::io;
use std::net::IpAddr;

use rustls::server::Acceptor;
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// Upper bound on the bytes read while waiting for a complete ClientHello.
/// Real hellos, post-quantum key shares included, are a few KiB.
const MAX_HELLO_BYTES: usize = 16 * 1024;

/// Size of each socket read while waiting for the hello.
const READ_CHUNK: usize = 4096;

/// What the start of a `:443` connection turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ClientHello {
    /// Not enough bytes yet to tell.
    Incomplete,
    /// A well-formed hello naming this host (lowercased by rustls).
    ServerName(String),
    /// A well-formed hello without a DNS server name (none, or an IP).
    NoServerName(UnnamedHello),
    /// Not a TLS ClientHello, or one rustls rejects.
    Invalid,
    /// The client closed before a whole hello arrived.
    Closed,
}

/// What a well-formed hello without a DNS server name offered instead.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct UnnamedHello {
    /// The IP literal sent as the server name, if one was.
    pub(super) sni_ip: Option<IpAddr>,
    /// The ALPN protocols offered, in the client's order.
    pub(super) alpn: Vec<Vec<u8>>,
}

/// Read from `stream` into `parser` until there is a verdict on the
/// ClientHello. Every byte read stays in the parser
/// ([`HelloParser::received`]), so it can be sent on to the device
/// unchanged, and so a caller that stops waiting still knows what arrived.
///
/// Reads are at most [`READ_CHUNK`] bytes and the loop stops at the first
/// chunk that completes the hello. If the client sent more right behind the
/// hello and it arrived in that same chunk, those bytes are in the parser
/// too and are passed on with it; nothing is dropped and nothing after that
/// chunk is read here. More than [`MAX_HELLO_BYTES`] without a complete
/// hello is [`ClientHello::Invalid`], and the client closing first is
/// [`ClientHello::Closed`].
pub(super) async fn read_client_hello(
    stream: &mut TcpStream,
    parser: &mut HelloParser,
) -> io::Result<ClientHello> {
    let mut chunk = [0u8; READ_CHUNK];
    loop {
        let room = MAX_HELLO_BYTES - parser.received.len();
        if room == 0 {
            return Ok(ClientHello::Invalid);
        }
        let n = stream.read(&mut chunk[..room.min(READ_CHUNK)]).await?;
        if n == 0 {
            return Ok(ClientHello::Closed);
        }
        let verdict = parser.feed(&chunk[..n]);
        if verdict != ClientHello::Incomplete {
            return Ok(verdict);
        }
    }
}

/// Incremental ClientHello parser over [`Acceptor`]: give it bytes as they
/// arrive and it says whether the hello is complete yet, keeping every byte
/// it was given. It never panics on any input, and once it has given a
/// verdict every later call is [`ClientHello::Invalid`].
pub(super) struct HelloParser {
    /// `None` once a verdict has been given.
    acceptor: Option<Acceptor>,
    /// Every byte fed so far.
    received: Vec<u8>,
}

impl Default for HelloParser {
    fn default() -> Self {
        Self {
            acceptor: Some(Acceptor::default()),
            received: Vec::with_capacity(READ_CHUNK),
        }
    }
}

impl HelloParser {
    pub(super) fn feed(&mut self, bytes: &[u8]) -> ClientHello {
        self.received.extend_from_slice(bytes);
        let Some(acceptor) = self.acceptor.as_mut() else {
            return ClientHello::Invalid;
        };
        if !copy_into(acceptor, bytes) {
            self.acceptor = None;
            return ClientHello::Invalid;
        }
        // `accept` looks only at the first handshake message, the
        // ClientHello; it does not need, or look at, anything after it.
        let verdict = match acceptor.accept() {
            Ok(None) => return ClientHello::Incomplete,
            Ok(Some(accepted)) => {
                let hello = accepted.client_hello();
                match hello.server_name() {
                    Some(name) => ClientHello::ServerName(name.to_owned()),
                    None => ClientHello::NoServerName(UnnamedHello {
                        sni_ip: sni_ip_literal(&self.received),
                        alpn: hello
                            .alpn()
                            .map(|protocols| protocols.map(<[u8]>::to_vec).collect())
                            .unwrap_or_default(),
                    }),
                }
            }
            Err(_) => ClientHello::Invalid,
        };
        self.acceptor = None;
        verdict
    }

    /// Every byte fed so far.
    pub(super) fn received(&self) -> &[u8] {
        &self.received
    }

    /// Every byte fed, to replay to the device or the site.
    pub(super) fn into_received(self) -> Vec<u8> {
        self.received
    }
}

/// Hand `bytes` (already read from the socket) to the acceptor's buffer.
/// `read_tls` may take them in several pieces; `false` if it refuses them,
/// e.g. because its buffer is full.
fn copy_into(acceptor: &mut Acceptor, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        match acceptor.read_tls(&mut bytes) {
            Ok(n) if n > 0 => {}
            _ => return false,
        }
    }
    true
}

/// TLS record type of a handshake record.
const HANDSHAKE_RECORD: u8 = 0x16;
/// `server_name` extension (RFC 6066).
const SERVER_NAME_EXTENSION: u16 = 0;
/// `host_name`, the only name type in the `server_name` extension.
const HOST_NAME: u8 = 0;

/// The IP literal a ClientHello sent as its server name, if it sent one.
/// RFC 6066 allows only DNS names there, so rustls ignores an IP and keeps
/// nothing of it. `records` are the bytes of a hello rustls has accepted,
/// as they arrived: TLS records, the hello possibly split across several.
/// Anything that does not parse is `None`.
fn sni_ip_literal(records: &[u8]) -> Option<IpAddr> {
    let mut handshake = Vec::new();
    let mut records = Bytes(records);
    // Whatever follows the hello may end mid-record; the hello is whole.
    while let Some((record_type, body)) = records.record() {
        if record_type == HANDSHAKE_RECORD {
            handshake.extend_from_slice(body);
        }
    }
    let mut hello = Bytes(&handshake);
    hello.take(4)?; // handshake type and length
    hello.take(2 + 32)?; // legacy version and random
    hello.vec8()?; // legacy session id
    hello.vec16()?; // cipher suites
    hello.vec8()?; // legacy compression methods
    let mut extensions = Bytes(hello.vec16()?);
    while !extensions.0.is_empty() {
        let extension_type = extensions.u16()?;
        let body = extensions.vec16()?;
        if extension_type != SERVER_NAME_EXTENSION {
            continue;
        }
        let mut names = Bytes(Bytes(body).vec16()?);
        while !names.0.is_empty() {
            let name_type = names.u8()?;
            let name = names.vec16()?;
            if name_type == HOST_NAME {
                return std::str::from_utf8(name).ok()?.parse().ok();
            }
        }
    }
    None
}

/// A cursor over TLS's length-prefixed encoding, every read checked.
struct Bytes<'a>(&'a [u8]);

impl<'a> Bytes<'a> {
    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let (taken, rest) = self.0.split_at_checked(len)?;
        self.0 = rest;
        Some(taken)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    /// A vector with a one-byte length.
    fn vec8(&mut self) -> Option<&'a [u8]> {
        let len = self.u8()?;
        self.take(usize::from(len))
    }

    /// A vector with a two-byte length.
    fn vec16(&mut self) -> Option<&'a [u8]> {
        let len = self.u16()?;
        self.take(usize::from(len))
    }

    /// A whole TLS record's type and body.
    fn record(&mut self) -> Option<(u8, &'a [u8])> {
        let record_type = self.u8()?;
        self.take(2)?; // legacy version
        Some((record_type, self.vec16()?))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, ClientConnection, RootCertStore};
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;

    /// The ClientHello a real rustls client sends for `server_name`.
    fn client_hello(server_name: ServerName<'static>) -> Vec<u8> {
        let config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(RootCertStore::empty())
                .with_no_client_auth();
        let mut conn = ClientConnection::new(Arc::new(config), server_name).expect("client");
        let mut hello = Vec::new();
        while conn.wants_write() {
            conn.write_tls(&mut hello).expect("write hello");
        }
        hello
    }

    fn dns(name: &str) -> ServerName<'static> {
        ServerName::try_from(name.to_owned()).expect("dns name")
    }

    /// A TLS application-data record, standing in for whatever a client
    /// sends after its hello.
    const APP_DATA_RECORD: [u8; 10] = [0x17, 0x03, 0x03, 0x00, 0x05, 1, 2, 3, 4, 5];

    #[test]
    fn hello_yields_the_lowercased_server_name() {
        let hello = client_hello(dns("Abc.Relay.Example.com"));
        assert_eq!(
            HelloParser::default().feed(&hello),
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
    }

    #[test]
    fn bytes_after_the_hello_do_not_change_the_verdict() {
        let mut bytes = client_hello(dns("abc.relay.example.com"));
        bytes.extend_from_slice(&APP_DATA_RECORD);
        assert_eq!(
            HelloParser::default().feed(&bytes),
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
    }

    #[tokio::test]
    async fn reading_stops_once_the_hello_is_complete() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut server, _) = listener.accept().await.unwrap();

        let hello = client_hello(dns("abc.relay.example.com"));
        client.write_all(&hello).await.unwrap();
        let mut parser = HelloParser::default();
        let verdict = read_client_hello(&mut server, &mut parser).await.unwrap();
        assert_eq!(
            verdict,
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
        assert_eq!(parser.into_received(), hello, "exactly the hello was read");

        // What the client sends next is still unread on the socket.
        client.write_all(&APP_DATA_RECORD).await.unwrap();
        let mut next = [0u8; APP_DATA_RECORD.len()];
        server.read_exact(&mut next).await.unwrap();
        assert_eq!(next, APP_DATA_RECORD);
    }

    #[test]
    fn hello_fed_byte_by_byte_completes_on_the_last_byte() {
        let hello = client_hello(dns("abc.relay.example.com"));
        let mut parser = HelloParser::default();
        let (last, rest) = hello.split_last().expect("non-empty hello");
        for byte in rest {
            assert_eq!(
                parser.feed(std::slice::from_ref(byte)),
                ClientHello::Incomplete
            );
        }
        assert_eq!(
            parser.feed(&[*last]),
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
    }

    #[test]
    fn truncated_hello_stays_incomplete() {
        let hello = client_hello(dns("abc.relay.example.com"));
        for len in [0, 1, 4, 5, 9, hello.len() / 2, hello.len() - 1] {
            assert_eq!(
                HelloParser::default().feed(&hello[..len]),
                ClientHello::Incomplete,
                "prefix of {len} bytes"
            );
        }
    }

    #[test]
    fn hello_without_dns_name_has_no_server_name() {
        // rustls sends no SNI for an IP.
        let hello = client_hello(ServerName::IpAddress(
            std::net::IpAddr::from([192, 0, 2, 1]).into(),
        ));
        assert_eq!(
            HelloParser::default().feed(&hello),
            ClientHello::NoServerName(UnnamedHello::default())
        );
    }

    #[test]
    fn an_ip_literal_sent_as_the_server_name_and_the_alpn_offered_are_kept() {
        // A hello for a DNS name as long as the IP, with the name swapped
        // for the IP: rustls drops it, and `sni_ip_literal` finds it.
        let mut config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(RootCertStore::empty())
                .with_no_client_auth();
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let mut conn = ClientConnection::new(Arc::new(config), dns("abcdef.com")).expect("client");
        let mut hello = Vec::new();
        while conn.wants_write() {
            conn.write_tls(&mut hello).expect("write hello");
        }
        let at = hello
            .windows(10)
            .position(|window| window == b"abcdef.com")
            .expect("the name is in the hello");
        hello[at..at + 10].copy_from_slice(b"192.0.2.10");
        // Bytes the client sent behind the hello, ending mid-record, do
        // not hide the name.
        hello.extend_from_slice(&APP_DATA_RECORD[..7]);

        assert_eq!(
            HelloParser::default().feed(&hello),
            ClientHello::NoServerName(UnnamedHello {
                sni_ip: Some(std::net::IpAddr::from([192, 0, 2, 10])),
                alpn: vec![b"h2".to_vec(), b"http/1.1".to_vec()],
            })
        );
    }

    #[test]
    fn a_hello_split_across_records_still_yields_its_ip_literal() {
        let hello = client_hello(dns("abcdef.com"));
        let mut handshake = hello[5..].to_vec();
        let at = handshake
            .windows(10)
            .position(|window| window == b"abcdef.com")
            .expect("the name is in the hello");
        handshake[at..at + 10].copy_from_slice(b"192.0.2.10");
        let mut records = Vec::new();
        for fragment in handshake.chunks(100) {
            records.extend_from_slice(&[HANDSHAKE_RECORD, 0x03, 0x01]);
            records.extend_from_slice(&u16::try_from(fragment.len()).unwrap().to_be_bytes());
            records.extend_from_slice(fragment);
        }
        assert_eq!(
            sni_ip_literal(&records),
            Some(std::net::IpAddr::from([192, 0, 2, 10]))
        );
        assert_eq!(sni_ip_literal(&records[..records.len() / 2]), None);
    }

    #[tokio::test]
    async fn a_client_that_closes_first_is_closed_and_its_bytes_are_kept() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut server, _) = listener.accept().await.unwrap();

        client.write_all(&[0x16, 0x03, 0x01]).await.unwrap();
        drop(client);
        let mut parser = HelloParser::default();
        let verdict = read_client_hello(&mut server, &mut parser).await.unwrap();
        assert_eq!(verdict, ClientHello::Closed);
        assert_eq!(parser.received(), [0x16, 0x03, 0x01]);
    }

    #[test]
    fn garbage_is_invalid_and_never_panics() {
        assert_eq!(
            HelloParser::default().feed(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
            ClientHello::Invalid
        );
        // A handshake record header whose body is not a ClientHello.
        assert_eq!(
            HelloParser::default().feed(&[0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0, 0, 0]),
            ClientHello::Invalid
        );

        // Corrupt every byte of a real hello in turn, then a cheap PRNG
        // stream: the only requirement is no panic.
        let hello = client_hello(dns("abc.relay.example.com"));
        for i in 0..hello.len() {
            let mut corrupt = hello.clone();
            corrupt[i] ^= 0xff;
            let _ = HelloParser::default().feed(&corrupt);
        }
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        for _ in 0..2000 {
            let bytes: Vec<u8> = (0..64)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state.to_le_bytes()[0]
                })
                .collect();
            let mut parser = HelloParser::default();
            let _ = parser.feed(&[0x16, 0x03, 0x01, 0x00, 0x40]);
            let _ = parser.feed(&bytes);
        }
    }

    #[test]
    fn parser_stays_invalid_after_a_verdict() {
        let mut parser = HelloParser::default();
        assert_eq!(parser.feed(b"not tls at all"), ClientHello::Invalid);
        assert_eq!(parser.feed(b"more"), ClientHello::Invalid);
    }
}
