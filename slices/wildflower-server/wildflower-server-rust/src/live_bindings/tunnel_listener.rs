//! The tunnel listener: the loopback listener rathole forwards each tunnel
//! connection to, served by `axum::serve` through [`TunnelListener`]. Before a
//! connection reaches HTTP, its PROXY protocol v2 header, when it has one, is
//! read off and the visitor's address kept (see [`proxy_header`]). The local
//! listener never reads one, so nobody on this machine can claim a visitor's
//! address.

mod proxy_header;

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// How long a tunnel connection has to send its first bytes, and its whole
/// PROXY header when it opens with one, before it is closed. The relay front
/// writes the header the moment it connects, and a client without a front
/// sends its request at once, so only a stalled or hostile sender waits this
/// long.
const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

/// How many connections whose PROXY header has been read may wait for
/// `axum::serve` to take them.
const ADMITTED_CONNECTION_BACKLOG: usize = 64;

/// The addresses of a tunnel connection: its socket peer and the visitor
/// behind it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TunnelPeer {
    /// The socket peer: the in-process rathole client, on loopback.
    pub(crate) peer: SocketAddr,
    /// The visitor's address, from the connection's PROXY header. `None` when
    /// it had no header or the header named no address.
    pub(crate) client_address: Option<SocketAddr>,
}

/// An `axum::serve` listener over the tunnel listener's admitted connections:
/// each one has had its PROXY header, if any, read off.
///
/// # Remarks
///
/// axum accepts from a listener one connection at a time, so reading a header
/// inside [`accept`](axum::serve::Listener::accept) would let one slow sender
/// stall every connection behind it. Instead an accept loop spawns a task per
/// connection to read its header under [`PROXY_HEADER_TIMEOUT`], and hands the
/// connection over a channel once it is read. A malformed header or a timeout
/// closes that connection alone.
///
/// The accept loop stops, and the port closes, once this listener is dropped,
/// which `axum::serve` does when its graceful shutdown begins.
pub(crate) struct TunnelListener {
    admitted_connections: mpsc::Receiver<(TcpStream, TunnelPeer)>,
    local_addr: SocketAddr,
}

impl TunnelListener {
    /// Start accepting tunnel connections on `listener`, on the current
    /// runtime.
    ///
    /// # Errors
    ///
    /// Returns an error if `listener`'s address can't be read.
    pub(crate) fn new(listener: TcpListener) -> io::Result<Self> {
        let local_addr = listener.local_addr()?;
        let (admitted_sender, admitted_connections) = mpsc::channel(ADMITTED_CONNECTION_BACKLOG);
        tokio::spawn(accept_connections(listener, admitted_sender));
        Ok(Self {
            admitted_connections,
            local_addr,
        })
    }
}

impl axum::serve::Listener for TunnelListener {
    type Io = TcpStream;
    type Addr = TunnelPeer;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.admitted_connections.recv().await {
            Some(admitted_connection) => admitted_connection,
            // The accept loop holds a sender for as long as this listener
            // lives, so the channel closes only if that task is gone with its
            // runtime. No connection will arrive again.
            None => std::future::pending().await,
        }
    }

    /// The listener's own address, naming no visitor. axum's `Addr` stands
    /// for both ends of a connection.
    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(TunnelPeer {
            peer: self.local_addr,
            client_address: None,
        })
    }
}

/// Accept connections on `listener` until `admitted_sender`'s receiver is
/// dropped, admitting each on a task of its own.
async fn accept_connections(
    mut listener: TcpListener,
    admitted_sender: mpsc::Sender<(TcpStream, TunnelPeer)>,
) {
    loop {
        // axum's `TcpListener` accept retries transient errors itself.
        let (stream, peer) = tokio::select! {
            () = admitted_sender.closed() => return,
            accepted = axum::serve::Listener::accept(&mut listener) => accepted,
        };
        tokio::spawn(admit_connection(
            stream,
            peer,
            admitted_sender.clone(),
            PROXY_HEADER_TIMEOUT,
        ));
    }
}

/// Read `stream`'s PROXY header under `header_timeout` and hand the connection
/// to `admitted_sender`, or close it when the header is malformed or late.
async fn admit_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    admitted_sender: mpsc::Sender<(TcpStream, TunnelPeer)>,
    header_timeout: Duration,
) {
    let client_address = match tokio::time::timeout(
        header_timeout,
        proxy_header::read_client_address(&mut stream),
    )
    .await
    {
        Ok(Ok(client_address)) => client_address,
        Ok(Err(error)) => {
            tracing::debug!(%peer, "closed a tunnel connection: {error:#}");
            return;
        }
        Err(_elapsed) => {
            tracing::debug!(%peer, "closed a tunnel connection that sent no PROXY header in time");
            return;
        }
    };
    let tunnel_peer = TunnelPeer {
        peer,
        client_address,
    };
    if admitted_sender.send((stream, tunnel_peer)).await.is_err() {
        tracing::debug!(%peer, "closed a tunnel connection admitted after shutdown began");
    }
}

#[cfg(test)]
mod tests {
    use super::proxy_header::tests::{connected_pair, proxy_header};
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Admit the server end of a connection whose client sent `bytes`, under
    /// `header_timeout`. Returns the client end and what was admitted, if
    /// anything.
    async fn admitted_after_sending(
        bytes: &[u8],
        header_timeout: Duration,
    ) -> (TcpStream, Option<(TcpStream, TunnelPeer)>) {
        let (mut client, server) = connected_pair().await;
        client.write_all(bytes).await.expect("write");
        let peer = server.peer_addr().expect("peer");
        let (admitted_sender, mut admitted_connections) = mpsc::channel(1);
        admit_connection(server, peer, admitted_sender, header_timeout).await;
        (client, admitted_connections.recv().await)
    }

    #[tokio::test]
    async fn a_connection_is_admitted_with_its_visitor_address() {
        let mut bytes = proxy_header("192.0.2.1:4711");
        bytes.extend_from_slice(b"GET");

        let (_client, admitted) = admitted_after_sending(&bytes, PROXY_HEADER_TIMEOUT).await;

        let (mut stream, tunnel_peer) = admitted.expect("admitted");
        assert!(tunnel_peer.peer.ip().is_loopback());
        assert_eq!(
            tunnel_peer.client_address,
            Some("192.0.2.1:4711".parse().unwrap())
        );
        let mut request_start = [0; 3];
        stream
            .read_exact(&mut request_start)
            .await
            .expect("the request follows the header");
        assert_eq!(&request_start, b"GET");
    }

    #[tokio::test]
    async fn a_connection_without_a_header_is_admitted_with_no_visitor() {
        let (_client, admitted) = admitted_after_sending(b"GET", PROXY_HEADER_TIMEOUT).await;

        let (_, tunnel_peer) = admitted.expect("admitted");
        assert_eq!(tunnel_peer.client_address, None);
    }

    /// A malformed header, or none in time, closes the connection: nothing is
    /// admitted and the client reads the end of the stream.
    #[tokio::test]
    async fn a_malformed_or_late_header_closes_the_connection() {
        let mut malformed = proxy_header("192.0.2.1:4711");
        malformed[12] = 0x11;
        for (bytes, header_timeout) in [
            (&malformed[..], PROXY_HEADER_TIMEOUT),
            (&malformed[..5], Duration::from_millis(50)),
            (&[][..], Duration::from_millis(50)),
        ] {
            let (mut client, admitted) = admitted_after_sending(bytes, header_timeout).await;

            assert!(admitted.is_none(), "{bytes:?}");
            let mut rest = Vec::new();
            // A close with unread bytes may arrive as a reset rather than EOF.
            let closed = client.read_to_end(&mut rest).await;
            assert!(closed.map_or(true, |read| read == 0), "{bytes:?}");
        }
    }
}
