//! The tunnel listener: the visitor streams the tunnel's rathole client hands
//! over in process, served by `axum::serve` through [`TunnelListener`]. Each
//! connection is prepared for HTTP first, by [`prepare_tunnel_connection`],
//! which reads its PROXY protocol v2 header, when it has one, for the
//! visitor's address (see [`proxy_header`]). The loopback listener never reads
//! one, so nobody on this machine can claim a visitor's address.

mod proxy_header;

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;
use axum::extract::connect_info::Connected;
use axum::serve::IncomingStream;
use tokio::io::BufReader;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tunnel_rust::TunnelStream;

/// How long a tunnel connection has to send its first bytes, and its whole
/// PROXY header when it opens with one, before it is closed. The relay writes
/// the header the moment it connects, and a client with no relay in front
/// sends its request at once, so only a stalled or hostile sender waits this
/// long.
const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

/// A tunnel connection ready for HTTP: the bytes peeked for a PROXY header
/// and not part of one are read again from its buffer.
pub(crate) type PreparedTunnelStream = BufReader<TunnelStream>;

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
/// axum accepts one connection at a time, so preparing a connection inside
/// [`accept`](axum::serve::Listener::accept) would let one slow sender stall
/// every connection behind it. Instead each handed-over stream is prepared on
/// a task of its own, and `accept` returns whichever is ready first. A
/// connection that can't be prepared is closed alone. Dropping the listener,
/// which `axum::serve` does once its graceful shutdown begins, aborts the
/// preparations still running.
pub(crate) struct TunnelListener {
    /// The visitor streams the tunnel hands over.
    tunnel_streams: mpsc::Receiver<TunnelStream>,
    /// The handed-over streams being prepared.
    preparing: JoinSet<anyhow::Result<(PreparedTunnelStream, TunnelVisitor)>>,
}

impl TunnelListener {
    /// A listener over the streams arriving on `tunnel_streams`.
    pub(crate) fn new(tunnel_streams: mpsc::Receiver<TunnelStream>) -> Self {
        Self {
            tunnel_streams,
            preparing: JoinSet::new(),
        }
    }
}

impl axum::serve::Listener for TunnelListener {
    type Io = PreparedTunnelStream;
    type Addr = TunnelVisitor;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            // A closed `tunnel_streams` (the tunnel hands over no more) or an
            // empty `preparing` disables its branch; with both, there is no
            // connection to come.
            tokio::select! {
                Some(tunnel_stream) = self.tunnel_streams.recv() => {
                    self.preparing.spawn(prepare_tunnel_connection(tunnel_stream));
                }
                Some(prepared) = self.preparing.join_next() => match prepared {
                    Ok(Ok(prepared_connection)) => return prepared_connection,
                    Ok(Err(error)) => tracing::debug!("closed a tunnel connection: {error:#}"),
                    Err(join_error) => {
                        tracing::error!("preparing a tunnel connection failed: {join_error}");
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

/// Prepare a handed-over `tunnel_stream` for HTTP, returning it with the
/// visitor behind it. Every step a tunnel connection takes before HTTP
/// happens here, in order: so far, reading its PROXY header under
/// [`PROXY_HEADER_TIMEOUT`]; a TLS accept would follow it.
///
/// # Errors
///
/// Returns an error, and the connection is closed, when the header is
/// malformed or doesn't arrive in time (see
/// [`read_client_address`](proxy_header::read_client_address)).
async fn prepare_tunnel_connection(
    tunnel_stream: TunnelStream,
) -> anyhow::Result<(PreparedTunnelStream, TunnelVisitor)> {
    let mut stream = proxy_header::peekable(tunnel_stream);
    let client_address = tokio::time::timeout(
        PROXY_HEADER_TIMEOUT,
        proxy_header::read_client_address(&mut stream),
    )
    .await
    .context("no PROXY header or request in time")??;
    Ok((stream, TunnelVisitor { client_address }))
}

#[cfg(test)]
mod tests {
    use super::proxy_header::tests::proxy_header;
    use super::*;
    use axum::serve::Listener;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    /// The bytes an HTTP request starts with, after any PROXY header.
    const REQUEST_START: &[u8] = b"GET";

    /// Hand `tunnel_stream_sender` a stream whose visitor sends `bytes`, and
    /// return the visitor's end.
    async fn hand_over(
        tunnel_stream_sender: &mpsc::Sender<TunnelStream>,
        bytes: &[u8],
    ) -> DuplexStream {
        let (mut visitor, tunnel_stream) = tokio::io::duplex(1024);
        visitor.write_all(bytes).await.expect("write");
        tunnel_stream_sender
            .send(Box::new(tunnel_stream))
            .await
            .expect("the listener takes streams");
        visitor
    }

    /// The request's first bytes, read off an accepted connection.
    async fn request_start(stream: &mut PreparedTunnelStream) -> Vec<u8> {
        let mut request_start = vec![0; REQUEST_START.len()];
        stream
            .read_exact(&mut request_start)
            .await
            .expect("the request follows");
        request_start
    }

    #[tokio::test]
    async fn a_connection_is_accepted_with_its_visitor_address() {
        let (tunnel_stream_sender, tunnel_streams) = mpsc::channel(1);
        let mut listener = TunnelListener::new(tunnel_streams);
        for source in ["192.0.2.1:4711", "[2001:db8::1]:4711"] {
            let mut bytes = proxy_header(source);
            bytes.extend_from_slice(REQUEST_START);
            let _visitor = hand_over(&tunnel_stream_sender, &bytes).await;

            let (mut stream, tunnel_visitor) = listener.accept().await;

            assert_eq!(tunnel_visitor.client_address, Some(source.parse().unwrap()));
            assert_eq!(request_start(&mut stream).await, REQUEST_START);
        }
    }

    #[tokio::test]
    async fn a_connection_without_a_header_is_accepted_with_no_visitor_address() {
        let (tunnel_stream_sender, tunnel_streams) = mpsc::channel(1);
        let mut listener = TunnelListener::new(tunnel_streams);
        let _visitor = hand_over(&tunnel_stream_sender, REQUEST_START).await;

        let (mut stream, tunnel_visitor) = listener.accept().await;

        assert_eq!(tunnel_visitor.client_address, None);
        assert_eq!(request_start(&mut stream).await, REQUEST_START);
    }

    /// A malformed header closes that connection, unaccepted: its visitor reads
    /// the end of the stream, and the next connection is accepted.
    #[tokio::test]
    async fn a_malformed_header_closes_the_connection_and_the_next_is_accepted() {
        let (tunnel_stream_sender, tunnel_streams) = mpsc::channel(2);
        let mut listener = TunnelListener::new(tunnel_streams);
        let mut malformed = proxy_header("192.0.2.1:4711");
        malformed[ppp::v2::PROTOCOL_PREFIX.len()] = 0x11;
        let mut malformed_visitor = hand_over(&tunnel_stream_sender, &malformed).await;
        let _visitor = hand_over(&tunnel_stream_sender, REQUEST_START).await;

        let (mut stream, _) = listener.accept().await;

        assert_eq!(request_start(&mut stream).await, REQUEST_START);
        let mut unread = Vec::new();
        assert_eq!(
            malformed_visitor
                .read_to_end(&mut unread)
                .await
                .expect("read"),
            0,
            "the malformed connection is closed"
        );
    }

    /// A visitor that sends nothing doesn't hold up the connection behind it,
    /// and is closed once its time is up.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_connection_does_not_hold_up_the_next() {
        let (tunnel_stream_sender, tunnel_streams) = mpsc::channel(2);
        let mut listener = TunnelListener::new(tunnel_streams);
        let mut stalled_visitor = hand_over(&tunnel_stream_sender, &[]).await;
        let _visitor = hand_over(&tunnel_stream_sender, REQUEST_START).await;

        let (mut stream, _) = listener.accept().await;
        assert_eq!(request_start(&mut stream).await, REQUEST_START);

        // Accepting again lets the stalled preparation time out.
        let next_accept = tokio::time::timeout(PROXY_HEADER_TIMEOUT * 2, listener.accept()).await;
        assert!(next_accept.is_err(), "nothing else is accepted");
        let mut unread = Vec::new();
        assert_eq!(
            stalled_visitor
                .read_to_end(&mut unread)
                .await
                .expect("read"),
            0,
            "the stalled connection is closed"
        );
    }

    /// Once the tunnel hands over no more streams and none is being prepared,
    /// `accept` waits rather than spinning or returning.
    #[tokio::test(start_paused = true)]
    async fn accept_waits_once_the_tunnel_is_gone() {
        let (tunnel_stream_sender, tunnel_streams) = mpsc::channel(1);
        let mut listener = TunnelListener::new(tunnel_streams);
        drop(tunnel_stream_sender);

        let accepted = tokio::time::timeout(Duration::from_secs(60), listener.accept()).await;

        assert!(accepted.is_err(), "nothing is accepted");
    }
}
