//! The `FixedScopeCapability` bindings — where the generic, store-agnostic
//! capabilities in [`crate::domain::capabilities`] (which document the
//! fixed-scope flavour) meet the concrete [`SqliteAppsStore`](crate::db::SqliteAppsStore)
//! adapter, the [`SelfHostedAppsService`](crate::self_hosted_apps_service::SelfHostedAppsService)
//! installer, and the `Arc<AppsState>` router state. Each binding lives in its own
//! file and lifts the store + installer + the reserved loopback port out of the
//! state (it never hands the capability the whole state), so `domain/` stays free
//! of both `crate::http` and the concrete adapter types. The `Live…` type aliases
//! are what the `/apps` admin handlers name in `Scoped<…>`, and [`state`] holds the
//! [`AppsState`](state::AppsState) the bindings build from.
//!
//! The `Claims` type is the ready-made [`ScopeClaims`](scope_capabilities_rust::ScopeClaims)
//! the host's bearer gate (`gatekeeper_rust::layer_router_with_gatekeeper_auth_gating`)
//! inserts, so this slice scope-gates without depending on gatekeeper's domain
//! claims type.

mod app_launcher;
mod apps_creator;
mod apps_deleter;
mod apps_editor;
mod apps_reader;

pub(crate) use app_launcher::LiveAppLauncher;
pub(crate) use apps_creator::LiveAppsCreator;
pub(crate) use apps_deleter::LiveAppsDeleter;
pub(crate) use apps_editor::LiveAppsEditor;
pub(crate) use apps_reader::LiveAppsReader;
pub mod state;
