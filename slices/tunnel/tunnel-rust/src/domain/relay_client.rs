//! The embedded rathole client that dials the relay.
//!
//! [`RelayClient`] is a one-attempt seam: `run_once` brings up a single rathole
//! client and returns when it exits. The [`TunnelState`](crate::live_bindings::state::TunnelState)
//! supervisor owns the retry/backoff loop and cancellation, so this layer holds
//! no run lifecycle of its own. The trait exists so the supervisor can be tested
//! against a fake instead of a live relay.
//!
//! Each tunnel connection is handed, in process, to the server's tunnel
//! listener as a [`TunnelStream`].

use rathole_settings_rust::PublicRatholeSettings;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One visitor's connection through the relay, as the rathole client hands it
/// over: the bytes of exactly that visitor.
pub type TunnelStream = Box<dyn rathole::AsyncStream>;

/// A fully-specified relay connection — produced only when every field the
/// rathole client needs is present. Also the shape a PUT sets the relay block
/// to (all four together, or none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub remote_addr: String,
    pub token: String,
    pub public_key: String,
    pub service_name: String,
}

impl RelaySettings {
    /// The connection to the relay that served `relay` at `GET /rathole`, for
    /// this device's tunnel `service_name` and its `token`.
    #[must_use]
    pub fn from_public_rathole_settings(
        relay: PublicRatholeSettings,
        service_name: String,
        token: String,
    ) -> Self {
        Self {
            remote_addr: relay.remote_addr,
            token,
            public_key: relay.public_key,
            service_name,
        }
    }
}

/// Runs a single rathole client attempt. The supervisor calls this in a loop.
#[async_trait::async_trait]
pub trait RelayClient: Send + Sync {
    /// Bring up the tunnel per `relay`, sending each tunnel connection to
    /// `connections`, and run until the client exits. Resolves `Ok` on a clean
    /// stop — `cancel` fired, or the relay closed the session without error —
    /// and `Err` on a failure the supervisor should back off and retry (relay
    /// unreachable, handshake rejected).
    async fn run_once(
        &self,
        relay: &RelaySettings,
        connections: mpsc::Sender<TunnelStream>,
        cancel: CancellationToken,
    ) -> anyhow::Result<()>;
}
