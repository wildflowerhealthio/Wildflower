//! The capability bindings — where the port-only, scope-gated capabilities in
//! [`crate::domain::capabilities`] meet the concrete filesystem adapter and the
//! `Arc<DatabasesState>` router state. Each binding lives in its own file and
//! monomorphizes a generic domain capability over the concrete
//! [`FilesystemDatabaseFiles`](crate::adapters::FilesystemDatabaseFiles) adapter
//! (as a `Live…` type alias) and implements
//! [`Capability`](scope_capabilities_rust::Capability) for it, cloning the adapter
//! out of the state's [`files`](state::DatabasesState::files) field — so `domain/`
//! stays free of both `crate::http` and the concrete adapter type. [`state`] holds
//! the [`DatabasesState`](state::DatabasesState) the bindings build from. Mirrors
//! `collector-rust`'s `live_bindings/`.
//!
//! The handlers name these `Live…` aliases in `Scoped<…>` (e.g.
//! `Scoped<LiveDatabasesReader>`), never the bare generic domain capability.

mod databases_deleter;
mod databases_reader;

pub mod state;

pub(crate) use databases_deleter::LiveDatabasesDeleter;
pub(crate) use databases_reader::LiveDatabasesReader;
