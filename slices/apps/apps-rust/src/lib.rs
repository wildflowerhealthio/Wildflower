//! `apps-rust` — the host-side apps slice.
//!
//! Layered like `tunnel-rust` and `gatekeeper-rust`:
//!
//!  - [`domain`] — pure types: the wire-level [`domain::AppEntry`]
//!    (which doubles as the SQL row shape) and the
//!    [`domain::validate_app_url`] filter.
//!  - [`db`] — the SQLite [`db::AppsStore`] (built on the shared
//!    `persistence-rust` primitives, with the row mapping generated
//!    directly off `AppEntry` via `persistence_rust::sql_row!`).
//!  - [`http`] — the `/apps` wire contract, split into a public router
//!    (list + launch) and an admin router (create / patch / delete).
//!
//! Every app is editable, deletable, and renamable; there is no provenance
//! tag on the row. Deletion of a seeded row sticks across upgrades — each
//! seed migration runs once per database, so a re-installed default set is
//! reserved for fresh installs.
//!
//! ## Launch / tunnel seam
//!
//! `POST /apps/{id}` resolves a non-tunnel launch against
//! [`AppsConfig::loopback_origin`]. A `requires_tunnel` launch is resolved
//! through the shared [`TunnelService`](shared_structures_rust::tunnel_service::TunnelService)
//! contract: the host wires it to the tunnel slice, so the launch targets the
//! live *verified* origin (or falls back to loopback + `?tunnel=unavailable`
//! when the tunnel can't be reached). Depending only on the contract keeps
//! apps-rust decoupled from tunnel-rust.
//!
//! With the resolved target in hand the handler either returns a `302` redirect
//! (web/standalone) or, when a [`LaunchSink`] is installed (the Tauri host),
//! hands the URL to the sink — which opens it in a native webview popup — and
//! returns `204`. See [`LaunchSink`].

pub mod config;
pub mod db;
pub mod domain;
pub mod http;
mod launch_sink;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use shared_structures_rust::tunnel_service::TunnelService;

pub use config::AppsConfig;
pub use db::AppsStore;
pub use http::AppsState;
pub use launch_sink::LaunchSink;

/// Result of [`setup_apps`]: the two routers a host needs to mount. The
/// public one carries no auth (the webview reaches list + launch
/// unauthenticated); the admin one is meant to be wrapped with the
/// composing app's auth gate (e.g.
/// `gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`).
pub struct Apps {
    pub public_router: Router,
    pub admin_router: Router,
    pub state: Arc<AppsState>,
}

/// Build the apps router pair over the shared `conn`, mirroring
/// `tunnel-rust`'s `setup_tunnel` and `gatekeeper-rust`'s
/// `setup_gatekeeper`. The host opens one database and passes it in, along with
/// the `tunnel` service a `requires_tunnel` launch resolves its origin through.
///
/// `launch_sink` is the optional host seam for the launch side-effect: `Some`
/// (the Tauri host) makes a launch open the resolved URL through the sink and
/// `204`; `None` (web/standalone) keeps the `302` redirect.
///
/// # Errors
///
/// Returns an error if the store can't be migrated.
pub fn setup_apps(
    conn: persistence_rust::Connection,
    config: &AppsConfig,
    tunnel: Arc<dyn TunnelService>,
    launch_sink: Option<Arc<dyn LaunchSink>>,
) -> anyhow::Result<Apps> {
    let store = AppsStore::new(conn).context("failed to open apps store")?;
    let mut state = AppsState::new(store, config.loopback_origin.clone(), tunnel);
    if let Some(sink) = launch_sink {
        state = state.with_launch_sink(sink);
    }
    let state = Arc::new(state);
    Ok(Apps {
        public_router: http::public_router(Arc::clone(&state)),
        admin_router: http::admin_router(Arc::clone(&state)),
        state,
    })
}
