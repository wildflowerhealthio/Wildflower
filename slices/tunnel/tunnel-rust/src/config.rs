//! Open-time configuration for the tunnel slice, mirroring
//! `gatekeeper-rust`'s `GatekeeperConfig`. The shared database is passed
//! separately into [`setup_tunnel`](crate::setup_tunnel), not via this config.

use url::Url;

use crate::domain::RelaySettings;

/// What [`setup_tunnel`](crate::setup_tunnel) needs to stand up the slice: the
/// loopback origin used as the `servedOrigin` fallback and the loopback port the
/// tunnel forwards, plus the relay to dial and the public host it serves the
/// server at, both from the server's record.
///
/// No `Default` — `loopback_base_url` is a [`Url`], which has no meaningful
/// default; the host always constructs this with every field set.
#[derive(Debug, Clone)]
pub struct TunnelConfig {
    /// e.g. `http://127.0.0.1:8080/` — the origin clients reach when the tunnel
    /// is down, as a typed [`Url`]. The daemon takes its bare origin string
    /// (via [`shared_structures_rust::origin_string`]) at construction.
    pub loopback_base_url: Url,
    /// The relay connection the tunnel dials.
    pub relay_settings: RelaySettings,
    /// The bare public host the relay serves the server at, e.g.
    /// `ruth.relay.wildflowerhealth.io`: the server's domain.
    pub public_host: String,
}
