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

use std::io;

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
    NoServerName,
    /// Not a TLS ClientHello, or one rustls rejects.
    Invalid,
}

/// Read from `stream` until there is a verdict on the ClientHello, and
/// return that verdict with every byte read, so the bytes can be sent on to
/// the device unchanged.
///
/// Reads are at most [`READ_CHUNK`] bytes and the loop stops at the first
/// chunk that completes the hello. If the client sent more right behind the
/// hello and it arrived in that same chunk, those bytes are in the returned
/// buffer too and are passed on with it; nothing is dropped and nothing
/// after that chunk is read here. More than [`MAX_HELLO_BYTES`] without a
/// complete hello, or the client closing first, is [`ClientHello::Invalid`].
pub(super) async fn read_client_hello(
    stream: &mut TcpStream,
) -> io::Result<(Vec<u8>, ClientHello)> {
    let mut parser = HelloParser::default();
    let mut read_so_far = Vec::with_capacity(READ_CHUNK);
    let mut chunk = [0u8; READ_CHUNK];
    loop {
        let room = MAX_HELLO_BYTES - read_so_far.len();
        if room == 0 {
            return Ok((read_so_far, ClientHello::Invalid));
        }
        let n = stream.read(&mut chunk[..room.min(READ_CHUNK)]).await?;
        if n == 0 {
            return Ok((read_so_far, ClientHello::Invalid));
        }
        read_so_far.extend_from_slice(&chunk[..n]);

        let verdict = parser.feed(&chunk[..n]);
        if verdict != ClientHello::Incomplete {
            return Ok((read_so_far, verdict));
        }
    }
}

/// Incremental ClientHello parser over [`Acceptor`]: give it bytes as they
/// arrive and it says whether the hello is complete yet. It never panics on
/// any input, and once it has given a verdict every later call is
/// [`ClientHello::Invalid`].
pub(super) struct HelloParser {
    /// `None` once a verdict has been given.
    acceptor: Option<Acceptor>,
}

impl Default for HelloParser {
    fn default() -> Self {
        Self {
            acceptor: Some(Acceptor::default()),
        }
    }
}

impl HelloParser {
    pub(super) fn feed(&mut self, bytes: &[u8]) -> ClientHello {
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
            Ok(Some(accepted)) => match accepted.client_hello().server_name() {
                Some(name) => ClientHello::ServerName(name.to_owned()),
                None => ClientHello::NoServerName,
            },
            Err(_) => ClientHello::Invalid,
        };
        self.acceptor = None;
        verdict
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
        let (read, verdict) = read_client_hello(&mut server).await.unwrap();
        assert_eq!(
            verdict,
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
        assert_eq!(read, hello, "exactly the hello was read");

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
        let hello = client_hello(ServerName::IpAddress(
            std::net::IpAddr::from([192, 0, 2, 1]).into(),
        ));
        assert_eq!(
            HelloParser::default().feed(&hello),
            ClientHello::NoServerName
        );
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
