//! `tunnel-rust` — the host's tunnel: a dialer.
//!
//!  - [`domain`] — the [`RelayClient`](domain::RelayClient) trait, its
//!    [`RelaySettings`] and the [`DialFailure`] a dial ends with, the
//!    [`TunnelDaemon`] that dials the relay and re-dials with backoff, the
//!    [`TunnelState`] it publishes, and the rule for a server's domain
//!    ([`public_origin_url`]).
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay and hands each visitor's stream over in
//!    process.
//!
//! The relay settings come from the server's record, through
//! [`TunnelConfig`]. The tunnel dials whenever the server runs, until the
//! relay refuses its token or has no tunnel of its name; nothing in this slice
//! edits it. It forwards no port: each visitor's connection arrives as a
//! [`TunnelStream`] on the sender in [`TunnelConfig`], which the server's
//! tunnel listener serves. The tunnel has no HTTP surface and keeps no rows:
//! each dial and its outcome go to the tracing log, and its only state is its
//! [`TunnelState`], published on the host's channel, whose
//! [`connectivity`](TunnelState::connectivity) the server's `/health` reports
//! as its `connectivity` check. Whether the server is reachable through the
//! relay is the server's own `/health`, which `wildflower-server-rust`'s
//! reachability monitor reads through the public origin.

pub mod config;
pub mod domain;
mod relay_clients;

use std::sync::Arc;

use tokio::sync::watch;

pub use config::TunnelConfig;
pub use domain::{
    public_origin_url, DialFailure, InvalidDomain, RelaySettings, TunnelDaemon, TunnelState,
    TunnelStream,
};
use relay_clients::RatholeRelayClient;
pub use wildflowerhealthio_shared_structures::health_check::HealthStatus;

/// Spawn the tunnel daemon over an embedded rathole client. The daemon dials
/// the relay in `config`, handing each visitor's stream to its sender and
/// publishing its [`TunnelState`] on `tunnel_state_tx`, for as long as the
/// returned [`TunnelDaemon`] is held; dropping it stops the supervisor.
pub fn setup_tunnel(
    config: &TunnelConfig,
    tunnel_state_tx: watch::Sender<Option<TunnelState>>,
) -> TunnelDaemon {
    TunnelDaemon::spawn(
        Arc::new(RatholeRelayClient::new()),
        config.tunnel_stream_tx.clone(),
        config.relay_settings.clone(),
        tunnel_state_tx,
    )
}
