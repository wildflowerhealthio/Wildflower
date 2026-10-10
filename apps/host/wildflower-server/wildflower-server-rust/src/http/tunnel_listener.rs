//! The tunnel listener: the visitor streams the tunnel's rathole client hands
//! over in process, served by `axum::serve` through [`TunnelListener`]. Each
//! connection completes its opening handshake before HTTP, in
//! [`handshake_tunnel_connection`]: its PROXY protocol v2 header, when it has
//! one, for the visitor's address (see [`proxy_header`]), then its TLS for
//! the server's domain (see [`tls`]). The loopback listener never reads a PROXY
//! header, so nobody on this machine can claim a visitor's address.

mod proxy_header;
pub(crate) mod tls;

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;
use axum::extract::connect_info::Connected;
use axum::serve::IncomingStream;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_rustls::server::TlsStream;
use wildflowerhealthio_tunnel::TunnelStream;

use self::tls::TunnelTlsAcceptor;

/// How long a tunnel connection has to complete its opening handshake before
/// it is closed: to send its PROXY header, when it opens with one, and to
/// complete its TLS handshake. The relay writes the header the moment it connects,
/// and a TLS 1.3 handshake takes one round trip, so only a stalled or hostile
/// sender waits this long.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// How many tunnel connections may be handshaking at once. Past this, the
/// listener takes no more streams from the tunnel until one is ready or
/// closed, so the tunnel's backlog, and then rathole's, push back on the
/// relay.
const MAX_HANDSHAKING: usize = 64;

/// A tunnel connection whose opening handshake is done, ready for HTTP: its
/// TLS, over the stream with the bytes read for a PROXY header and not part
/// of one read again first.
pub(crate) type TunnelTlsStream = TlsStream<proxy_header::Rewound<TunnelStream>>;

/// The visitor behind a tunnel connection: the tunnel listener's connect info.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TunnelVisitor {
    /// The visitor's address, from the connection's PROXY header. `None` when
    /// it had no header or the header named no address.
    pub(crate) client_address: Option<SocketAddr>,
}

impl Connected<IncomingStream<'_, TunnelListener>> for TunnelVisitor {
    fn connect_info(stream: IncomingStream<'_, TunnelListener>) -> Self {
        *stream.remote_addr()
    }
}

/// An `axum::serve` listener over the visitor streams the tunnel hands over.
///
/// # Remarks
///
/// axum accepts one connection at a time, so running a connection's opening
/// handshake inside [`accept`](axum::serve::Listener::accept) would let one
/// slow sender stall every connection behind it. Instead each handed-over
/// stream handshakes on a task of its own, and `accept` returns whichever is
/// ready first. A connection whose handshake fails, or that was a
/// certificate validation and is done, is closed alone. At most
/// [`MAX_HANDSHAKING`] handshake at once; the rest wait in the tunnel's
/// backlog. Dropping the listener, which `axum::serve` does once its graceful
/// shutdown begins, aborts the handshakes still running.
pub(crate) struct TunnelListener {
    /// The visitor streams the tunnel hands over.
    tunnel_stream_rx: mpsc::Receiver<TunnelStream>,
    /// The acceptor each connection's TLS handshake completes with.
    tls_acceptor: TunnelTlsAcceptor,
    /// The handed-over streams whose opening handshake is running.
    handshaking: JoinSet<anyhow::Result<Option<(TunnelTlsStream, TunnelVisitor)>>>,
}

impl TunnelListener {
    /// A listener over the streams arriving on `tunnel_stream_rx`, accepting
    /// each one's TLS with `tls_acceptor`.
    pub(crate) fn new(
        tunnel_stream_rx: mpsc::Receiver<TunnelStream>,
        tls_acceptor: TunnelTlsAcceptor,
    ) -> Self {
        Self {
            tunnel_stream_rx,
            tls_acceptor,
            handshaking: JoinSet::new(),
        }
    }
}

impl axum::serve::Listener for TunnelListener {
    type Io = TunnelTlsStream;
    type Addr = TunnelVisitor;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            // A closed `tunnel_stream_rx` (the tunnel hands over no more) or an
            // empty `handshaking` disables its branch; with both, there is no
            // connection to come. A full `handshaking` leaves the streams
            // waiting in `tunnel_stream_rx`.
            tokio::select! {
                Some(tunnel_stream) = self.tunnel_stream_rx.recv(),
                    if self.handshaking.len() < MAX_HANDSHAKING =>
                {
                    self.handshaking.spawn(handshake_tunnel_connection(
                        tunnel_stream,
                        self.tls_acceptor.clone(),
                    ));
                }
                Some(handshake) = self.handshaking.join_next() => match handshake {
                    Ok(Ok(Some(connection))) => return connection,
                    // A certificate validation, answered and closed.
                    Ok(Ok(None)) => {}
                    Ok(Err(error)) => tracing::debug!("closed a tunnel connection: {error:#}"),
                    Err(join_error) => {
                        tracing::error!("a tunnel connection's handshake failed: {join_error}");
                    }
                },
                else => std::future::pending().await,
            }
        }
    }

    /// The listener is bound to no address: the tunnel hands its streams over
    /// in process.
    fn local_addr(&self) -> io::Result<Self::Addr> {
        Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            "the tunnel listener is bound to no address",
        ))
    }
}

/// Run a handed-over `tunnel_stream`'s opening handshake, returning its TLS
/// stream with the visitor behind it. Every step a tunnel connection takes
/// before HTTP happens here, in order, all under one [`HANDSHAKE_TIMEOUT`]:
/// reading its PROXY header, then accepting its TLS with `tls_acceptor`.
/// Returns `None` for a certificate validation handshake, which is answered
/// and closed.
///
/// # Errors
///
/// Returns an error, and the connection is closed, when the header is
/// malformed (see [`read_client_address`](proxy_header::read_client_address)),
/// the TLS handshake fails (see [`TunnelTlsAcceptor::accept`]), or the two
/// don't finish in time.
async fn handshake_tunnel_connection(
    tunnel_stream: TunnelStream,
    tls_acceptor: TunnelTlsAcceptor,
) -> anyhow::Result<Option<(TunnelTlsStream, TunnelVisitor)>> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let (stream, client_address) = proxy_header::read_client_address(tunnel_stream).await?;
        let tls_stream = tls_acceptor.accept(stream).await?;
        anyhow::Ok(tls_stream.map(|tls_stream| (tls_stream, TunnelVisitor { client_address })))
    })
    .await
    .context("the PROXY header and TLS handshake didn't finish in time")?
}

#[cfg(test)]
mod tests {
    use super::proxy_header::tests::proxy_header;
    use super::tls::tests::{connect, tls_acceptor, DOMAIN};
    use super::*;
    use axum::serve::Listener;
    use rustls::pki_types::CertificateDer;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    /// The bytes an HTTP request starts with.
    const REQUEST_START: &[u8] = b"GET";

    /// A listener over a channel of `backlog` streams, with TLS for
    /// [`DOMAIN`], and the certificate a visitor trusts.
    fn listener(
        backlog: usize,
    ) -> (
        mpsc::Sender<TunnelStream>,
        TunnelListener,
        CertificateDer<'static>,
    ) {
        let (tunnel_stream_tx, tunnel_stream_rx) = mpsc::channel(backlog);
        let (tls_acceptor, certificate) = tls_acceptor();
        (
            tunnel_stream_tx,
            TunnelListener::new(tunnel_stream_rx, tls_acceptor),
            certificate,
        )
    }

    /// Hand `tunnel_stream_tx` a stream whose visitor sends `bytes`, and
    /// return the visitor's end.
    async fn hand_over(
        tunnel_stream_tx: &mpsc::Sender<TunnelStream>,
        bytes: &[u8],
    ) -> DuplexStream {
        let (mut visitor, tunnel_stream) = tokio::io::duplex(64 * 1024);
        visitor.write_all(bytes).await.expect("write");
        tunnel_stream_tx
            .send(Box::new(tunnel_stream))
            .await
            .expect("the listener takes streams");
        visitor
    }

    /// Complete the visitor's TLS handshake while the listener accepts, send
    /// the request's first bytes, and return what the accepted connection
    /// reads and the visitor behind it. The handshake runs alongside
    /// `accept`, which is what completes the server's side.
    async fn accept_over_tls(
        listener: &mut TunnelListener,
        visitor: DuplexStream,
        certificate: &CertificateDer<'static>,
    ) -> (Vec<u8>, TunnelVisitor) {
        let (client, (mut stream, tunnel_visitor)) =
            tokio::join!(connect(visitor, certificate, DOMAIN), listener.accept());
        let mut client = client.expect("the visitor's handshake completes");
        client.write_all(REQUEST_START).await.expect("write");
        let mut request_start = vec![0; REQUEST_START.len()];
        stream
            .read_exact(&mut request_start)
            .await
            .expect("the request follows");
        (request_start, tunnel_visitor)
    }

    /// The visitor's end reads the end of the stream: the server closed it.
    async fn assert_closed(visitor: &mut DuplexStream, what: &str) {
        let mut unread = Vec::new();
        assert_eq!(
            visitor.read_to_end(&mut unread).await.expect("read"),
            0,
            "{what}"
        );
    }

    #[tokio::test]
    async fn a_connection_is_accepted_with_its_visitor_address() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(1);
        for source in ["192.0.2.1:4711", "[2001:db8::1]:4711"] {
            let visitor = hand_over(&tunnel_stream_tx, &proxy_header(source)).await;

            let (request_start, tunnel_visitor) =
                accept_over_tls(&mut listener, visitor, &certificate).await;

            assert_eq!(tunnel_visitor.client_address, Some(source.parse().unwrap()));
            assert_eq!(request_start, REQUEST_START);
        }
    }

    #[tokio::test]
    async fn a_connection_without_a_header_is_accepted_with_no_visitor_address() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(1);
        let visitor = hand_over(&tunnel_stream_tx, &[]).await;

        let (request_start, tunnel_visitor) =
            accept_over_tls(&mut listener, visitor, &certificate).await;

        assert_eq!(tunnel_visitor.client_address, None);
        assert_eq!(request_start, REQUEST_START);
    }

    /// A malformed header closes that connection, unaccepted: its visitor reads
    /// the end of the stream, and the next connection is accepted.
    #[tokio::test]
    async fn a_malformed_header_closes_the_connection_and_the_next_is_accepted() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(2);
        let mut malformed = proxy_header("192.0.2.1:4711");
        malformed[ppp::v2::PROTOCOL_PREFIX.len()] = 0x11;
        let mut malformed_visitor = hand_over(&tunnel_stream_tx, &malformed).await;
        let visitor = hand_over(&tunnel_stream_tx, &[]).await;

        let (request_start, _) = accept_over_tls(&mut listener, visitor, &certificate).await;

        assert_eq!(request_start, REQUEST_START);
        assert_closed(&mut malformed_visitor, "the malformed connection is closed").await;
    }

    /// A connection that isn't TLS after its header is closed, unaccepted.
    #[tokio::test]
    async fn a_plain_http_connection_is_closed_and_the_next_is_accepted() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(2);
        let mut plain_visitor = hand_over(&tunnel_stream_tx, b"GET / HTTP/1.1\r\n\r\n").await;
        let visitor = hand_over(&tunnel_stream_tx, &[]).await;

        let (request_start, _) = accept_over_tls(&mut listener, visitor, &certificate).await;

        assert_eq!(request_start, REQUEST_START);
        let mut answer = Vec::new();
        let _ = plain_visitor.read_to_end(&mut answer).await;
        assert!(
            !answer.starts_with(b"HTTP/"),
            "no HTTP answer to a connection without TLS"
        );
    }

    /// A visitor that sends nothing doesn't hold up the connection behind it,
    /// and is closed once its time is up.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_connection_does_not_hold_up_the_next() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(2);
        let mut stalled_visitor = hand_over(&tunnel_stream_tx, &[]).await;
        let visitor = hand_over(&tunnel_stream_tx, &[]).await;

        let (request_start, _) = accept_over_tls(&mut listener, visitor, &certificate).await;
        assert_eq!(request_start, REQUEST_START);

        // Accepting again lets the stalled handshake time out.
        let next_accept = tokio::time::timeout(HANDSHAKE_TIMEOUT * 2, listener.accept()).await;
        assert!(next_accept.is_err(), "nothing else is accepted");
        assert_closed(&mut stalled_visitor, "the stalled connection is closed").await;
    }

    /// The timeout covers the TLS handshake too: a visitor that sends its
    /// PROXY header and then stalls is closed once its time is up.
    #[tokio::test(start_paused = true)]
    async fn a_connection_stalled_before_its_handshake_is_closed() {
        let (tunnel_stream_tx, mut listener, _) = listener(1);
        let mut stalled_visitor =
            hand_over(&tunnel_stream_tx, &proxy_header("192.0.2.1:4711")).await;

        let accepted = tokio::time::timeout(HANDSHAKE_TIMEOUT * 2, listener.accept()).await;

        assert!(accepted.is_err(), "nothing is accepted");
        assert_closed(&mut stalled_visitor, "the stalled connection is closed").await;
    }

    /// Past [`MAX_HANDSHAKING`] connections handshaking, the rest are left
    /// in the tunnel's backlog until one of them is done.
    #[tokio::test(start_paused = true)]
    async fn connections_past_the_cap_wait_in_the_backlog() {
        let (tunnel_stream_tx, mut listener, certificate) = listener(MAX_HANDSHAKING + 1);
        let mut stalled_visitors = Vec::new();
        for _ in 0..MAX_HANDSHAKING {
            stalled_visitors.push(hand_over(&tunnel_stream_tx, &[]).await);
        }
        let visitor = hand_over(&tunnel_stream_tx, &[]).await;

        let accepted = tokio::time::timeout(HANDSHAKE_TIMEOUT / 2, listener.accept()).await;

        assert!(accepted.is_err(), "the stalled connections fill the cap");
        assert_eq!(listener.handshaking.len(), MAX_HANDSHAKING);
        assert_eq!(listener.tunnel_stream_rx.len(), 1, "the last waits");

        // Once the stalled connections time out, the waiting one is taken.
        let (request_start, _) = accept_over_tls(&mut listener, visitor, &certificate).await;
        assert_eq!(request_start, REQUEST_START);
    }

    /// Once the tunnel hands over no more streams and none is handshaking,
    /// `accept` waits rather than spinning or returning.
    #[tokio::test(start_paused = true)]
    async fn accept_waits_once_the_tunnel_is_gone() {
        let (tunnel_stream_tx, mut listener, _) = listener(1);
        drop(tunnel_stream_tx);

        let accepted = tokio::time::timeout(Duration::from_secs(60), listener.accept()).await;

        assert!(accepted.is_err(), "nothing is accepted");
    }
}
