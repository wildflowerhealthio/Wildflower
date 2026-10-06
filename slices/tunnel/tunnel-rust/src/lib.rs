//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — the [`RelayClient`](domain::RelayClient) trait and its
//!    [`RelaySettings`], the [`TunnelDaemon`] that runs the tunnel, and the
//!    scope-gated capability the HTTP route reads it through.
//!  - `db` — the slice's migrations in the shared database. The tunnel keeps
//!    no rows; they drop the slice's old tables.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the Wildflower relay.
//!  - [`http`] — the read-only `/tunnel` wire contract.
//!
//! The relay settings and public host come from the server's record, through
//! [`TunnelConfig`]. The tunnel dials whenever the server runs; nothing in this
//! slice turns it off or edits it. Live runtime state (the [`TunnelStatus`]
//! liveness FSM and any error) is in-memory and resets per process.
//!
//! ## Liveness model
//!
//! The daemon's supervisor owns a reconnect/backoff loop, awaits its own
//! rathole child, *and* drives a concurrent `/health` probe — so `servedOrigin`
//! resolves to the public origin only once a probe through it has come back
//! healthy (`status == "verified"`). A post-launch failure surfaces in the
//! `error` field and is retried.

pub mod config;
mod control;
mod db;
pub mod domain;
pub mod health;
pub mod http;
pub mod live_bindings;
mod relay_clients;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use axum::Router;

pub use config::TunnelConfig;
pub use control::TunnelControl;
// The per-slice grantable-scope vocabulary (`wildflower/TunnelSettings.r`) —
// the scope the `/tunnel` surface enforces, for a future consent/admin surface.
pub use domain::grantable_tunnel_scopes;
pub use domain::{public_origin_url, InvalidPublicHost, RelaySettings, TunnelDaemon};
pub use health::HealthProbe;
use live_bindings::state::TunnelState;
// Re-exported so the host can name the pool type at the `setup_tunnel` call site
// without a direct diesel dependency; the canonical home is persistence-rust.
pub use persistence_rust::DieselPool;
use relay_clients::RatholeRelayClient;
// Re-export the tunnel service contract this slice implements, so consumers can
// name the types without depending on `shared-structures-rust` directly.
pub use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};

/// What [`setup_tunnel`] hands back: the `/tunnel` HTTP router to mount and the
/// in-process [`TunnelControl`] seam. The composition root threads the control
/// into the apps slice for launch-origin resolution, so a tunnel-requiring
/// launch can wait for the tunnel to verify and read its live public origin
/// without an HTTP round-trip.
pub struct Tunnel {
    pub router: Router,
    pub control: TunnelControl,
}

/// Build the `/tunnel` router + control seam over the host-owned connection
/// `pool` and an embedded rathole client, mirroring `collector-rust`'s
/// `setup_collector`. The host builds the app-wide diesel pool (via
/// `persistence_rust::open_pool`) and passes it in along with the `probe` adapter
/// the daemon uses to verify the tunnel is actually reachable (it GETs the served
/// origin's assumed-present `/health`). Applies the embedded tunnel migrations,
/// then spawns the daemon, which dials the relay in `config` for as long as the
/// returned [`Tunnel`] is held.
///
/// # Errors
///
/// Returns an error if the tunnel migrations can't be applied.
pub fn setup_tunnel(
    pool: DieselPool,
    config: &TunnelConfig,
    probe: Arc<dyn HealthProbe>,
) -> anyhow::Result<Tunnel> {
    db::run_migrations(&pool)?;
    let tunnel_daemon = TunnelDaemon::spawn(
        Arc::new(RatholeRelayClient::new()),
        probe,
        // The daemon renders the loopback origin into `TunnelLiveness.origin` (a
        // wire string), so hand it the bare origin (no trailing slash).
        shared_structures_rust::origin_string(&config.loopback_base_url),
        config
            .loopback_base_url
            .port_or_known_default()
            .expect("loopback_base_url has a known port"),
        config.relay_settings.clone(),
        config.public_host.clone(),
    );

    let state = Arc::new(TunnelState {
        daemon: Arc::new(tunnel_daemon),
    });

    // The control seam shares the daemon's liveness watch; a start awaits
    // verification inline (no background task).
    let control = TunnelControl::new(Arc::clone(&state));

    Ok(Tunnel {
        router: http::router(state),
        control,
    })
}
