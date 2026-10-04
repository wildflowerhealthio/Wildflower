//! One `:443` connection, start to finish.
//!
//! Read the ClientHello and take its server name. For one of the relay's
//! local hostnames, hand the connection, hello bytes first, to the relay's
//! own site, which terminates TLS. Otherwise look up the device's tunnel
//! port, connect to it, send a PROXY header and the hello bytes, then copy
//! bytes both ways until either side closes. TCP keepalive on both sockets
//! clears out a peer that vanished without closing; an idle but live
//! connection is the device's HTTP server's to close. The front never
//! decrypts a tunnel's traffic. Every step that fails logs why and drops the
//! visitor's socket, which closes it without a byte written.

use std::net::SocketAddr;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

use super::hello::{read_client_hello, ClientHello};
use super::proxy_header::proxy_header;
use super::Front;
use crate::route::{Destination, Route};

impl Front {
    /// Route one `:443` connection.
    pub(super) async fn handle_tls(
        &self,
        mut client: TcpStream,
        shutdown_rx: broadcast::Receiver<bool>,
    ) {
        let (Ok(visitor), Ok(relay)) = (client.peer_addr(), client.local_addr()) else {
            return;
        };
        let Some((hello_bytes, server_name)) = self.read_server_name(&mut client).await else {
            return;
        };
        let route = match self.router.resolve(&server_name) {
            Some(Destination::Tunnel(route)) => route,
            Some(Destination::Local(_)) => {
                self.serve_site(client, hello_bytes, shutdown_rx).await;
                return;
            }
            None => {
                tracing::debug!(%server_name, "refused: unknown tunnel");
                return;
            }
        };
        let Some(mut backend) = self.connect_to_tunnel(&route).await else {
            return;
        };
        tune(&client);
        tune(&backend);
        if !send_preface(&mut backend, visitor, relay, &hello_bytes, &route).await {
            return;
        }
        self.pipe(client, backend, &route, shutdown_rx).await;
    }

    /// Hand the connection to the relay's own site. The site's TLS reads the
    /// hello bytes already taken off the socket first, then the socket.
    async fn serve_site(
        &self,
        client: TcpStream,
        hello_bytes: Vec<u8>,
        shutdown_rx: broadcast::Receiver<bool>,
    ) {
        tune(&client);
        let (client_read, client_write) = client.into_split();
        let rewound = tokio::io::join(
            std::io::Cursor::new(hello_bytes).chain(client_read),
            client_write,
        );
        self.site
            .serve(rewound, self.limits.hello_timeout, shutdown_rx)
            .await;
    }

    /// The ClientHello's bytes (to replay) and its server name, or `None`
    /// if the visitor sent no usable hello in time.
    async fn read_server_name(&self, client: &mut TcpStream) -> Option<(Vec<u8>, String)> {
        let read = tokio::time::timeout(self.limits.hello_timeout, read_client_hello(client)).await;
        let (bytes, hello) = match read {
            Ok(Ok(read)) => read,
            Ok(Err(e)) => {
                tracing::debug!("refused: reading ClientHello failed: {e}");
                return None;
            }
            Err(_) => {
                tracing::debug!("refused: no ClientHello within the deadline");
                return None;
            }
        };
        match hello {
            ClientHello::ServerName(name) => Some((bytes, name)),
            other => {
                tracing::debug!(hello = ?other, "refused: no usable server name");
                None
            }
        }
    }

    /// Connect to the tunnel's loopback port. rathole binds it only while the
    /// device is connected, so a refused connect means the tunnel is down.
    /// This is where a known tunnel meets a down one, should the relay ever
    /// need to tell the device (wake-up push, #918).
    async fn connect_to_tunnel(&self, route: &Route) -> Option<TcpStream> {
        let connect = TcpStream::connect(route.addr);
        match tokio::time::timeout(self.limits.hello_timeout, connect).await {
            Ok(Ok(backend)) => Some(backend),
            _ => {
                tracing::info!(tunnel = %route.tunnel_name, "refused: tunnel is down");
                None
            }
        }
    }

    /// Copy bytes both ways until either side closes or the relay shuts
    /// down.
    async fn pipe(
        &self,
        mut client: TcpStream,
        mut backend: TcpStream,
        route: &Route,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) {
        tokio::select! {
            result = tokio::io::copy_bidirectional(&mut client, &mut backend) => {
                if let Err(e) = result {
                    tracing::debug!(tunnel = %route.tunnel_name, "pipe ended: {e}");
                }
            }
            _ = shutdown_rx.recv() => {}
        }
    }
}

/// First keepalive probe after this long with nothing received.
const KEEPALIVE_TIME: Duration = Duration::from_secs(60);
/// Gap between unanswered probes.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// Unanswered probes before the kernel drops the connection, so a vanished
/// peer is noticed after about two minutes.
#[cfg(any(target_os = "linux", target_os = "macos"))]
const KEEPALIVE_RETRIES: u32 = 6;

/// Set TCP_NODELAY (the bytes are TLS records, already framed) and TCP
/// keepalive on a piped socket or one the site serves. Failures are ignored:
/// neither is needed for correctness.
fn tune(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let keepalive = TcpKeepalive::new().with_time(KEEPALIVE_TIME);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let keepalive = keepalive
        .with_interval(KEEPALIVE_INTERVAL)
        .with_retries(KEEPALIVE_RETRIES);
    let _ = SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

/// Write the PROXY header and then the visitor's hello bytes to the tunnel,
/// as one write. `false` if that failed.
async fn send_preface(
    backend: &mut TcpStream,
    visitor: SocketAddr,
    relay: SocketAddr,
    hello_bytes: &[u8],
    route: &Route,
) -> bool {
    let mut preface = match proxy_header(visitor, relay) {
        Ok(header) => header,
        Err(e) => {
            tracing::warn!("refused: building PROXY header failed: {e}");
            return false;
        }
    };
    preface.extend_from_slice(hello_bytes);
    match backend.write_all(&preface).await {
        Ok(()) => true,
        Err(e) => {
            tracing::debug!(tunnel = %route.tunnel_name, "tunnel closed before the hello was sent: {e}");
            false
        }
    }
}
