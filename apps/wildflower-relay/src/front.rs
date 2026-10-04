//! The public TCP front: `:443` routes TLS by server name, `:80` redirects.
//!
//! On `:443` the front reads the visitor's ClientHello, takes its server name
//! with [`rustls::server::Acceptor`] (which parses the hello and nothing
//! else: there is no certificate, key or crypto provider here), resolves
//! `<label>.<domain>` to that device's rathole service on loopback, and
//! replays everything it read behind a PROXY protocol v2 header. From then on
//! it copies bytes both ways without looking at them. Anything it cannot
//! route is closed without a byte written, so the relay never answers TLS
//! for a device.
//!
//! On `:80` it reads only the request line and `Host`, answers `308` to the
//! `https://` URL for a known label and `404` otherwise, and never proxies.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};

use ppp::v2::{Builder, Command, Protocol, Version};
use rustls::server::Acceptor;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};

use crate::route::Router;

/// Upper bound on the bytes buffered while waiting for a complete
/// ClientHello. Real hellos, post-quantum key shares included, are a few KiB.
const MAX_HELLO_BYTES: usize = 16 * 1024;

/// Upper bound on an HTTP request head on `:80`.
const MAX_HTTP_HEAD_BYTES: usize = 8 * 1024;

/// Pause after a failed `accept` (e.g. out of file descriptors) so the loop
/// does not spin.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// Connection limits and timeouts for the front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Concurrent connections across `:443` and `:80` together.
    pub max_connections: usize,
    /// Concurrent piped connections to any one label.
    pub max_connections_per_label: usize,
    /// Deadline for a complete ClientHello (or HTTP request head).
    pub hello_timeout: Duration,
    /// A piped connection with no bytes in either direction for this long is
    /// closed.
    pub idle_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 4096,
            max_connections_per_label: 256,
            hello_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(300),
        }
    }
}

/// The shared state behind both listeners: routes, limits and the
/// semaphores that enforce them.
#[derive(Debug)]
pub struct Front {
    router: Arc<Router>,
    limits: Limits,
    connections: Arc<Semaphore>,
    per_label: Mutex<HashMap<String, Arc<Semaphore>>>,
}

impl Front {
    #[must_use]
    pub fn new(router: Arc<Router>, limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            router,
            limits,
            connections: Arc::new(Semaphore::new(limits.max_connections)),
            per_label: Mutex::new(HashMap::new()),
        })
    }

    /// Accept on `listener` until `shutdown_rx` fires, handing each
    /// connection to `handle` with a slot from the overall limit. A
    /// connection over the limit is dropped (closed) unanswered.
    async fn accept_loop<F, Fut>(
        self: Arc<Self>,
        listener: TcpListener,
        mut shutdown_rx: broadcast::Receiver<bool>,
        handle: F,
    ) -> anyhow::Result<()>
    where
        F: Fn(Arc<Self>, TcpStream, broadcast::Receiver<bool>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let stream = match accepted {
                        Ok((stream, _peer)) => stream,
                        Err(e) => {
                            tracing::warn!("front accept failed: {e}");
                            tokio::time::sleep(ACCEPT_BACKOFF).await;
                            continue;
                        }
                    };
                    let Ok(permit) = Arc::clone(&self.connections).try_acquire_owned() else {
                        tracing::warn!("front at its connection limit, refusing");
                        continue;
                    };
                    let conn = handle(Arc::clone(&self), stream, shutdown_rx.resubscribe());
                    tokio::spawn(async move {
                        let _permit = permit;
                        conn.await;
                    });
                }
                _ = shutdown_rx.recv() => break,
            }
        }
        Ok(())
    }

    /// Serve TLS routing on `listener` (normally `:443`) until shutdown.
    ///
    /// # Errors
    ///
    /// Currently never; the `Result` keeps the signature in line with the
    /// other relay tasks it is joined with.
    pub async fn serve_https(
        self: Arc<Self>,
        listener: TcpListener,
        shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        self.accept_loop(
            listener,
            shutdown_rx,
            |front, stream, shutdown_rx| async move {
                front.handle_tls(stream, shutdown_rx).await;
            },
        )
        .await
    }

    /// Serve the `:80` redirect on `listener` until shutdown.
    ///
    /// # Errors
    ///
    /// Currently never; see [`Front::serve_https`].
    pub async fn serve_http(
        self: Arc<Self>,
        listener: TcpListener,
        shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        self.accept_loop(
            listener,
            shutdown_rx,
            |front, stream, _shutdown_rx| async move {
                front.handle_http(stream).await;
            },
        )
        .await
    }

    fn try_acquire_label(&self, label: &str) -> Option<OwnedSemaphorePermit> {
        let semaphore = Arc::clone(
            self.per_label
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(label.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.limits.max_connections_per_label))),
        );
        semaphore.try_acquire_owned().ok()
    }

    /// Route one `:443` connection. Every early return drops `client`, which
    /// closes it without anything having been written to it.
    async fn handle_tls(&self, mut client: TcpStream, mut shutdown_rx: broadcast::Receiver<bool>) {
        let (Ok(peer), Ok(local)) = (client.peer_addr(), client.local_addr()) else {
            return;
        };
        let (hello, parsed) =
            match tokio::time::timeout(self.limits.hello_timeout, read_hello(&mut client)).await {
                Ok(Ok(read)) => read,
                Ok(Err(e)) => {
                    tracing::debug!("refused: reading ClientHello failed: {e}");
                    return;
                }
                Err(_) => {
                    tracing::debug!("refused: no ClientHello within the deadline");
                    return;
                }
            };
        let server_name = match parsed {
            ClientHello::ServerName(name) => name,
            other => {
                tracing::debug!(hello = ?other, "refused: no usable server name");
                return;
            }
        };
        let Some(route) = self.router.resolve(&server_name) else {
            tracing::debug!(%server_name, "refused: unknown label");
            return;
        };
        let Some(_label_permit) = self.try_acquire_label(&route.label) else {
            tracing::warn!(label = %route.label, "refused: label at its connection limit");
            return;
        };
        // rathole binds a service's port only while that device's tunnel is
        // up, so a refused connect means the device is offline. This is the
        // point where a known label meets a down tunnel, should the relay
        // ever need to tell the device (wake-up push, #918).
        let mut backend =
            match tokio::time::timeout(self.limits.hello_timeout, TcpStream::connect(route.addr))
                .await
            {
                Ok(Ok(backend)) => backend,
                _ => {
                    tracing::info!(label = %route.label, "refused: no live tunnel for label");
                    return;
                }
            };
        let _ = client.set_nodelay(true);
        let _ = backend.set_nodelay(true);

        let mut preface = match proxy_header(peer, local) {
            Ok(header) => header,
            Err(e) => {
                tracing::warn!("refused: building PROXY header failed: {e}");
                return;
            }
        };
        preface.extend_from_slice(&hello);
        if let Err(e) = backend.write_all(&preface).await {
            tracing::debug!(label = %route.label, "backend closed before the hello was replayed: {e}");
            return;
        }

        let activity = Arc::new(Activity::new());
        let mut client = Tracked::new(client, Arc::clone(&activity));
        let mut backend = Tracked::new(backend, Arc::clone(&activity));
        tokio::select! {
            result = tokio::io::copy_bidirectional(&mut client, &mut backend) => {
                if let Err(e) = result {
                    tracing::debug!(label = %route.label, "pipe ended: {e}");
                }
            }
            () = activity.idle(self.limits.idle_timeout) => {
                tracing::debug!(label = %route.label, "pipe idle, closing");
            }
            _ = shutdown_rx.recv() => {}
        }
    }

    /// Answer one `:80` request with a redirect or a 404, then close.
    async fn handle_http(&self, mut stream: TcpStream) {
        let head = match tokio::time::timeout(
            self.limits.hello_timeout,
            read_http_head(&mut stream),
        )
        .await
        {
            Ok(Ok(Some(head))) => head,
            _ => return,
        };
        let location = parse_http_head(&head).and_then(|(host, path)| {
            let route = self.router.resolve(&host)?;
            Some(format!(
                "https://{}.{}{path}",
                route.label,
                self.router.domain()
            ))
        });
        let response = match location {
            Some(location) => format!(
                "HTTP/1.1 308 Permanent Redirect\r\nLocation: {location}\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            ),
            None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned(),
        };
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }
}

/// What the start of a `:443` connection turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientHello {
    /// More bytes are needed.
    Incomplete,
    /// A well-formed hello naming this host (lowercased by rustls).
    ServerName(String),
    /// A well-formed hello without a DNS server name (none, or an IP).
    NoServerName,
    /// Not a TLS ClientHello, or one rustls rejects.
    Invalid,
}

/// Incremental ClientHello parser over [`Acceptor`]. Feed it bytes as they
/// arrive; it never panics on any input.
pub(crate) struct HelloParser {
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
    pub(crate) fn feed(&mut self, mut bytes: &[u8]) -> ClientHello {
        let Some(acceptor) = self.acceptor.as_mut() else {
            return ClientHello::Invalid;
        };
        while !bytes.is_empty() {
            match acceptor.read_tls(&mut bytes) {
                Ok(n) if n > 0 => {}
                _ => {
                    self.acceptor = None;
                    return ClientHello::Invalid;
                }
            }
        }
        let outcome = match acceptor.accept() {
            Ok(None) => return ClientHello::Incomplete,
            Ok(Some(accepted)) => match accepted.client_hello().server_name() {
                Some(name) => ClientHello::ServerName(name.to_owned()),
                None => ClientHello::NoServerName,
            },
            Err(_) => ClientHello::Invalid,
        };
        self.acceptor = None;
        outcome
    }
}

/// Read from `stream` until the ClientHello is complete (or clearly not
/// one), returning every byte read so it can be replayed verbatim.
async fn read_hello(stream: &mut TcpStream) -> io::Result<(Vec<u8>, ClientHello)> {
    let mut buffer = Vec::with_capacity(4096);
    let mut parser = HelloParser::default();
    let mut chunk = [0u8; 4096];
    loop {
        let room = MAX_HELLO_BYTES
            .saturating_sub(buffer.len())
            .min(chunk.len());
        if room == 0 {
            return Ok((buffer, ClientHello::Invalid));
        }
        let n = stream.read(&mut chunk[..room]).await?;
        if n == 0 {
            return Ok((buffer, ClientHello::Invalid));
        }
        buffer.extend_from_slice(&chunk[..n]);
        match parser.feed(&chunk[..n]) {
            ClientHello::Incomplete => {}
            done => return Ok((buffer, done)),
        }
    }
}

/// PROXY protocol v2 `PROXY`/`STREAM` header for a visitor at `source`
/// reaching the relay at `destination`. IPv4-mapped IPv6 addresses (from a
/// dual-stack listener) are unmapped first; if the families still differ the
/// IPv4 side is mapped so both are IPv6, which the header requires.
fn proxy_header(source: SocketAddr, destination: SocketAddr) -> io::Result<Vec<u8>> {
    let canonical = |a: SocketAddr| SocketAddr::new(a.ip().to_canonical(), a.port());
    let as_v6 = |a: SocketAddr| match a {
        SocketAddr::V4(v4) => SocketAddr::new(v4.ip().to_ipv6_mapped().into(), v4.port()),
        v6 @ SocketAddr::V6(_) => v6,
    };
    let (source, destination) = match (canonical(source), canonical(destination)) {
        (s, d) if s.is_ipv4() == d.is_ipv4() => (s, d),
        (s, d) => (as_v6(s), as_v6(d)),
    };
    Builder::with_addresses(
        Version::Two | Command::Proxy,
        Protocol::Stream,
        (source, destination),
    )
    .build()
}

/// Read an HTTP request head (through the blank line), or `None` if the
/// peer closes first or it exceeds [`MAX_HTTP_HEAD_BYTES`].
async fn read_http_head(stream: &mut TcpStream) -> io::Result<Option<Vec<u8>>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let room = MAX_HTTP_HEAD_BYTES
            .saturating_sub(head.len())
            .min(chunk.len());
        if room == 0 {
            return Ok(None);
        }
        let n = stream.read(&mut chunk[..room]).await?;
        if n == 0 {
            return Ok(None);
        }
        head.extend_from_slice(&chunk[..n]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(Some(head));
        }
    }
}

/// The `Host` (without port) and origin-form path of an HTTP/1.x request
/// head, or `None` if either is missing or malformed. The path is echoed
/// into a `Location` header, so it must hold no whitespace or controls.
fn parse_http_head(head: &[u8]) -> Option<(String, String)> {
    let head = std::str::from_utf8(head).ok()?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let (_method, target, version) = (
        request_line.next()?,
        request_line.next()?,
        request_line.next()?,
    );
    if request_line.next().is_some() || !version.starts_with("HTTP/1.") {
        return None;
    }
    let path = if target.starts_with('/') { target } else { "/" };
    if path.bytes().any(|b| b.is_ascii_control() || b == b' ') {
        return None;
    }
    let host = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim())?;
    let host = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    Some((host.to_owned(), path.to_owned()))
}

/// Last time either side of a pipe delivered bytes, for the idle timeout.
struct Activity {
    start: Instant,
    last_millis: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            last_millis: AtomicU64::new(0),
        }
    }

    fn touch(&self) {
        let now = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_millis.store(now, Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        let last = Duration::from_millis(self.last_millis.load(Ordering::Relaxed));
        self.start.elapsed().saturating_sub(last)
    }

    /// Resolve once nothing has moved for `timeout`.
    async fn idle(&self, timeout: Duration) {
        loop {
            let idle = self.idle_for();
            if idle >= timeout {
                return;
            }
            tokio::time::sleep(timeout - idle).await;
        }
    }
}

/// A stream that records reads into a shared [`Activity`].
struct Tracked {
    inner: TcpStream,
    activity: Arc<Activity>,
}

impl Tracked {
    fn new(inner: TcpStream, activity: Arc<Activity>) -> Self {
        Self { inner, activity }
    }
}

impl AsyncRead for Tracked {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(poll, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.activity.touch();
        }
        poll
    }
}

impl AsyncWrite for Tracked {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, ClientConnection, RootCertStore};

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

    #[test]
    fn hello_yields_the_lowercased_server_name() {
        let hello = client_hello(dns("Abc.Relay.Example.com"));
        assert_eq!(
            HelloParser::default().feed(&hello),
            ClientHello::ServerName("abc.relay.example.com".to_owned())
        );
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

    #[test]
    fn http_head_yields_host_without_port_and_path() {
        assert_eq!(
            parse_http_head(
                b"GET /a/b?c=d HTTP/1.1\r\nUser-Agent: x\r\nHOST: Abc.relay.example.com:80\r\n\r\n"
            ),
            Some(("Abc.relay.example.com".to_owned(), "/a/b?c=d".to_owned()))
        );
        assert_eq!(
            parse_http_head(b"GET http://abc.example/x HTTP/1.0\r\nHost: abc.example\r\n\r\n"),
            Some(("abc.example".to_owned(), "/".to_owned()))
        );
    }

    #[test]
    fn http_head_rejects_malformed_requests() {
        for head in [
            &b"GET / HTTP/1.1\r\n\r\n"[..],
            b"GET / HTTP/2\r\nHost: a\r\n\r\n",
            b"GET /\x7f HTTP/1.1\r\nHost: a\r\n\r\n",
            b"GET / HTTP/1.1 extra\r\nHost: a\r\n\r\n",
            b"\xff\xfe\r\n\r\n",
            b"",
        ] {
            assert_eq!(parse_http_head(head), None, "{head:?}");
        }
    }
}
