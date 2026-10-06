//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//!  - [`domain`] — the [`RelayClient`](domain::RelayClient) trait and its
//!    [`RelaySettings`], the [`TunnelDaemon`] that runs the tunnel, and the
//!    [`TunnelLiveness`] it publishes.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay.
//!
//! The relay settings and public host come from the server's record, through
//! [`TunnelConfig`]. The tunnel dials whenever the server runs; nothing in this
//! slice turns it off or edits it. The tunnel has no HTTP surface and keeps no
//! rows: its liveness (the [`TunnelStatus`] FSM and any error) is in-memory,
//! resets per process, and reaches the host in-process through
//! [`TunnelDaemon::watch_liveness`].
//!
//! ## Liveness model
//!
//! The daemon's supervisor owns a reconnect/backoff loop, awaits its own
//! rathole child, *and* drives a concurrent `/health` probe through the public
//! origin, so `status` is `verified` only once a probe through it has come back
//! healthy. A post-launch failure surfaces in the `error` field and is retried.

pub mod config;
pub mod domain;
pub mod health;
mod relay_clients;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

pub use config::TunnelConfig;
pub use domain::{
    public_origin_url, InvalidPublicHost, RelaySettings, TunnelDaemon, TunnelLiveness, TunnelStatus,
};
pub use health::HealthProbe;
use relay_clients::RatholeRelayClient;

/// Spawn the tunnel daemon over an embedded rathole client. The daemon dials
/// the relay in `config`, forwarding its local port, and verifies reachability
/// with `probe` (it GETs `/health` through the public origin). It dials for as
/// long as the returned [`TunnelDaemon`] is held; dropping it stops the
/// supervisor.
pub fn setup_tunnel(config: &TunnelConfig, probe: Arc<dyn HealthProbe>) -> TunnelDaemon {
    TunnelDaemon::spawn(
        Arc::new(RatholeRelayClient::new()),
        probe,
        config.local_port,
        config.relay_settings.clone(),
        config.public_host.clone(),
    )
}
