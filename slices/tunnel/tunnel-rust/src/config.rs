//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`.

use tokio::sync::mpsc;

use crate::domain::{RelaySettings, TunnelStream};

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice:
/// where it hands each visitor's stream, and the relay to dial, from the
/// server's record.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// Where the tunnel hands each visitor's stream: the server's tunnel
    /// listener.
    pub tunnel_stream_tx: mpsc::Sender<TunnelStream>,
    /// The relay connection the tunnel dials.
    pub relay_settings: RelaySettings,
}
