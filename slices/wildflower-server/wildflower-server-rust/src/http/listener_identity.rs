//! Which of the server's two loopback listeners a connection arrived on. Each
//! request carries its connection's [`ListenerIdentity`] as an extension, next
//! to the `ConnectInfo<SocketAddr>` peer, so the layers that grant or withhold
//! trust can tell a tunnel connection from a local one.

use std::net::SocketAddr;

/// The listener a request's connection arrived on.
///
/// # Remarks
///
/// Both listeners are bound to `127.0.0.1`, and the tunnel's peer is the
/// in-process rathole client, so the peer address cannot tell them apart. The
/// listener can: rathole forwards every tunnel connection to the tunnel
/// listener, and nothing else is pointed at it. A request without this
/// extension never came through `serve`, and the layers reading it treat it as
/// remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ListenerIdentity {
    /// The loopback API listener: the on-device webview, other local
    /// processes, and any front a person runs themselves, which marks what it
    /// relays with `Forwarded`.
    Local,
    /// The tunnel listener rathole forwards to. Every connection on it is
    /// remote, whatever its peer address or headers say.
    Tunnel {
        /// The visitor's address and port, from the PROXY protocol v2 header
        /// the relay front prepends. `None` when the connection carried no
        /// header (a stock rathole server sends none) or a header naming no
        /// address.
        client_address: Option<SocketAddr>,
    },
}
