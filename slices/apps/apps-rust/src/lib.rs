//! `apps-rust` — the host-side apps slice.
//!
//! Two catalogues, one wire surface:
//!
//!  - **Externals** ([`AppsStore`]) — user-editable rows backed by the
//!    `apps` table. Carry an [`AppUrl`](domain::AppUrl) template (`{origin}`
//!    / `{launch}` placeholders) that the launch handler substitutes at
//!    request time. Editable through the admin surface (create / patch /
//!    delete). Deletion of a seeded row sticks across upgrades — each seed
//!    migration runs once per database.
//!  - **Internals** (the `internal_apps` table, read through [`AppsStore`]'s
//!    [`list_internal_apps`](AppsStore::list_internal_apps) /
//!    [`find_internal_app`](AppsStore::find_internal_app)) — locally-served
//!    apps. Each row owns a dedicated loopback `port` the host binds a listener
//!    on; the launch handler renders the target as `http://{host}:{port}/` from
//!    [`AppsConfig::loopback_hostname`] + the row's `port`. The seed
//!    migration is the only writer today; there is no admin surface for
//!    internals.
//!
//! Layered like `tunnel-rust` and `gatekeeper-rust`:
//!
//!  - [`domain`] — pure types: the wire-level [`domain::AppEntry`] (which
//!    doubles as the externals row shape), [`domain::InternalApp`] (the
//!    internals row shape and its `AppEntry` materializer), and
//!    [`domain::AppUrl`] (the write-side URL validator).
//!  - [`db`] — the SQLite store ([`db::AppsStore`], serving both tables) built
//!    on the shared `persistence-rust` primitives, with the row mappings
//!    generated directly off the domain types via `persistence_rust::sql_row!`.
//!  - [`http`] — the `/apps` wire contract, split into a public router
//!    (list + launch) and an admin router (create / patch / delete).
//!    `GET /apps` merges internals and externals into one uniform list;
//!    `POST /apps/{id}` dispatches to whichever store owns the id.
//!
//! ## Launch / tunnel seam
//!
//! `POST /apps/{id}` resolves a launch target and dispatches on provenance —
//! see the launch handler module. A `requires_tunnel` launch resolves through
//! the shared
//! [`TunnelService`](shared_structures_rust::tunnel_service::TunnelService)
//! contract, keeping apps-rust decoupled from tunnel-rust.

pub mod config;
pub mod db;
pub mod domain;
pub mod http;
mod id;
mod self_hosted_apps;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use shared_structures_rust::tunnel_service::TunnelService;

pub use config::AppsConfig;
pub use db::AppsStore;
pub use domain::InternalApp;
pub use http::AppsState;
pub use self_hosted_apps::SelfHostedAppsService;
pub use shared_structures_rust::OnDeviceWebviewHandle;

/// Result of [`setup_apps`]: the two routers a host needs to mount. The
/// public one carries no auth (the webview reaches list + launch
/// unauthenticated); the admin one is meant to be wrapped with the
/// composing app's auth gate (e.g.
/// `gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`).
pub struct Apps {
    pub public_router: Router,
    pub admin_router: Router,
    pub state: Arc<AppsState>,
    /// The internal-apps catalogue the host uses to discover which internal apps
    /// it must bind a loopback listener for. Materialized once at setup (the
    /// catalogue is static — seeded by migration, read-only at runtime).
    pub internal_apps: Vec<InternalApp>,
}

/// Build the apps router pair over the shared `conn`, mirroring
/// `tunnel-rust`'s `setup_tunnel` and `gatekeeper-rust`'s
/// `setup_gatekeeper`. The host opens one database and passes it in, along with
/// the `tunnel` service a `requires_tunnel` launch resolves its origin through.
///
/// `webview_handle` is the host seam for the on-device launch side-effect: a
/// loopback launch opens the resolved URL through it and `204`s. The Tauri host
/// passes a native-webview opener; a host with no native popup passes a no-op.
///
/// # Errors
///
/// Returns an error if the store can't be migrated.
pub fn setup_apps(
    conn: persistence_rust::Connection,
    config: &AppsConfig,
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
) -> anyhow::Result<Apps> {
    // `AppsStore::new` owns the shared migration list — running it migrates
    // both the externals (`apps`) and internals (`internal_apps`) tables. The
    // one store then serves both.
    let store = AppsStore::new(conn).context("failed to open apps store")?;
    // Materialize the static internals catalogue once for the host to bind
    // listeners against (seeded by migration, read-only at runtime).
    let internal_apps = store
        .list_internal_apps()
        .context("failed to list internal apps")?;
    let state = AppsState::new(
        store,
        config.loopback_origin.clone(),
        config.loopback_hostname.clone(),
        tunnel,
        webview_handle,
    );

    let state = Arc::new(state);
    Ok(Apps {
        public_router: http::public_router(Arc::clone(&state)),
        admin_router: http::admin_router(Arc::clone(&state)),
        state,
        internal_apps,
    })
}
