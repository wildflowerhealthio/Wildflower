//! The relay's rathole server and the tunnels it holds open.
//!
//! rathole runs with a visitor queue for each tunnel (see
//! [`rathole::run_server_with_visitor_queue`]) and binds no port for one.
//! While a device's control channel is up, rathole reports the queue its
//! tunnel takes visitors on; [`Tunnels`] keeps it by tunnel name until
//! rathole reports the tunnel disconnected, and the front puts each visitor
//! into it. A tunnel with no queue, or whose queue has closed because rathole
//! noticed the control channel die, is down. A tunnel deleted through the
//! admin API is disconnected too, once rathole drops its service.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use rathole::{AsyncStream, ConfigChange, ServerServiceEvent};
use tokio::sync::{broadcast, mpsc};

/// Where rathole takes a tunnel's visitors.
type VisitorQueue = mpsc::Sender<Box<dyn AsyncStream>>;

/// A visitor of a tunnel whose device is not connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TunnelDown;

/// The visitor queue of each tunnel whose device is connected, shared by the
/// front and the rathole server that fills it in. The default has no
/// tunnels up.
#[derive(Debug, Clone, Default)]
pub struct Tunnels {
    visitor_queues: Arc<Mutex<HashMap<String, VisitorQueue>>>,
}

impl Tunnels {
    /// Run rathole on `config` until `shutdown_rx` fires, adding and
    /// deleting services as `changes` says (see
    /// [`TunnelRegistry`](crate::TunnelRegistry)) and keeping each tunnel's
    /// visitor queue while its device is connected.
    ///
    /// # Errors
    ///
    /// Returns an error if rathole exits with one, e.g. the control port
    /// cannot be bound.
    pub async fn serve(
        self,
        config: rathole::Config,
        changes: mpsc::Receiver<ConfigChange>,
        shutdown_rx: broadcast::Receiver<bool>,
    ) -> anyhow::Result<()> {
        let (event_tx, mut events) = mpsc::unbounded_channel();
        let server_lifetime =
            rathole::run_server_with_visitor_queue(config, shutdown_rx, changes, event_tx);
        tokio::pin!(server_lifetime);
        loop {
            tokio::select! {
                result = &mut server_lifetime => return result,
                Some(event) = events.recv() => self.apply(event),
            }
        }
    }

    /// Keep or forget a tunnel's visitor queue. rathole reports a replaced
    /// control channel disconnected before it reports the new one connected,
    /// so the last event for a name is always the one that holds.
    fn apply(&self, event: ServerServiceEvent) {
        let mut visitor_queues = self
            .visitor_queues
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match event {
            ServerServiceEvent::TcpConnected { config, visitor_tx } => {
                tracing::info!(tunnel = %config.name, "tunnel up");
                visitor_queues.insert(config.name, visitor_tx);
            }
            // Every tunnel is a TCP service.
            ServerServiceEvent::UdpConnected { .. } => {}
            ServerServiceEvent::Disconnected { name } => {
                if visitor_queues.remove(&name).is_some() {
                    tracing::info!(tunnel = %name, "tunnel down");
                }
            }
        }
    }

    /// Put `visitor` into the queue of the tunnel `tunnel_name`, for rathole
    /// to forward to its device. Waits only while the queue is full.
    ///
    /// # Errors
    ///
    /// [`TunnelDown`] at once if the tunnel's device is not connected.
    pub async fn connect(
        &self,
        tunnel_name: &str,
        visitor: impl AsyncStream,
    ) -> Result<(), TunnelDown> {
        let visitor_queue = self
            .visitor_queues
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(tunnel_name)
            .cloned()
            .ok_or(TunnelDown)?;
        visitor_queue
            .send(Box::new(visitor))
            .await
            .map_err(|_| TunnelDown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connected(name: &str) -> (ServerServiceEvent, mpsc::Receiver<Box<dyn AsyncStream>>) {
        let (visitor_tx, visitor_rx) = mpsc::channel(1);
        let event = ServerServiceEvent::TcpConnected {
            config: rathole::ServerServiceConfig::with_name(name),
            visitor_tx,
        };
        (event, visitor_rx)
    }

    fn disconnected(name: &str) -> ServerServiceEvent {
        ServerServiceEvent::Disconnected {
            name: name.to_owned(),
        }
    }

    fn visitor() -> tokio::io::DuplexStream {
        tokio::io::duplex(64).0
    }

    #[tokio::test]
    async fn a_connected_tunnel_takes_visitors_until_it_disconnects() {
        let tunnels = Tunnels::default();
        assert_eq!(tunnels.connect("abc", visitor()).await, Err(TunnelDown));

        let (event, mut visitor_rx) = connected("abc");
        tunnels.apply(event);
        assert_eq!(tunnels.connect("abc", visitor()).await, Ok(()));
        assert!(visitor_rx.recv().await.is_some());
        assert_eq!(tunnels.connect("other", visitor()).await, Err(TunnelDown));

        tunnels.apply(disconnected("abc"));
        assert_eq!(tunnels.connect("abc", visitor()).await, Err(TunnelDown));
    }

    /// rathole closes the queue of a control channel it finds dead before it
    /// reports the tunnel disconnected.
    #[tokio::test]
    async fn a_closed_queue_is_down() {
        let tunnels = Tunnels::default();
        let (event, visitor_rx) = connected("abc");
        tunnels.apply(event);
        drop(visitor_rx);
        assert_eq!(tunnels.connect("abc", visitor()).await, Err(TunnelDown));
    }

    /// A device that reconnects replaces its control channel: rathole
    /// reports the old one disconnected, then the new one connected.
    #[tokio::test]
    async fn a_reconnected_tunnel_takes_visitors_on_its_new_queue() {
        let tunnels = Tunnels::default();
        let (event, old_visitor_rx) = connected("abc");
        tunnels.apply(event);
        let (event, mut new_visitor_rx) = connected("abc");
        tunnels.apply(disconnected("abc"));
        drop(old_visitor_rx);
        tunnels.apply(event);

        assert_eq!(tunnels.connect("abc", visitor()).await, Ok(()));
        assert!(new_visitor_rx.recv().await.is_some());
    }
}
