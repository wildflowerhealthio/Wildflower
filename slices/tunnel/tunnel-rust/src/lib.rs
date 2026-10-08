//! `tunnel-rust` — the Tauri-side tunnel slice: a dialer.
//!
//!  - [`domain`] — the [`RelayClient`](domain::RelayClient) trait and its
//!    [`RelaySettings`], the [`TunnelDaemon`] that dials the relay and re-dials
//!    with backoff, the [`HealthStatus`] it publishes, and the rule for a
//!    public host ([`public_origin_url`]).
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay and hands each visitor's stream over in
//!    process.
//!
//! The relay settings come from the server's record, through
//! [`TunnelConfig`]. The tunnel dials whenever the server runs; nothing in this
//! slice turns it off or edits it. It forwards no port: each visitor's
//! connection arrives as a [`TunnelStream`] on the sender in [`TunnelConfig`],
//! which the server's tunnel listener serves. The tunnel has no HTTP surface
//! and keeps no rows: each dial and its outcome go to the tracing log, and its
//! only state is its [`HealthStatus`], which the server's `/health` reports as
//! its `connectivity` check. Whether the server is reachable through the relay is
//! the server's own `/health`, which `wildflower-server-rust`'s reachability
//! monitor reads through the public origin.

pub mod config;
pub mod domain;
mod relay_clients;

use std::sync::Arc;

pub use config::TunnelConfig;
pub use domain::{public_origin_url, InvalidPublicHost, RelaySettings, TunnelDaemon, TunnelStream};
use relay_clients::RatholeRelayClient;
pub use shared_structures_rust::health_check::HealthStatus;

/// Spawn the tunnel daemon over an embedded rathole client. The daemon dials
/// the relay in `config`, handing each visitor's stream to its sender, for as
/// long as the returned [`TunnelDaemon`] is held; dropping it stops the
/// supervisor.
pub fn setup_tunnel(config: &TunnelConfig) -> TunnelDaemon {
    TunnelDaemon::spawn(
        Arc::new(RatholeRelayClient::new()),
        config.tunnel_stream_sender.clone(),
        config.relay_settings.clone(),
    )
}
