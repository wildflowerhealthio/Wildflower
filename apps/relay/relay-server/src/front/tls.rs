//! One `:443` connection, start to finish.
//!
//! Read the ClientHello and take its server name. For one of the relay's
//! local hostnames, hand the connection, hello bytes first, to the relay's
//! own site, which terminates TLS. Otherwise hand rathole one end of an
//! in-process pipe as a visitor of the device's tunnel, send a PROXY header
//! and the hello bytes into the other, then copy bytes both ways between it
//! and the visitor's socket until either side closes. TCP keepalive on the
//! socket clears out a visitor that vanished without closing; an idle but
//! live connection is the device's HTTP server's to close. The front never
//! decrypts a tunnel's traffic. Every step that fails logs why and drops the
//! visitor's socket, which closes it without a byte written.
//!
//! Each connection not for a local hostname is recorded in the
//! [`ConnectionOutcomes`](crate::outcomes::ConnectionOutcomes) once, where
//! its outcome is known: a refusal before routing as an
//! [`Outcome`](crate::domain::Outcome), and a routed connection as its
//! tunnel's [`TunnelOutcome`], `ok` once the PROXY header and hello are
//! written. Each refusal is also logged to the connection log, with the
//! visitor's address and what it sent or asked for (see `refusal`). A
//! connection that reaches its tunnel is not logged: its visitor's address
//! goes only into the PROXY header.

use std::net::SocketAddr;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};

use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

use wildflowerhealthio_rathole_settings::proxy_header::proxy_header;

use super::hello::{read_client_hello, ClientHello, HelloParser};
use super::refusal::{FirstBytes, NotAHello, Refusal, TunnelRefusal, Visitor};
use super::Front;
use crate::domain::TunnelOutcome;
use crate::route::{Destination, Route};
use crate::tunnels::TunnelDown;

impl Front {
    /// Route one `:443` connection, from `visitor`.
    pub(super) async fn handle_tls(
        &self,
        mut client: TcpStream,
        visitor: Visitor,
        shutdown_rx: broadcast::Receiver<bool>,
    ) {
        let relay = match client.local_addr() {
            Ok(relay) => relay,
            Err(error) => {
                // The socket failed before a byte was read from it.
                let refusal = Refusal::NotAHello {
                    first_bytes: FirstBytes::of(&[]),
                    ended: NotAHello::ReadFailed(error),
                };
                self.refuse(&visitor, refusal);
                return;
            }
        };
        let (hello_bytes, server_name) = match self.read_server_name(&mut client).await {
            Ok(read) => read,
            Err(refusal) => {
                self.refuse(&visitor, refusal);
                return;
            }
        };
        let route = match self.router.resolve(&server_name) {
            Some(Destination::Tunnel(route)) => route,
            Some(Destination::Local(_)) => {
                self.serve_site(client, visitor.address, hello_bytes, shutdown_rx)
                    .await;
                return;
            }
            None => {
                self.refuse(&visitor, Refusal::UnknownTunnel { server_name });
                return;
            }
        };
        let mut backend = match self.connect_to_tunnel(&route).await {
            Ok(backend) => backend,
            Err(refusal) => {
                self.refuse(&visitor, Refusal::at(route, refusal));
                return;
            }
        };
        tune(&client);
        if let Err(refusal) = send_preface(&mut backend, visitor.address, relay, &hello_bytes).await
        {
            self.refuse(&visitor, Refusal::at(route, refusal));
            return;
        }
        self.outcomes
            .record_for_tunnel(&route.tunnel_name, TunnelOutcome::Ok);
        self.pipe(client, backend, shutdown_rx).await;
    }

    /// Hand the connection from `visitor` to the relay's own site. The site's
    /// TLS reads the hello bytes already taken off the socket first, then the
    /// socket.
    async fn serve_site(
        &self,
        client: TcpStream,
        visitor: SocketAddr,
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
            .serve(rewound, visitor, self.limits.hello_timeout, shutdown_rx)
            .await;
    }

    /// The ClientHello's bytes (to replay) and its server name, or, if the
    /// visitor sent no usable hello in time, the refusal, with what it did
    /// send.
    async fn read_server_name(&self, client: &mut TcpStream) -> Result<(Vec<u8>, String), Refusal> {
        let mut parser = HelloParser::default();
        let read = tokio::time::timeout(
            self.limits.hello_timeout,
            read_client_hello(client, &mut parser),
        )
        .await;
        let not_a_hello = |ended| Refusal::NotAHello {
            first_bytes: FirstBytes::of(parser.received()),
            ended,
        };
        let refusal = match read {
            Ok(Ok(ClientHello::ServerName(name))) => return Ok((parser.into_received(), name)),
            Ok(Ok(ClientHello::NoServerName(hello))) => Refusal::NoServerName(hello),
            // `read_client_hello` gives a verdict, so never `Incomplete`.
            Ok(Ok(ClientHello::Incomplete | ClientHello::Invalid)) => {
                not_a_hello(NotAHello::Invalid)
            }
            Ok(Ok(ClientHello::Closed)) => not_a_hello(NotAHello::Closed),
            Ok(Err(e)) => not_a_hello(NotAHello::ReadFailed(e)),
            Err(_) => Refusal::HelloTimeout {
                bytes_received: parser.received().len(),
            },
        };
        Err(refusal)
    }

    /// Hand rathole one end of a pipe as a visitor of the tunnel, and return
    /// the other. The tunnel takes a visitor only while the device is
    /// connected and refuses it with [`TunnelDown`] otherwise. That refusal
    /// is where a known tunnel meets a down one, should the relay ever need
    /// to tell the device (wake-up push, #918). It waits only while the
    /// tunnel's queue of visitors is full, so running out of time means the
    /// device is connected but not taking visitors, not that it is down.
    async fn connect_to_tunnel(&self, route: &Route) -> Result<DuplexStream, TunnelRefusal> {
        let (backend, visitor) = tokio::io::duplex(PIPE_BUFFER_SIZE);
        let connect = self.tunnels.connect(&route.tunnel_name, visitor);
        match tokio::time::timeout(self.limits.hello_timeout, connect).await {
            Ok(Ok(())) => Ok(backend),
            Ok(Err(TunnelDown)) => Err(TunnelRefusal::Down),
            Err(_) => Err(TunnelRefusal::Busy),
        }
    }

    /// Copy bytes both ways until either side closes or the relay shuts
    /// down.
    async fn pipe(
        &self,
        mut client: TcpStream,
        mut backend: DuplexStream,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) {
        tokio::select! {
            result = tokio::io::copy_bidirectional(&mut client, &mut backend) => {
                if let Err(e) = result {
                    tracing::debug!("pipe ended: {e}");
                }
            }
            _ = shutdown_rx.recv() => {}
        }
    }
}

/// Bytes the pipe to a tunnel buffers in each direction.
const PIPE_BUFFER_SIZE: usize = 64 * 1024;

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
/// keepalive on a visitor's socket, piped or served by the site. Failures are
/// ignored: neither is needed for correctness.
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
/// as one write, or say why that failed.
async fn send_preface(
    backend: &mut (impl AsyncWrite + Unpin),
    visitor: SocketAddr,
    relay: SocketAddr,
    hello_bytes: &[u8],
) -> Result<(), TunnelRefusal> {
    let mut preface = proxy_header(visitor, relay).map_err(TunnelRefusal::ProxyHeaderFailed)?;
    preface.extend_from_slice(hello_bytes);
    backend
        .write_all(&preface)
        .await
        .map_err(TunnelRefusal::Closed)
}
