//! The public TCP front: `:443` routes TLS by server name, `:80` redirects.
//!
//! This file holds what both listeners share: the [`Front`] (routes, the
//! [`Tunnels`] it puts visitors into, the relay's own site, limits, the
//! semaphores that enforce them and the [`ConnectionOutcomes`] `:443`
//! records into) and the accept loops that hand each connection to its
//! handler. A `:443` connection dropped at the connection limit is counted
//! as [`Outcome::OverConnectionLimit`](crate::domain::Outcome::OverConnectionLimit)
//! and logged, with its address, to the connection log; `:80` is never
//! counted or logged. The handlers and their helpers live in their own
//! files:
//!
//! - `tls`: one `:443` connection, from ClientHello to byte pipe, or to the
//!   relay's own site for a local hostname.
//! - `hello`: reading the ClientHello and taking its server name.
//! - `refusal`: why a `:443` connection was refused, and its line in the
//!   connection log.
//! - `http`: one `:80` request, answered with a redirect or a 404.

mod hello;
mod http;
mod refusal;
mod tls;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};

use self::refusal::{Refusal, Visitor};
use crate::outcomes::ConnectionOutcomes;
use crate::route::Router;
use crate::site::Site;
use crate::tunnels::Tunnels;

/// Pause after a failed `accept` (e.g. out of file descriptors) so the loop
/// does not spin.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

/// Connection limits and timeouts for the front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Concurrent connections across `:443` and `:80` together.
    pub max_connections: usize,
    /// Deadline for a complete ClientHello (or HTTP request head), and for
    /// the relay's own site to finish a TLS handshake.
    pub hello_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 4096,
            hello_timeout: Duration::from_secs(5),
        }
    }
}

/// The shared state behind both listeners: routes, the tunnels, the site for
/// local hostnames, limits, the semaphore that enforces the connection
/// limit, and what `:443` records about each connection.
#[derive(Debug)]
pub struct Front {
    router: Arc<Router>,
    /// Takes each visitor to the rathole service of its tunnel.
    tunnels: Tunnels,
    site: Site,
    limits: Limits,
    connections: Arc<Semaphore>,
    /// Each `:443` connection's outcome, shared with the admin API.
    outcomes: Arc<ConnectionOutcomes>,
}

impl Front {
    #[must_use]
    pub fn new(
        router: Arc<Router>,
        tunnels: Tunnels,
        site: Site,
        limits: Limits,
        outcomes: Arc<ConnectionOutcomes>,
    ) -> Arc<Self> {
        Arc::new(Self {
            router,
            tunnels,
            site,
            limits,
            connections: Arc::new(Semaphore::new(limits.max_connections)),
            outcomes,
        })
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
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        loop {
            let accepted = tokio::select! {
                accepted = self.accept(&listener) => accepted,
                _ = shutdown_rx.recv() => return Ok(()),
            };
            let Some((stream, address)) = accepted else {
                continue;
            };
            let visitor = Visitor {
                address,
                accepted_at: Instant::now(),
            };
            let Some(permit) = self.permit() else {
                self.refuse(&visitor, Refusal::OverConnectionLimit);
                continue;
            };
            let front = Arc::clone(&self);
            let connection_shutdown_rx = shutdown_rx.resubscribe();
            tokio::spawn(async move {
                front
                    .handle_tls(stream, visitor, connection_shutdown_rx)
                    .await;
                drop(permit);
            });
        }
    }

    /// Serve the `:80` redirect on `listener` until shutdown.
    ///
    /// # Errors
    ///
    /// Currently never; see [`Front::serve_https`].
    pub async fn serve_http(
        self: Arc<Self>,
        listener: TcpListener,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        loop {
            let accepted = tokio::select! {
                accepted = self.accept(&listener) => accepted,
                _ = shutdown_rx.recv() => return Ok(()),
            };
            let Some((stream, _address)) = accepted else {
                continue;
            };
            let Some(permit) = self.permit() else {
                continue;
            };
            let front = Arc::clone(&self);
            tokio::spawn(async move {
                front.handle_http(stream).await;
                drop(permit);
            });
        }
    }

    /// Accept one connection, with its peer's address, or `None` if the
    /// accept failed.
    async fn accept(&self, listener: &TcpListener) -> Option<(TcpStream, SocketAddr)> {
        match listener.accept().await {
            Ok(accepted) => Some(accepted),
            Err(e) => {
                tracing::warn!("front accept failed: {e}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                None
            }
        }
    }

    /// Take a slot from the overall limit for a connection just accepted, or
    /// `None` if the front is full. A connection without one is dropped,
    /// which closes it unanswered.
    fn permit(&self) -> Option<OwnedSemaphorePermit> {
        let permit = Arc::clone(&self.connections).try_acquire_owned().ok();
        if permit.is_none() {
            tracing::warn!("front at its connection limit, refusing");
        }
        permit
    }
}
