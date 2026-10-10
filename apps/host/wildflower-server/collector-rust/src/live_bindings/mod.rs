//! The `FixedScopeCapability` bindings — where the generic, store-agnostic
//! capabilities in [`crate::domain::capabilities`] (which document the
//! fixed-scope flavour) meet the concrete [`SqliteRemotesStore`](crate::db::SqliteRemotesStore)
//! and the `Arc<CollectorState>` router state. Each binding lives in its own file
//! and lifts the store handle out of the state (it never hands the capability the
//! whole state), so `domain/` stays free of both `crate::http` and the concrete
//! adapter type. The `Live…` type aliases are what the `/collector/remotes`
//! handlers name in `Scoped<…>`, and [`state`] holds the [`CollectorState`](state::CollectorState)
//! the bindings build from.
//!
//! The `Claims` type is the ready-made [`ScopeClaims`](scope_capabilities_rust::ScopeClaims)
//! the host's bearer gate (`gatekeeper_rust::gatekeeper_auth_middleware`)
//! inserts, so this slice scope-gates without depending on gatekeeper's domain
//! claims type.

mod remotes_creator;
mod remotes_deleter;
mod remotes_editor;
mod remotes_reader;

pub(crate) use remotes_creator::LiveRemotesCreator;
pub(crate) use remotes_deleter::LiveRemotesDeleter;
pub(crate) use remotes_editor::LiveRemotesEditor;
pub(crate) use remotes_reader::LiveRemotesReader;
pub mod state;
