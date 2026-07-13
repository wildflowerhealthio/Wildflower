//! `apps-rust` — the host-side apps slice.
//!
//! A curated app registry with one wire surface. **Class-table-inheritance**
//! storage: one authoritative `app_registry` parent (the global id space, the
//! shared catalogue facts, and the homescreen placement) with three symmetric
//! per-kind child payload tables (`system_apps`, `cloud_apps`, `self_hosted_apps`),
//! real FKs child → parent with `ON DELETE CASCADE`. The `kind` column names which
//! child holds a registration's payload. The taxonomy (System / Self-Hosted /
//! Cloud) and its privacy model are canonical in `docs/Apps/Explanation.md`; the
//! mechanical mapping here:
//!
//!  - **System** ([`domain::SystemApp`], the `system_apps` payload) — an ordinary
//!    seeded row (its launch URL in `system_apps.url`); never user-editable.
//!  - **Self-hosted** ([`domain::SelfHostedApp`], the `self_hosted_apps` payload) —
//!    a migration-seeded row (protected) or a runtime upload through
//!    `POST /self-hosted-apps` (multipart; removable).
//!  - **Cloud** ([`domain::CloudApp`], the `cloud_apps` payload) — created /
//!    replaced / deleted through the `/cloud-apps` resource.
//!
//! Layered like `collector-rust`:
//!
//!  - [`domain`] — [`domain::AppRegistration`] (the diesel-mapped `app_registry`
//!    row AND the uniform `GET /apps` wire item), the per-kind detail types
//!    ([`domain::CloudApp`] / [`domain::SelfHostedApp`] / [`domain::SystemApp`],
//!    each a registration + its payload, projecting the per-kind editor wire
//!    shapes [`domain::CloudAppDetail`] etc.), the thin [`domain::App`] enum at the
//!    cross-kind seams (launch dispatch, delete), [`domain::AppKind`] (the
//!    discriminator), [`domain::AppError`] (the failure vocabulary), and
//!    [`domain::AppUrl`] (the write-side URL validator).
//!  - [`db`] — the `SQLite` store adapter ([`db::SqliteAppsStore`], the
//!    implementation of the [`domain::AppsStore`] port) over the app-wide diesel
//!    r2d2 pool (`persistence_rust::DieselPool`), migrated with embedded diesel
//!    migrations; the uniform list is a join-free registry read, a detail is the
//!    registration + one typed child payload read.
//!  - [`http`] — the slice's routers. `GET /apps` lists the registry in display
//!    order; `GET`/`POST /apps/{id}` dispatches the launch on the app's kind;
//!    `DELETE /apps/{id}` removes any kind; the per-kind `/cloud-apps` /
//!    `/self-hosted-apps` / `/system-apps` resources carry detail / create /
//!    replace; `PUT /home-screen` atomically reorders / enables any app.
//!
//! ## Launch / tunnel seam
//!
//! `POST /apps/{id}` resolves a launch target and dispatches on the *request's*
//! provenance (loopback vs. forwarded) — see the launch handler module. A
//! loopback launch is owner-gated through [`http::OwnerAuth`]. A
//! `requires_tunnel` (cloud) launch resolves through the shared
//! [`TunnelService`](shared_structures_rust::tunnel_service::TunnelService)
//! contract, keeping apps-rust decoupled from tunnel-rust.

pub mod config;
pub mod db;
pub mod domain;
pub mod http;
mod id;
mod install;
mod seed;
mod self_hosted_apps;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use shared_structures_rust::tunnel_service::TunnelService;

// The `AppsStore` port trait — in scope so `setup_apps` can call the store's
// `list_self_hosted_apps` read on the concrete adapter.
use crate::domain::AppsStore as _;

// Re-exported so the host can name the pool type at the `setup_apps` call site
// without a direct diesel dependency; the canonical home is persistence-rust.
pub use persistence_rust::DieselPool;

pub use config::AppsConfig;
pub use db::SqliteAppsStore;
pub use domain::{App, SelfHostedApp};
pub use http::{openapi_spec, AppsState, LaunchCookies, NoLaunchCookies, OwnerAuth};
// Re-exported for the integration test crate; `#[deprecated]` is intentional.
#[allow(deprecated)]
pub use http::StubOwnerAuth;
pub use seed::sync_vendored_self_hosted_apps;
pub use self_hosted_apps::SelfHostedAppsService;
pub use shared_structures_rust::OnDeviceWebviewHandle;

/// Result of [`setup_apps`]: the two routers a host mounts (gated + launch),
/// plus the shared state and the self-hosted catalogue.
///
/// The host wraps [`Self::gated_router`] with its bearer gate and mounts
/// [`Self::launch_router`] under only its network (loopback-peer) gate — the
/// launch handler owner-gates the loopback popup internally, while a forwarded
/// launch rides the front trust boundary (the bearer gate can't exempt the
/// parameterized launch path, so the two are split). [`Self::self_hosted_apps_at_start`]
/// is the catalogue the host iterates to bind a loopback listener per self-hosted
/// app at startup (both migration-seeded and previously-uploaded rows).
pub struct Apps {
    /// The owner-gated routes: `GET /apps`, `DELETE /apps/{id}`, `PUT /home-screen`,
    /// and the per-kind `/cloud-apps` / `/self-hosted-apps` / `/system-apps`
    /// resources. The host wraps this with its bearer gate.
    pub gated_router: Router,
    /// The launch routes `GET`/`POST /apps/{id}`, mounted ungated at the router
    /// level (network-gated by the host; owner-gated in-handler for loopback).
    pub launch_router: Router,
    /// Shared handler state (the store, the loopback base URL, the owner-auth
    /// gate, the tunnel, the on-device webview seam).
    pub state: Arc<AppsState>,
    /// The self-hosted catalogue the host binds loopback listeners for — whole
    /// [`App`]s of the [`App::SelfHosted`] variant.
    pub self_hosted_apps_at_start: Vec<App>,
}

impl Apps {
    /// The full apps surface (gated routes + launch) as one router. For tests and
    /// any host that mounts everything behind a single gate; the Tauri host
    /// instead mounts [`Self::gated_router`] and [`Self::launch_router`]
    /// separately so it can gate them differently.
    pub fn combined_router(&self) -> Router {
        self.gated_router.clone().merge(self.launch_router.clone())
    }
}

/// Build the apps router over the host-owned diesel connection `pool`, mirroring
/// `collector-rust`'s `setup_collector`. The host builds the app-wide diesel pool
/// (via `persistence_rust::open_pool`) on the same shared database file its
/// rusqlite connection serves the other slices from, and passes a clone in — along
/// with the `tunnel` service a `requires_tunnel` launch resolves its origin
/// through, the `owner_auth` gate the loopback launch uses, and the
/// `webview_handle` the on-device launch side-effect runs through.
///
/// `webview_handle` is the host seam for the on-device launch side-effect: a
/// loopback launch opens the resolved URL through it and `204`s. The Tauri host
/// passes a native-webview opener; a host with no native popup passes a no-op.
///
/// `self_hosted` is the same [`SelfHostedAppsService`] the host holds for the
/// process lifetime (both hold the `Arc`), so the upload/delete handlers bring
/// an app online / offline through the identical instance that binds the seed
/// listeners — and stage/remove files under its `apps_dir`.
///
/// `launch_cookies` is the host seam re-scoping the caller's owner session onto a
/// forwarded self-hosted app's public host (see [`LaunchCookies`]). The Tauri host
/// passes the gatekeeper cookie builder; others pass [`NoLaunchCookies`].
///
/// # Errors
///
/// Returns an error if the store can't be migrated.
pub fn setup_apps(
    pool: DieselPool,
    config: &AppsConfig,
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    owner_auth: Arc<dyn OwnerAuth>,
    self_hosted: Arc<SelfHostedAppsService>,
    launch_cookies: Arc<dyn LaunchCookies>,
) -> anyhow::Result<Apps> {
    // `SqliteAppsStore::new` runs the embedded migrations — building the
    // `app_registry` parent and its three child payload tables. The one store
    // serves them all.
    let store = SqliteAppsStore::new(pool).context("failed to open apps store")?;
    // Materialize the self-hosted catalogue once for the host to bind listeners
    // against — every self-hosted row, migration-seeded or previously uploaded.
    let self_hosted_apps = store
        .list_self_hosted_apps()
        .context("failed to list self-hosted apps")?;
    let state = Arc::new(AppsState::new(
        store,
        config.loopback_base_url.clone(),
        owner_auth,
        tunnel,
        webview_handle,
        self_hosted,
        launch_cookies,
    ));

    Ok(Apps {
        gated_router: http::gated_router(Arc::clone(&state)),
        launch_router: http::launch_router(Arc::clone(&state)),
        state,
        self_hosted_apps_at_start: self_hosted_apps,
    })
}
