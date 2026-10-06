//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — the [`RelayClient`](domain::RelayClient) trait and its
//!    [`RelaySettings`], the [`TunnelDaemon`] that runs the tunnel, the
//!    [`TunnelLiveness`] it publishes, and the scope-gated capability the HTTP
//!    route reads it through.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay.
//!  - [`http`] — the read-only `/tunnel` wire contract.
//!
//! The relay settings and public host come from the server's record, through
//! [`TunnelConfig`]. The tunnel dials whenever the server runs; nothing in this
//! slice turns it off or edits it. The tunnel keeps no rows: its liveness (the
//! [`TunnelStatus`] FSM and any error) is in-memory and resets per process.
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
pub mod http;
pub mod live_bindings;
mod relay_clients;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::Router;
use tokio::sync::watch;

pub use config::TunnelConfig;
// The per-slice grantable-scope vocabulary (`wildflower/TunnelSettings.r`) —
// the scope the `/tunnel` surface enforces, for a future consent/admin surface.
pub use domain::grantable_tunnel_scopes;
pub use domain::{
    public_origin_url, InvalidPublicHost, RelaySettings, TunnelDaemon, TunnelLiveness, TunnelStatus,
};
pub use health::HealthProbe;
use live_bindings::state::TunnelState;
use relay_clients::RatholeRelayClient;

/// What [`setup_tunnel`] hands back: the `/tunnel` HTTP router to mount and a
/// receiver on the tunnel's liveness, for the host to watch.
pub struct Tunnel {
    pub router: Router,
    pub liveness: watch::Receiver<TunnelLiveness>,
}

/// Spawn the tunnel daemon over an embedded rathole client and build the
/// `/tunnel` router that reads it. The daemon dials the relay in `config`,
/// forwarding its local port, and verifies reachability with `probe` (it GETs
/// `/health` through the public origin). It dials for as long as the returned
/// [`Tunnel`]'s router is held.
pub fn setup_tunnel(config: &TunnelConfig, probe: Arc<dyn HealthProbe>) -> Tunnel {
    let tunnel_daemon = TunnelDaemon::spawn(
        Arc::new(RatholeRelayClient::new()),
        probe,
        config.local_port,
        config.relay_settings.clone(),
        config.public_host.clone(),
    );
    let liveness = tunnel_daemon.watch_liveness();

    let state = Arc::new(TunnelState {
        daemon: Arc::new(tunnel_daemon),
    });

    Tunnel {
        router: http::router(state),
        liveness,
    }
}
