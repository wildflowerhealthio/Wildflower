//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`.

use crate::domain::RelaySettings;

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// local port the tunnel forwards, and the relay to dial, from the server's
/// record.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// The port the server listens on, which the tunnel forwards through the
    /// relay.
    pub local_port: u16,
    /// The relay connection the tunnel dials.
    pub relay_settings: RelaySettings,
}
