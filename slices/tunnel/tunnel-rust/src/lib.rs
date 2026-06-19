//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — pure settings types ([`TunnelSettings`]) and the
//!    [`RelayClient`](domain::RelayClient) trait.
//!  - [`db`] — the `SQLite` [`TunnelStore`] (on the shared `persistence-rust`
//!    primitives) and its queries.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the self-hosted relay.
//!  - [`http`] — the `/tunnel` wire contract.
//!
//! Settings live in `SQLite` and are API-controlled (`PUT /tunnel`, a
//! full-replace guarded by an optimistic-concurrency `revision`). The relay
//! connection fields are write-only and start empty; until they are set the
//! tunnel reports "not configured". Observed runtime state (running / error) is
//! in-memory and resets per process.
//!
//! ## Reconcile model
//!
//! Every accepted write bumps `revision` and reconciles: the previous
//! [`http::TunnelState`] supervisor is cancelled and a fresh one is spawned for
//! the new revision. A supervisor owns a reconnect/backoff loop and awaits its
//! own rathole child, so a post-launch failure (relay unreachable, handshake
//! rejected) surfaces in the HTTP `error` field and is retried, and a superseded
//! run's late exit can't clobber the live one.

pub mod config;
mod control;
pub mod db;
pub mod domain;
pub mod http;
mod relay_clients;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;

pub use config::TunnelConfig;
pub use control::TunnelControl;
pub use db::{SettingsSeed, TunnelStore};
pub use domain::{RelaySettings, TunnelDaemon, TunnelSettings};
pub use http::TunnelState;
use relay_clients::RatholeRelayClient;

/// What [`setup_tunnel`] hands back: the `/tunnel` HTTP router to mount plus the
/// in-process [`TunnelControl`] seam. The composition root threads the control
/// into the apps slice (launch-origin resolution) and the `RequestTunnel`
/// bridge handler, so a tunnel-requiring launch can trigger the tunnel and read
/// its live public origin without an HTTP round-trip.
pub struct Tunnel {
    pub router: Router,
    pub control: TunnelControl,
}

/// Build the `/tunnel` router + control seam over the shared `conn` and an
/// embedded rathole client, mirroring `gatekeeper-rust`'s `setup_gatekeeper`.
/// The host opens one database and passes it in. Resumes the tunnel from
/// persisted settings.
///
/// # Errors
///
/// Returns an error if the store can't be migrated or the persisted settings
/// can't be read.
pub fn setup_tunnel(
    conn: persistence_rust::Connection,
    config: &TunnelConfig,
) -> anyhow::Result<Tunnel> {
    let store = TunnelStore::new(conn).context("failed to open tunnel store")?;
    let client = Arc::new(RatholeRelayClient::new());
    let tunnel_daemon =
        TunnelDaemon::new(client, config.loopback_origin.clone(), config.local_port);

    let state = Arc::new(TunnelState {
        store,
        daemon: tunnel_daemon,
    });

    // Seed build-time connection defaults into a fresh row (only where
    // unconfigured) before resuming, so a reinstall picks up the baked-in
    // tunnel connection without clobbering any in-app edits.
    state
        .store
        .seed_if_absent(&config.seed)
        .context("failed to seed tunnel settings")?;

    // Resume persisted intent: reconcile spawns a supervisor for the stored
    // revision (a no-op when the tunnel isn't requested or the relay isn't
    // configured).
    let settings = state
        .store
        .get_settings()
        .context("failed to read tunnel settings")?;
    state.daemon.reconcile(&settings);

    // The control seam shares the daemon's served-origin watch and owns the
    // start-trigger task; spawn it before handing the state to the router.
    let control = control::spawn_control(Arc::clone(&state));

    Ok(Tunnel {
        router: http::router(state),
        control,
    })
}
