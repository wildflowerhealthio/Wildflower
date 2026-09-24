//! `apps-rust` — the host-side apps slice.
//!
//! A curated app registry with one wire surface. Storage is **one shared
//! registration + one per-kind configuration**: an authoritative
//! `app_registrations` table (the global id space, the shared catalogue facts, and
//! the homescreen placement) plus three per-kind configuration tables
//! (`system_app_configurations`, `cloud_app_configurations`,
//! `self_hosted_app_configurations`), real FKs configuration → registration with
//! `ON DELETE CASCADE`. The `kind` column names which configuration holds a
//! registration's payload; a whole app is a `(registration, configuration)` pair.
//! The taxonomy (System / Self-Hosted / Cloud) and its privacy model are canonical
//! in `docs/Apps/Explanation.md`; the mechanical mapping here:
//!
//!  - **System** ([`domain::SystemAppConfiguration`], the
//!    `system_app_configurations` payload) — an ordinary seeded row (its launch URL
//!    in `system_app_configurations.url`); never user-editable.
//!  - **Self-hosted** ([`domain::SelfHostedAppConfiguration`], the
//!    `self_hosted_app_configurations` payload) — a migration-seeded row (protected)
//!    or a runtime upload through `POST /self-hosted-apps` (multipart; removable).
//!  - **Cloud** ([`domain::CloudAppConfiguration`], the `cloud_app_configurations`
//!    payload) — created / replaced / deleted through the `/cloud-apps` resource.
//!
//! Layered like `collector-rust`:
//!
//!  - [`domain`] — [`domain::AppRegistration`] (the diesel-mapped
//!    `app_registrations` row AND the uniform `GET /apps` wire item), the per-kind
//!    configuration types ([`domain::CloudAppConfiguration`] /
//!    [`domain::SelfHostedAppConfiguration`] / [`domain::SystemAppConfiguration`],
//!    each its table's payload), the [`domain::AppConfiguration`] union a `find_app`
//!    read returns beside its registration (the cross-kind seams — launch dispatch,
//!    delete — operate on the `(registration, configuration)` pair directly, with no
//!    combined "app" type), [`domain::AppKind`] (the discriminator),
//!    [`domain::AppsError`] (the failure vocabulary), and [`domain::AppUrl`] (the
//!    write-side URL validator). The per-kind editor wire shapes live in
//!    `http::wire_representations`, built from the pair.
//!  - [`live_bindings`] — the router state ([`AppsState`](live_bindings::state::AppsState))
//!    at the crate root, and the per-capability `FixedScopeCapability` bindings
//!    that name the concrete store + installer; kept out of [`http`] so `domain/`
//!    can build capabilities from it without depending on the transport layer.
//!  - [`db`] — the `SQLite` store adapter ([`db::SqliteAppsStore`], the
//!    implementation of the [`domain::AppsStore`] port) over the app-wide diesel
//!    r2d2 pool (`persistence_rust::DieselPool`), migrated with embedded diesel
//!    migrations; the uniform list is a join-free registry read, a detail is the
//!    registration + one typed configuration read.
//!  - [`http`] — the slice's routers. `GET /apps` lists the registry in display
//!    order; `GET`/`POST /apps/{id}` dispatches the launch on the app's kind;
//!    `DELETE /apps/{id}` removes any kind; the per-kind `/cloud-apps` /
//!    `/self-hosted-apps` / `/system-apps` resources carry detail / create /
//!    replace; `PUT /home-screen` atomically reorders / enables any app.
//!
//! ## Launch / tunnel seam
//!
//! `POST /apps/{id}` resolves a launch target and dispatches on the *request's*
//! provenance (loopback vs. forwarded) — see the launch handler module. The launch
//! surface is scope-gated on the `wildflower/launch` umbrella (a SMART app
//! additionally requires the caller's grant to cover its client scopes). A
//! `requires_tunnel` (cloud) launch resolves through the shared
//! [`TunnelService`](shared_structures_rust::tunnel_service::TunnelService)
//! contract, keeping apps-rust decoupled from tunnel-rust.

pub mod config;
pub mod db;
// Debug builds only: the runtime seed for the `…-dev` rows that point at the
// first-party apps' vite dev servers. Gated here (not merely at the call site) so
// a release build contains no code that could write those ids — see the module
// docs for why they can't be a migration.
#[cfg(debug_assertions)]
mod dev_seed;
pub mod domain;
pub mod http;
mod id_utils;
mod install;
// The shared runtime state lives at the crate root (not under `http`) so the
// scope-gated `domain/` capabilities can be built from it (via the per-capability
// `FixedScopeCapability` bindings that live beside the state) without `domain/`
// depending on `crate::http`. Mirrors collector's / gatekeeper's `crate::live_bindings`
// layout.
pub(crate) mod live_bindings;
mod seed;
mod self_hosted_apps_service;

use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use shared_structures_rust::tunnel_service::TunnelService;

// Re-exported so the host can name the pool type at the `setup_apps` call site
// without a direct diesel dependency; the canonical home is persistence-rust.
pub use persistence_rust::DieselPool;

pub use config::AppsConfig;
pub use db::SqliteAppsStore;
// Re-exported so the host can name the self-hosted catalogue pair at the
// `setup_apps` call site, and read an app's configuration through the store
// (`AppsStore` + the `AppConfiguration` union) when adapting it to another
// slice's seam — e.g. gatekeeper's self-hosted redirect resolver. The
// `AppsStore` trait is also in scope here so `setup_apps` can call the store's
// `list_self_hosted_apps` read on the concrete adapter.
pub use domain::{AppConfiguration, AppRegistration, AppsStore, SelfHostedAppConfiguration};
pub use http::openapi_spec;
pub use live_bindings::state::AppsState;

#[cfg(debug_assertions)]
pub use dev_seed::seed_dev_apps;
pub use seed::sync_vendored_self_hosted_apps;
pub use self_hosted_apps_service::SelfHostedAppsService;
pub use shared_structures_rust::OnDeviceWebviewHandle;

pub mod ports;

use ports::AppLaunchScopes;

/// Result of [`setup_apps`]: the two routers a host mounts (gated + launch),
/// plus the shared state and the self-hosted catalogue.
///
/// The host wraps **both** [`Self::gated_router`] and [`Self::launch_router`] with
/// its bearer gate (the one that inserts the caller's scope claims): the admin
/// surface is gated on `wildflower/Apps.*` and the launch surface on the
/// `wildflower/launch` umbrella (plus a per-app SMART check in the handler), so the
/// two are kept separate only so the host can size the launch body limit / exempts
/// differently. [`Self::self_hosted_apps_at_start`] is the catalogue the host
/// iterates to bind a loopback listener per self-hosted app at startup (both
/// migration-seeded and previously-uploaded rows).
pub struct Apps {
    /// The admin routes: `GET /apps`, `DELETE /apps/{id}`, `PUT /home-screen`, and
    /// the per-kind `/cloud-apps` / `/self-hosted-apps` / `/system-apps` resources —
    /// each scope-gated on `wildflower/Apps.*`. The host wraps this with its bearer
    /// gate (which inserts the scope claims the `Scoped<…>` capabilities read).
    pub gated_router: Router,
    /// The launch routes `GET`/`POST /apps/{id}`, scope-gated on the
    /// `wildflower/launch` umbrella (plus the per-app SMART check). The host wraps
    /// this with the same bearer gate so the `Scoped<AppLauncher>` extractor has
    /// claims.
    pub launch_router: Router,
    /// Shared handler state (the store, the loopback base URL, the tunnel, the
    /// on-device webview seam, and the launch-scope port).
    pub state: Arc<AppsState>,
    /// The self-hosted catalogue the host binds loopback listeners for — each app's
    /// `(registration, configuration)` pair.
    pub self_hosted_apps_at_start: Vec<(AppRegistration, SelfHostedAppConfiguration)>,
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
/// through and the `webview_handle` the on-device launch side-effect runs through.
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
/// `launch_scopes` is the host seam resolving a SMART app's required launch scopes
/// for the per-app launch check (see [`AppLaunchScopes`]). The Tauri host passes a
/// gatekeeper-backed adapter; others pass [`NoAppLaunchScopes`](ports::NoAppLaunchScopes).
///
/// # Errors
///
/// Returns an error if the store can't be migrated.
pub fn setup_apps(
    pool: DieselPool,
    config: &AppsConfig,
    tunnel: Arc<dyn TunnelService>,
    webview_handle: Arc<dyn OnDeviceWebviewHandle>,
    self_hosted: Arc<SelfHostedAppsService>,
    launch_scopes: Arc<dyn AppLaunchScopes>,
) -> anyhow::Result<Apps> {
    // `SqliteAppsStore::new` runs the embedded migrations — building the
    // `app_registrations` table and its three configuration tables. The one store
    // serves them all.
    let store = SqliteAppsStore::new(pool).context("failed to open apps store")?;
    // Materialize the self-hosted catalogue once for the host to bind listeners
    // against — every self-hosted row, migration-seeded or previously uploaded, as
    // its `(registration, configuration)` pair.
    let self_hosted_apps = store
        .list_self_hosted_apps()
        .context("failed to list self-hosted apps")?;
    let state = Arc::new(AppsState::new(
        store,
        config.loopback_base_url.clone(),
        tunnel,
        webview_handle,
        self_hosted,
        launch_scopes,
    ));

    Ok(Apps {
        gated_router: http::gated_router(Arc::clone(&state)),
        launch_router: http::launch_router(Arc::clone(&state)),
        state,
        self_hosted_apps_at_start: self_hosted_apps,
    })
}
