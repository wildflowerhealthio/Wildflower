//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — pure settings types ([`TunnelSettings`]) and the
//!    [`RelayClient`](domain::RelayClient) trait.
//!  - [`db`] — the SQLite [`TunnelStore`] (on the shared `persistence-rust`
//!    primitives) and its queries.
//!  - `relay_clients` — the embedded `rathole` impl of `RelayClient` that
//!    dials the self-hosted relay.
//!  - [`http`] — the `/tunnel` wire contract.
//!
//! Settings live in SQLite and are API-controlled (`PUT /tunnel`, a
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
//!
//! NOTE(pr-ui): the `tunnel-core` TS schema + `tunnel-react` UI still speak the
//! older PATCH/`subdomain` contract and are reconciled to this one in the
//! follow-up UI PR.

pub mod config;
pub mod db;
pub mod domain;
pub mod http;
mod relay_clients;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;

pub use config::TunnelConfig;
pub use db::TunnelStore;
pub use domain::{TunnelDaemon, TunnelSettings};
pub use http::TunnelState;
use relay_clients::RatholeRelayClient;

/// Build the `/tunnel` router over the shared `conn` and an embedded rathole
/// client, mirroring `gatekeeper-rust`'s `setup_gatekeeper`. The host opens one
/// database and passes it in. Resumes the tunnel from persisted settings.
///
/// # Errors
///
/// Returns an error if the store can't be migrated or the persisted settings
/// can't be read.
pub fn setup_tunnel(
    conn: persistence_rust::Connection,
    config: &TunnelConfig,
) -> anyhow::Result<Router> {
    let store = TunnelStore::new(conn).context("failed to open tunnel store")?;
    let client = Arc::new(RatholeRelayClient::new());
    let tunnel_daemon =
        TunnelDaemon::new(client, config.loopback_origin.clone(), config.local_port);

    let state = Arc::new(TunnelState {
        store,
        daemon: tunnel_daemon,
    });

    // Resume persisted intent: reconcile spawns a supervisor for the stored
    // revision (a no-op when the tunnel isn't requested or the relay isn't
    // configured).
    let settings = state
        .store
        .get_settings()
        .context("failed to read tunnel settings")?;
    state.daemon.reconcile(&settings);

    Ok(http::router(state))
}
