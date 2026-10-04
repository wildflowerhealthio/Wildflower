//! The public TCP front: `:443` routes TLS by server name, `:80` redirects.
//!
//! This file holds what both listeners share: the [`Front`] (routes, limits
//! and the semaphores that enforce them) and the accept loops that hand each
//! connection to its handler. The handlers and their helpers live in their
//! own files:
//!
//! - `tls`: one `:443` connection, from ClientHello to byte pipe.
//! - `hello`: reading the ClientHello and taking its server name.
//! - `proxy_header`: the PROXY protocol v2 header sent ahead of the hello.
//! - `idle`: the idle timeout for a piped connection.
//! - `http`: one `:80` request, answered with a redirect or a 404.

mod hello;
mod http;
mod idle;
mod proxy_header;
mod tls;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, OwnedSemaphorePermit, Semaphore};

use crate::route::Router;

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
            let Some((stream, permit)) = accepted else {
                continue;
            };
            let front = Arc::clone(&self);
            let connection_shutdown_rx = shutdown_rx.resubscribe();
            tokio::spawn(async move {
                front.handle_tls(stream, connection_shutdown_rx).await;
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
            let Some((stream, permit)) = accepted else {
                continue;
            };
            let front = Arc::clone(&self);
            tokio::spawn(async move {
                front.handle_http(stream).await;
                drop(permit);
            });
        }
    }

    /// Accept one connection and take a slot from the overall limit for it.
    /// `None` if the accept failed or the front is full; a connection over
    /// the limit is dropped here, which closes it unanswered.
    async fn accept(&self, listener: &TcpListener) -> Option<(TcpStream, OwnedSemaphorePermit)> {
        let stream = match listener.accept().await {
            Ok((stream, _peer)) => stream,
            Err(e) => {
                tracing::warn!("front accept failed: {e}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                return None;
            }
        };
        let Ok(permit) = Arc::clone(&self.connections).try_acquire_owned() else {
            tracing::warn!("front at its connection limit, refusing");
            return None;
        };
        Some((stream, permit))
    }

    /// Take a slot from `label`'s own limit, or `None` if it is full.
    fn try_acquire_label(&self, label: &str) -> Option<OwnedSemaphorePermit> {
        let semaphore = {
            let mut per_label = self
                .per_label
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let semaphore = per_label
                .entry(label.to_owned())
                .or_insert_with(|| Arc::new(Semaphore::new(self.limits.max_connections_per_label)));
            Arc::clone(semaphore)
        };
        semaphore.try_acquire_owned().ok()
    }
}
