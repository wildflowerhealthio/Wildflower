//! One `:443` connection, start to finish.
//!
//! Read the ClientHello and take its server name, look up the device's
//! tunnel port, connect to it, send a PROXY header and the hello bytes, then
//! copy bytes both ways until either side closes or the pipe goes idle. The
//! front never decrypts anything. Every step that fails logs why and drops
//! the visitor's socket, which closes it without a byte written.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::broadcast;

use super::hello::{read_client_hello, ClientHello};
use super::idle::{Activity, Tracked};
use super::proxy_header::proxy_header;
use super::Front;
use crate::route::Route;

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
        let Some(route) = self.router.resolve(&server_name) else {
            tracing::debug!(%server_name, "refused: unknown label");
            return;
        };
        let Some(_label_permit) = self.try_acquire_label(&route.label) else {
            tracing::warn!(label = %route.label, "refused: label at its connection limit");
            return;
        };
        let Some(mut backend) = self.connect_to_tunnel(&route).await else {
            return;
        };
        let _ = client.set_nodelay(true);
        let _ = backend.set_nodelay(true);
        if !send_preface(&mut backend, visitor, relay, &hello_bytes, &route).await {
            return;
        }
        self.pipe(client, backend, &route, shutdown_rx).await;
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

    /// Connect to the device's rathole service port. rathole binds that port
    /// only while the device's tunnel is up, so a refused connect means the
    /// device is offline. This is where a known label meets a down tunnel,
    /// should the relay ever need to tell the device (wake-up push, #918).
    async fn connect_to_tunnel(&self, route: &Route) -> Option<TcpStream> {
        let connect = TcpStream::connect(route.addr);
        match tokio::time::timeout(self.limits.hello_timeout, connect).await {
            Ok(Ok(backend)) => Some(backend),
            _ => {
                tracing::info!(label = %route.label, "refused: no live tunnel for label");
                None
            }
        }
    }

    /// Copy bytes both ways until either side closes, nothing moves for the
    /// idle timeout, or the relay shuts down.
    async fn pipe(
        &self,
        client: TcpStream,
        backend: TcpStream,
        route: &Route,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) {
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
            tracing::debug!(label = %route.label, "tunnel closed before the hello was sent: {e}");
            false
        }
    }
}
