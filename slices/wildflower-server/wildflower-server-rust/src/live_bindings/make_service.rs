//! The make-service both listeners are served through: it gives each
//! connection the shared router with the connection's peer and the
//! [`ListenerIdentity`] of the listener it arrived on.

use std::convert::Infallible;
use std::future::{ready, Ready};
use std::net::SocketAddr;
use std::task::{Context, Poll};

use axum::extract::ConnectInfo;
use axum::middleware::AddExtension;
use axum::serve::IncomingStream;
use axum::{Extension, Router};
use tokio::net::TcpListener;
use tower::{Layer, Service};

use super::tunnel_listener::TunnelListener;
use crate::http::listener_identity::ListenerIdentity;

/// A connection's service: the router, with the connection's peer as
/// `ConnectInfo<SocketAddr>` (which the loopback-peer gate and owner trust
/// read) and its [`ListenerIdentity`] on every request.
type IdentifiedConnection =
    AddExtension<AddExtension<Router, ConnectInfo<SocketAddr>>, ListenerIdentity>;

/// Serves one router on both listeners, marking each connection with the
/// listener it arrived on: a plain [`TcpListener`] is the local listener, a
/// [`TunnelListener`] the tunnel listener. Plays the part of axum's
/// `into_make_service_with_connect_info`, which can carry only one value.
#[derive(Clone)]
pub(crate) struct MakeServiceWithListenerIdentity {
    router: Router,
}

impl MakeServiceWithListenerIdentity {
    pub(crate) fn new(router: Router) -> Self {
        // `with_state` turns every route into its service once, here, rather
        // than per connection.
        Self {
            router: router.with_state(()),
        }
    }

    fn identified_connection(
        &self,
        peer: SocketAddr,
        listener_identity: ListenerIdentity,
    ) -> IdentifiedConnection {
        Extension(listener_identity).layer(Extension(ConnectInfo(peer)).layer(self.router.clone()))
    }
}

impl Service<IncomingStream<'_, TcpListener>> for MakeServiceWithListenerIdentity {
    type Response = IdentifiedConnection;
    type Error = Infallible;
    type Future = Ready<Result<IdentifiedConnection, Infallible>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, incoming: IncomingStream<'_, TcpListener>) -> Self::Future {
        ready(Ok(self.identified_connection(
            *incoming.remote_addr(),
            ListenerIdentity::Local,
        )))
    }
}

impl Service<IncomingStream<'_, TunnelListener>> for MakeServiceWithListenerIdentity {
    type Response = IdentifiedConnection;
    type Error = Infallible;
    type Future = Ready<Result<IdentifiedConnection, Infallible>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, incoming: IncomingStream<'_, TunnelListener>) -> Self::Future {
        let tunnel_peer = *incoming.remote_addr();
        ready(Ok(self.identified_connection(
            tunnel_peer.peer,
            ListenerIdentity::Tunnel {
                client_address: tunnel_peer.client_address,
            },
        )))
    }
}
