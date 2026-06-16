//! `apps-rust` — the host-side apps slice.
//!
//! Layered like `tunnel-rust` and `gatekeeper-rust`:
//!
//!  - [`domain`] — pure types: the wire-level [`domain::AppEntry`], the
//!    code-defined [`domain::BUNDLED_APPS`] registry, and the write-side
//!    [`domain::validate_custom_url`] filter.
//!  - [`db`] — the SQLite [`db::AppsStore`] (built on the shared
//!    `persistence-rust` primitives) and its read/write methods.
//!  - [`http`] — the `/apps` wire contract, split into a public router
//!    (list + launch) and an admin router (create / patch / delete).
//!
//! The bundled-apps registry is seeded into SQLite by the initial migration
//! so a user can toggle a bundled app's `enabled` flag without the slice
//! having to decide whether to INSERT or UPDATE on every write. The static
//! metadata (display name, subtitle, launch-URL builder) stays in Rust —
//! it isn't user-editable and migrations are the wrong shape for code.
//!
//! ## Launch / tunnel seam
//!
//! `GET /apps/{id}` currently resolves every launch against
//! [`AppsConfig::loopback_origin`], appending `?tunnel=unavailable` for
//! `requires_tunnel` apps. This matches the TS `resolveLaunchOrigin`
//! no-op seam — the hook for the eventual tunnel-rust integration where
//! a `requires_tunnel` launch redirects to the live `servedOrigin`.

pub mod config;
pub mod db;
pub mod domain;
pub mod http;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;

pub use config::AppsConfig;
pub use db::AppsStore;
pub use http::AppsState;

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
/// `setup_gatekeeper`. The host opens one database and passes it in.
///
/// # Errors
///
/// Returns an error if the store can't be migrated.
pub fn setup_apps(conn: persistence_rust::Connection, config: &AppsConfig) -> anyhow::Result<Apps> {
    let store = AppsStore::new(conn).context("failed to open apps store")?;
    let state = Arc::new(AppsState::new(store, config.loopback_origin.clone()));
    Ok(Apps {
        public_router: http::public_router(Arc::clone(&state)),
        admin_router: http::admin_router(Arc::clone(&state)),
        state,
    })
}
