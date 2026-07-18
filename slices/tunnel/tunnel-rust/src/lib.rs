//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — pure settings types ([`TunnelSettings`]), the
//!    [`RelayClient`](domain::RelayClient) trait, and the
//!    [`TunnelStore`](domain::TunnelStore) persistence *port* plus the
//!    `actions` the HTTP routes drive it through.
//!  - [`db`] — the [`SqliteTunnelStore`] adapter implementing that port, built
//!    on Diesel over the app-wide r2d2 connection pool
//!    (`persistence_rust::DieselPool`) onto the shared database file, and its
//!    queries.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the self-hosted relay.
//!  - [`http`] — the `/tunnel` wire contract.
//!
//! Settings live in `SQLite` and are API-controlled (`PUT /tunnel`, a
//! full-replace guarded by an optimistic-concurrency `revision`). The relay
//! connection fields are write-only and start empty; until they are set the
//! tunnel reports "not configured". Live runtime state (the [`TunnelStatus`]
//! liveness FSM and any error) is in-memory and resets per process.
//!
//! ## Reconcile + liveness model
//!
//! Every accepted write bumps `revision` and reconciles: the previous
//! [`TunnelState`](state::TunnelState) supervisor is cancelled and a fresh one
//! is spawned for the new revision. A supervisor owns a reconnect/backoff loop, awaits its own
//! rathole child, *and* drives a concurrent `/health` probe — so `servedOrigin`
//! resolves to the public origin only once a probe through it has come back
//! healthy (`status == "verified"`). A post-launch failure
//! surfaces in the `error` field and is retried, and a superseded run's late
//! exit can't clobber the live one.

pub mod config;
mod control;
pub mod db;
pub mod domain;
pub mod health;
pub mod http;
mod relay_clients;
mod state;
#[cfg(test)]
mod test_support;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;

pub use config::TunnelConfig;
pub use control::TunnelControl;
pub use db::SqliteTunnelStore;
// The per-slice grantable-scope vocabulary (`wildflower/TunnelSettings.{r,u}`) —
// the scopes the `/tunnel` surface enforces, for a future consent/admin surface.
pub use domain::grantable_tunnel_scopes;
pub use domain::{RelaySettings, SettingsSeed, TunnelDaemon, TunnelSettings};
pub use health::HealthProbe;
pub use http::openapi_spec;
pub use state::TunnelState;
// Re-exported so the host can name the pool type at the `setup_tunnel` call site
// without a direct diesel dependency; the canonical home is persistence-rust.
pub use persistence_rust::DieselPool;
use relay_clients::RatholeRelayClient;
// Re-export the tunnel service contract this slice implements, so consumers can
// name the types without depending on `shared-structures-rust` directly.
pub use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};

/// What [`setup_tunnel`] hands back: the `/tunnel` HTTP router to mount plus the
/// in-process [`TunnelControl`] seam. The composition root threads the control
/// into the apps slice for launch-origin resolution, so a tunnel-requiring
/// launch can trigger the tunnel and read its live public origin without an
/// HTTP round-trip.
pub struct Tunnel {
    pub router: Router,
    pub control: TunnelControl,
}

/// Build the `/tunnel` router + control seam over the host-owned connection
/// `pool` and an embedded rathole client, mirroring `collector-rust`'s
/// `setup_collector`. The host builds the app-wide diesel pool (via
/// `persistence_rust::open_pool`) and passes it in along with the `probe` adapter
/// the daemon uses to verify the tunnel is actually reachable (it GETs the served
/// origin's assumed-present `/health`). Constructing the store applies the
/// embedded tunnel migrations once, then resumes the tunnel from persisted
/// settings.
///
/// # Errors
///
/// Returns an error if the store can't be migrated or the persisted settings
/// can't be read.
pub fn setup_tunnel(
    pool: DieselPool,
    config: &TunnelConfig,
    probe: Arc<dyn HealthProbe>,
) -> anyhow::Result<Tunnel> {
    let store = SqliteTunnelStore::new(pool).context("failed to open tunnel store")?;
    let client = Arc::new(RatholeRelayClient::new());
    let tunnel_daemon = TunnelDaemon::new(
        client,
        probe,
        // The daemon renders the loopback origin into `TunnelLiveness.origin` (a
        // wire string), so hand it the bare origin (no trailing slash).
        shared_structures_rust::origin_string(&config.loopback_base_url),
        config
            .loopback_base_url
            .port_or_known_default()
            .expect("loopback_base_url has a known port"),
    );

    let state = Arc::new(TunnelState {
        store,
        daemon: Arc::new(tunnel_daemon),
    });

    // Seed build-time connection defaults into a fresh row (only where
    // unconfigured) before resuming, so a reinstall picks up the baked-in
    // tunnel connection without clobbering any in-app edits.
    domain::actions::seed_if_absent(&state.store, &config.seed)
        .context("failed to seed tunnel settings")?;

    // Resume persisted intent: reconcile spawns a supervisor for the stored
    // revision (a no-op when the tunnel isn't requested or the relay isn't
    // configured).
    let settings =
        domain::actions::get_settings(&state.store).context("failed to read tunnel settings")?;
    state.daemon.reconcile(&settings);

    // The control seam shares the daemon's liveness watch; a start persists,
    // reconciles, and awaits verification inline (no background task).
    let control = TunnelControl::new(Arc::clone(&state));

    Ok(Tunnel {
        router: http::router(state),
        control,
    })
}
