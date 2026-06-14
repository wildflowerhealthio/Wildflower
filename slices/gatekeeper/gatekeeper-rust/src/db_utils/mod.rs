//! Gatekeeper's database layer. The generic, slice-agnostic primitives
//! (connection handle, migration runner, column newtypes, `sql_row!` macro,
//! insert-SQL builder) now live in the shared [`persistence_rust`] crate; this
//! module re-exports them so the existing `crate::db_utils::*` paths used across
//! `db/` and `domain/` keep resolving unchanged. What stays gatekeeper-specific
//! is the [`GatekeeperStore`] handle and the gatekeeper [`migrations`] list.

pub mod gatekeeper_store;
pub mod migrations;

// Re-export the shared persistence primitives under the historical
// `crate::db_utils::*` paths.
pub use persistence_rust::{sql_builder, Connection, DbResult, JsonColumn, UriColumn};
// `sql_row!` is `#[macro_export]`ed at the persistence crate root; re-export it
// here so `crate::db_utils::sql_row` still resolves in `db/`.
pub(crate) use persistence_rust::sql_row;

pub use gatekeeper_store::GatekeeperStore;
