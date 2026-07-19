//! The capability bindings — where the generic, store-agnostic capabilities in
//! [`crate::domain::capabilities`] meet the concrete
//! [`SqliteAppsStore`](crate::db::SqliteAppsStore) adapter, the
//! [`SelfHostedAppsService`](crate::self_hosted_apps_service::SelfHostedAppsService)
//! installer, and the `Arc<AppsState>` router state. Each binding lives in its own
//! file and lifts the store + installer + the reserved loopback port (or, for the
//! launcher, the caller's grant + launch-scopes port) out of the state — it never
//! hands the capability the whole state — so `domain/` stays free of both
//! `crate::http` and the concrete adapter types. The `Live…` type aliases are what
//! the `/apps` handlers name in `Scoped<…>`, and [`state`] holds the
//! [`AppsState`](state::AppsState) the bindings build from.
//!
//! The four admin bindings implement
//! [`FixedScopeCapability`](scope_capabilities_rust::FixedScopeCapability); the
//! launch binding implements [`Capability`](scope_capabilities_rust::Capability)
//! directly (the **hybrid** flavour) so its builder can stash the caller's `Grant`
//! for the per-app SMART check while still declaring the static `wildflower/launch`
//! umbrella the `Scoped` extractor enforces before `build`.
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
