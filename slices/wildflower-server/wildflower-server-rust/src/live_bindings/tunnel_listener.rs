//! The tunnel listener: the tunnel connections the rathole client hands over
//! in process, served by `axum::serve` through [`TunnelListener`]. Before a
//! connection reaches HTTP, its PROXY protocol v2 header, when it has one, is
//! read off and the visitor's address kept (see [`proxy_header`]). The local
//! listener never reads one, so nobody on this machine can claim a visitor's
//! address.

mod proxy_header;

use std::io;
use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::BufReader;
use tokio::sync::mpsc;
use tunnel_rust::{TunnelConnection, TunnelStream};

/// How long a tunnel connection has to send its first bytes, and its whole
/// PROXY header when it opens with one, before it is closed. The relay front
/// writes the header the moment it connects, and a client without a front
/// sends its request at once, so only a stalled or hostile sender waits this
/// long.
const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(5);

/// How many connections whose PROXY header has been read may wait for
/// `axum::serve` to take them.
const ADMITTED_CONNECTION_BACKLOG: usize = 64;

/// A tunnel connection's stream once admitted: the bytes peeked for a PROXY
/// header and not part of one are read again from its buffer.
pub(crate) type AdmittedStream = BufReader<TunnelStream>;

/// The visitor behind a tunnel connection.
#[derive(Debug, Clone, Copy)]
pub(crate) struct TunnelPeer {
    /// The visitor's address, from the connection's PROXY header. `None` when
    /// it had no header or the header named no address.
    pub(crate) client_address: Option<SocketAddr>,
}

/// An `axum::serve` listener over the tunnel's admitted connections: each one
/// has had its PROXY header, if any, read off.
///
/// # Remarks
///
/// axum accepts from a listener one connection at a time, so reading a header
/// inside [`accept`](axum::serve::Listener::accept) would let one slow sender
/// stall every connection behind it. Instead a loop takes each connection the
/// rathole client hands over, spawns a task to read its header under
/// [`PROXY_HEADER_TIMEOUT`], and hands the connection on once it is read. A
/// malformed header or a timeout closes that connection alone.
///
/// The loop stops once this listener is dropped, which `axum::serve` does when
/// its graceful shutdown begins, or once the tunnel slice's senders are gone.
pub(crate) struct TunnelListener {
    admitted_connections: mpsc::Receiver<(AdmittedStream, TunnelPeer)>,
}

impl TunnelListener {
    /// Start admitting the connections on `tunnel_connections`, on the current
    /// runtime.
    pub(crate) fn new(tunnel_connections: mpsc::Receiver<TunnelConnection>) -> Self {
        let (admitted_sender, admitted_connections) = mpsc::channel(ADMITTED_CONNECTION_BACKLOG);
        tokio::spawn(accept_connections(tunnel_connections, admitted_sender));
        Self {
            admitted_connections,
        }
    }
}

impl axum::serve::Listener for TunnelListener {
    type Io = AdmittedStream;
    type Addr = TunnelPeer;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.admitted_connections.recv().await {
            Some(admitted_connection) => admitted_connection,
            // The accept loop has stopped: the tunnel slice will hand over no
            // more connections.
            None => std::future::pending().await,
        }
    }

    /// The listener has no address of its own, and names no visitor.
    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(TunnelPeer {
            client_address: None,
        })
    }
}

/// Take each connection on `tunnel_connections` until `admitted_sender`'s
/// receiver is dropped, admitting each on a task of its own.
async fn accept_connections(
    mut tunnel_connections: mpsc::Receiver<TunnelConnection>,
    admitted_sender: mpsc::Sender<(AdmittedStream, TunnelPeer)>,
) {
    loop {
        let tunnel_connection = tokio::select! {
            () = admitted_sender.closed() => return,
            tunnel_connection = tunnel_connections.recv() => tunnel_connection,
        };
        // Every sender is gone: the tunnel slice will hand over no more.
        let Some(tunnel_connection) = tunnel_connection else {
            return;
        };
        tokio::spawn(admit_connection(
            proxy_header::peekable(tunnel_connection.stream),
            admitted_sender.clone(),
            PROXY_HEADER_TIMEOUT,
        ));
    }
}

/// Read `stream`'s PROXY header under `header_timeout` and hand the connection
/// to `admitted_sender`, or close it when the header is malformed or late.
async fn admit_connection(
    mut stream: AdmittedStream,
    admitted_sender: mpsc::Sender<(AdmittedStream, TunnelPeer)>,
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
            tracing::debug!("closed a tunnel connection: {error:#}");
            return;
        }
        Err(_elapsed) => {
            tracing::debug!("closed a tunnel connection that sent no PROXY header in time");
            return;
        }
    };
    let tunnel_peer = TunnelPeer { client_address };
    if admitted_sender.send((stream, tunnel_peer)).await.is_err() {
        tracing::debug!("closed a tunnel connection admitted after shutdown began");
    }
}

#[cfg(test)]
mod tests {
    use super::proxy_header::tests::proxy_header;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    /// Admit a tunnel connection whose client sent `bytes`, under
    /// `header_timeout`. Returns the client end and what was admitted, if
    /// anything.
    async fn admitted_after_sending(
        bytes: &[u8],
        header_timeout: Duration,
    ) -> (DuplexStream, Option<(AdmittedStream, TunnelPeer)>) {
        let (mut client, server) = tokio::io::duplex(1024);
        client.write_all(bytes).await.expect("write");
        let (admitted_sender, mut admitted_connections) = mpsc::channel(1);
        admit_connection(
            proxy_header::peekable(Box::new(server)),
            admitted_sender,
            header_timeout,
        )
        .await;
        (client, admitted_connections.recv().await)
    }

    #[tokio::test]
    async fn a_connection_is_admitted_with_its_visitor_address() {
        let mut bytes = proxy_header("192.0.2.1:4711");
        bytes.extend_from_slice(b"GET");

        let (_client, admitted) = admitted_after_sending(&bytes, PROXY_HEADER_TIMEOUT).await;

        let (mut stream, tunnel_peer) = admitted.expect("admitted");
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

        let (mut stream, tunnel_peer) = admitted.expect("admitted");
        assert_eq!(tunnel_peer.client_address, None);
        let mut request_start = [0; 3];
        stream
            .read_exact(&mut request_start)
            .await
            .expect("the peeked bytes are read again");
        assert_eq!(&request_start, b"GET");
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
            let read = client.read_to_end(&mut rest).await.expect("read");
            assert_eq!(read, 0, "{bytes:?}");
        }
    }

    /// A connection the tunnel slice hands over is served, and the loop ends
    /// with the slice's senders.
    #[tokio::test]
    async fn handed_over_connections_are_admitted_until_the_senders_are_gone() {
        let (tunnel_connection_sender, tunnel_connections) = mpsc::channel(1);
        let mut listener = TunnelListener::new(tunnel_connections);
        let (mut client, server) = tokio::io::duplex(1024);
        client.write_all(b"GET").await.expect("write");
        tunnel_connection_sender
            .send(TunnelConnection {
                service_name: "dev1".to_owned(),
                stream: Box::new(server),
            })
            .await
            .expect("the listener takes connections");

        let (_, tunnel_peer) = axum::serve::Listener::accept(&mut listener).await;
        assert_eq!(tunnel_peer.client_address, None);

        drop(tunnel_connection_sender);
        assert!(listener.admitted_connections.recv().await.is_none());
    }
}
