//! `tunnel-rust` — the Tauri-side tunnel slice.
//!
//! Layered like `gatekeeper-rust`:
//!
//!  - [`domain`] — pure settings types ([`TunnelSettings`]).
//!  - [`db`] — the SQLite [`TunnelStore`] (on the shared `persistence-rust`
//!    primitives) and its queries.
//!  - [`client`] — the embedded `rathole` client that dials the self-hosted
//!    relay.
//!  - [`http`] — the `/tunnel` wire contract the `tunnel-react` UI speaks.
//!
//! Settings live in SQLite and are API-controlled (`PATCH /tunnel`); there is
//! no settings UI and no env-var seeding yet, so the relay connection fields
//! start empty and the tunnel reports "not configured" until set. Runtime state
//! (running / current* / error) is in-memory and resets per process, mirroring
//! the TS daemon.
//!
//! ## Runtime failure reporting
//!
//! A *post-launch* rathole failure (relay unreachable, handshake rejected) is
//! reported back from the client task into [`http::TunnelState`] via an
//! [`client::ExitReporter`]: `running` flips back off and the cause surfaces in
//! the HTTP `error` field. A generation counter discards the late exit of a
//! tunnel that a newer (re)start has already superseded.

pub mod client;
pub mod config;
pub mod db;
pub mod domain;
pub mod http;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;

pub use config::TunnelConfig;
pub use db::TunnelStore;
pub use domain::TunnelSettings;
pub use http::TunnelState;

/// Build the `/tunnel` router over the shared `conn` and an embedded rathole
/// client, mirroring `gatekeeper-rust`'s `setup_gatekeeper`. The host opens one
/// database and passes it in. Resumes the tunnel when `requested_running` was
/// persisted on.
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
    let client = Arc::new(client::RatholeRelayClient::new());
    let state = Arc::new(TunnelState::new(
        store,
        client,
        config.loopback_origin.clone(),
        config.local_port,
    ));

    // Auto-resume persisted intent (no-op error if the relay isn't configured).
    let settings = state
        .store
        .get_settings()
        .context("failed to read tunnel settings")?;
    if settings.requested_running {
        state.apply_running(&settings);
    }

    Ok(http::tunnel_router(state))
}
