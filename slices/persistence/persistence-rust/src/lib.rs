//! `persistence-rust` — common SQLite persistence utilities shared across Rust
//! slices.
//!
//! These are the generic, slice-agnostic pieces lifted out of
//! `gatekeeper-rust`'s `db_utils` so a second slice (the tunnel store) can
//! reuse them without copying. The split mirrors the TypeScript side's shared
//! slices: domain/db/utils stay separated, and each consuming slice keeps its
//! own named store + migration list on top of these primitives.
//!
//!  - [`Connection`] / [`DbResult`] — a clonable, mutex-synchronized rusqlite
//!    connection handle.
//!  - [`run_migrations`] — a tiny `PRAGMA user_version` migration runner.
//!  - [`JsonColumn`] / [`UriColumn`] — column newtypes with `FromSql`/`ToSql`.
//!  - [`sql_builder::build_insert_sql`] + the `sql_row!` macro — generate a
//!    table's `TryFrom<&Row>`, named-param array, and column list from one
//!    field list.

pub mod connection;
pub mod json_column;
pub mod sql_builder;
pub mod uri_column;

mod migrations;
// `sql_row!` is exported at the crate root via `#[macro_export]` (see
// `row_mapping`), so consumers reach it as `persistence_rust::sql_row`.
mod row_mapping;

pub use connection::{Connection, DbResult};
pub use json_column::JsonColumn;
pub use migrations::run_migrations;
pub use uri_column::UriColumn;
